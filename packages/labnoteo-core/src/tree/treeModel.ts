/**
 * Platform-neutral tree model.
 *
 * Both the VS Code TreeDataProviders and the Obsidian sidebar `ItemView`s can
 * render the same {@link TreeNode}[] so that tree structure, label formatting
 * and sort order live in exactly one place. Platforms only map `TreeNode` to
 * their native widget (`TreeItem` / DOM).
 */
import type { LabnoteFs } from '../fs/labnoteFs';
import { loadSamplesByType, isSameSampleFolder, type SampleRecord } from '../lib/sampleStorage';
import {
  groupWorkflowsByCategory,
  type WorkflowItem,
  type UnitOperationItem,
} from '../lib/workflowDataLoader';
import { compareSamples, normalizeSampleSearch, sampleTypeColors } from '../lib/sampleUtils';
import { EXPERIMENT_STATUSES } from '../lib/experimentStatus';
import * as path from '../util/posixPath';

/** A node kind; mirrors the VS Code `contextValue`s used for menu wiring. */
export type TreeNodeKind =
  | 'experimentRoot'
  | 'experimentStatus'
  | 'experimentProject'
  | 'experimentAuthor'
  | 'experimentDiscuss'
  | 'experiment'
  | 'sampleRoot'
  | 'sampleType'
  | 'sample'
  | 'sampleDetail'
  | 'workflowRoot'
  | 'category'
  | 'workflow'
  | 'unitOpRoot'
  | 'unitOperation';

export interface TreeNode {
  /** Stable id, unique within its sibling list (used for collapse state). */
  id: string;
  label: string;
  kind: TreeNodeKind;
  icon?: string;
  color?: string;
  tooltip?: string;
  /** Shown faded, e.g. a discarded sample (#158). */
  dimmed?: boolean;
  children?: TreeNode[];
  /** Kind-specific data the platform layer needs for actions. */
  payload?: unknown;
}

// ===========================================================================
// Experiments of the vault, by status
// ===========================================================================

/** One experiment, read from its README's front matter. */
export interface ExperimentEntry {
  /** The `labnote/###_Name` folder. */
  folder: string;
  title?: string;
  status?: string;
  /** The README's `discuss` flag is on. */
  discuss?: boolean;
  /** The README's `last_updated_date`. */
  lastUpdated?: string;
  /** Checked and total entries of the README "Related Workflows" checklist (#157). */
  progress?: { done: number; total: number };
  /** The README's `project`: the larger project the experiment belongs to (#204). */
  project?: string;
  /** The README's `author`: who runs the experiment (#365). */
  author?: string;
  /** `@issue` markers in the experiment's notes (#337). */
  markers?: number;
  /** The folder of the experiment this one runs again, from the README's `retry_of` (#327). */
  retryOf?: string;
  /** The folders of the experiments that run this one again; see {@link linkRetries}. */
  retriedBy?: string[];
}

/** What {@link buildExperimentTree} groups experiments by (#204, #220). */
export type ExperimentGrouping = 'status' | 'project' | 'author' | 'discuss';

/** Labels {@link buildExperimentTree} puts into the tree; English defaults. */
export interface ExperimentTreeLabels {
  root?: string;
  noStatus?: string;
  /** Tooltip line of a flagged experiment (#220). */
  discuss?: string;
  /** Group of the experiments flagged for discussion or with `@issue` markers (#337). */
  discussGroup?: string;
  /** Group of the others (#220). */
  noDiscuss?: string;
  /** Tooltip line name for the `@issue` marker count (#337). */
  markers?: string;
  /** Tooltip line names for the experiment retried and those retrying it (#327). */
  retryOf?: string;
  retriedBy?: string;
  /** Suffix of a group whose status is outside {@link EXPERIMENT_STATUSES} (#143). */
  invalidStatus?: string;
  /** Tooltip of that group; `{0}` is the allowed list. */
  invalidStatusTooltip?: string;
  status?: string;
  workflows?: string;
  lastUpdated?: string;
  /** Tooltip line name for the README's `project` (#204). */
  project?: string;
  /** Group of experiments without a `project`. */
  noProject?: string;
  /** Tooltip line name for the README's `author` (#365). */
  author?: string;
  /** Group of experiments without an `author`. */
  noAuthor?: string;
}

/** `001` of `001_GFP`, or the whole name when it has no number. */
function experimentNumber(name: string): string {
  return /^(\d{3})_/.exec(name)?.[1] ?? name;
}

/** Whether an experiment has something to discuss: its flag, or an `@issue` marker (#337). */
function hasDiscussion(e: ExperimentEntry): boolean {
  return !!e.discuss || (e.markers ?? 0) > 0;
}

/**
 * `experiments` with each one's `retriedBy` filled from the others' `retryOf`
 * (#327), so the experiment that failed shows which runs followed it.
 */
export function linkRetries(experiments: readonly ExperimentEntry[]): ExperimentEntry[] {
  const by = new Map<string, string[]>();
  for (const e of experiments) {
    if (e.retryOf && e.retryOf !== e.folder) by.set(e.retryOf, [...(by.get(e.retryOf) ?? []), e.folder]);
  }
  return experiments.map(e => (by.has(e.folder) ? { ...e, retriedBy: by.get(e.folder) } : e));
}

/** The numbers of the experiments in `folders`, in folder order: `061, 103`. */
function experimentNumbers(folders: readonly string[]): string {
  return folders
    .map(f => path.basename(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(experimentNumber)
    .join(', ');
}

/**
 * The vault's experiments grouped by `status` (the default), in {@link EXPERIMENT_STATUSES}
 * order. Experiments without a status, and each value outside that list, get
 * groups of their own after those, marked as not allowed (#143); empty groups
 * are left out. Each experiment shows as `001 · title (done/total)` so the
 * title is not pushed out of a narrow sidebar by the folder name (#156), and
 * carries its folder and README path. The tooltip names the title, folder,
 * status, checklist progress and last update (#157). One flagged for
 * discussion gets a discussion icon and says so in its tooltip (#134).
 *
 * Grouped by `project` instead, the experiments of one project sit together
 * whatever their status, projects in name order and those without one last
 * (#204); grouped by `author`, likewise by the README's `author` (#365).
 * Grouped by `discuss`, the experiments with something to discuss
 * (flagged, or with `@issue` markers) come first and the rest after them
 * (#220, #337).
 */
export function buildExperimentTree(
  experiments: ExperimentEntry[],
  labels: ExperimentTreeLabels = {},
  groupBy: ExperimentGrouping = 'status'
): TreeNode {
  const noStatus = labels.noStatus ?? '(none)';
  const root = {
    id: 'experiments',
    label: `${labels.root ?? 'Experiments'} [${experiments.length}]`,
    kind: 'experimentRoot' as const,
    icon: 'beaker',
  };
  if (groupBy === 'project' || groupBy === 'author') {
    const byKey = new Map<string, ExperimentEntry[]>();
    for (const e of experiments) {
      const key = e[groupBy]?.trim() ?? '';
      byKey.set(key, [...(byKey.get(key) ?? []), e]);
    }
    const keys = [...byKey.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    if (byKey.has('')) keys.push('');
    const none = groupBy === 'project' ? (labels.noProject ?? '(no project)') : (labels.noAuthor ?? '(no author)');
    const kind = groupBy === 'project' ? ('experimentProject' as const) : ('experimentAuthor' as const);
    return {
      ...root,
      children: keys.map(key => {
        const members = sortByFolder(byKey.get(key)!);
        return {
          id: `${kind}:${key}`,
          label: `${key || none} [${members.length}]`,
          kind,
          icon: 'folder',
          payload: { [groupBy]: key || undefined },
          children: members.map(e => experimentNode(e, labels)),
        };
      }),
    };
  }

  if (groupBy === 'discuss') {
    const flagged = experiments.filter(hasDiscussion);
    const others = experiments.filter(e => !hasDiscussion(e));
    const group = (discuss: boolean, members: ExperimentEntry[], label: string): TreeNode => ({
      id: `experimentDiscuss:${discuss}`,
      label: `${label} [${members.length}]`,
      kind: 'experimentDiscuss',
      icon: discuss ? 'comment-discussion' : 'folder',
      payload: { discuss },
      children: sortByFolder(members).map(e => experimentNode(e, labels)),
    });
    return {
      ...root,
      children: [
        ...(flagged.length > 0 ? [group(true, flagged, labels.discussGroup ?? 'Something to discuss')] : []),
        ...(others.length > 0 ? [group(false, others, labels.noDiscuss ?? 'Nothing to discuss')] : []),
      ],
    };
  }

  const groups = new Map<string, ExperimentEntry[]>();
  for (const e of experiments) {
    const status = e.status?.trim() ?? '';
    groups.set(status, [...(groups.get(status) ?? []), e]);
  }
  const known = EXPERIMENT_STATUSES as readonly string[];
  const unknown = [...groups.keys()].filter(s => s && !known.includes(s)).sort((a, b) => a.localeCompare(b));
  const order = [...known, ...unknown, ''].filter(s => groups.has(s));

  return {
    ...root,
    children: order.map(status => {
      const members = sortByFolder(groups.get(status)!);
      const invalid = status !== '' && !known.includes(status);
      return {
        id: `experimentStatus:${status}`,
        label: invalid
          ? `${status} [${members.length}] ${labels.invalidStatus ?? '(not an allowed status)'}`
          : `${status || noStatus} [${members.length}]`,
        kind: 'experimentStatus' as const,
        icon: invalid ? 'warning' : 'folder',
        ...(invalid
          ? {
              tooltip: (labels.invalidStatusTooltip ?? 'Allowed statuses: {0}').replace(
                '{0}',
                EXPERIMENT_STATUSES.join(', ')
              ),
            }
          : {}),
        payload: { status: status || undefined },
        children: members.map(e => experimentNode(e, labels)),
      };
    }),
  };
}

function sortByFolder(entries: ExperimentEntry[]): ExperimentEntry[] {
  return [...entries].sort((a, b) =>
    path.basename(a.folder).localeCompare(path.basename(b.folder), undefined, { numeric: true })
  );
}

function experimentNode(e: ExperimentEntry, labels: ExperimentTreeLabels): TreeNode {
  const noStatus = labels.noStatus ?? '(none)';
  const status = e.status?.trim() ?? '';
  const project = e.project?.trim();
  const author = e.author?.trim();
  const name = path.basename(e.folder);
  const title = e.title?.trim();
  const named = title && title !== name ? `${experimentNumber(name)} · ${title}` : name;
  const progress = e.progress && e.progress.total > 0 ? ` (${e.progress.done}/${e.progress.total})` : '';
  const tooltip = [
    ...(title && title !== name ? [title] : []),
    e.folder,
    `${labels.status ?? 'Status'}: ${status || noStatus}`,
    ...(project ? [`${labels.project ?? 'Project'}: ${project}`] : []),
    ...(author ? [`${labels.author ?? 'Author'}: ${author}`] : []),
    ...(e.progress && e.progress.total > 0
      ? [`${labels.workflows ?? 'Workflows done'}: ${e.progress.done}/${e.progress.total}`]
      : []),
    ...(e.lastUpdated ? [`${labels.lastUpdated ?? 'Last updated'}: ${e.lastUpdated}`] : []),
    ...(e.retryOf ? [`${labels.retryOf ?? 'Retry of'}: ${experimentNumbers([e.retryOf])}`] : []),
    ...(e.retriedBy?.length ? [`${labels.retriedBy ?? 'Retried in'}: ${experimentNumbers(e.retriedBy)}`] : []),
    ...(e.discuss ? [labels.discuss ?? 'Flagged for discussion'] : []),
    ...(e.markers ? [`${labels.markers ?? '@issue markers'}: ${e.markers}`] : []),
  ].join('\n');
  return {
    id: `experiment:${e.folder}`,
    label: `${named}${progress}`,
    kind: 'experiment',
    icon: hasDiscussion(e) ? 'comment-discussion' : 'file',
    tooltip,
    payload: { folder: e.folder, readmePath: path.join(e.folder, 'README.labnote.md'), status: status || undefined },
  };
}

/**
 * The experiments whose folder name, title, project, author or status
 * contains every word of `query`, ignoring case (#204, #365). A blank query returns the input.
 * One with something to discuss also matches `discuss` and the words of
 * `discussLabel`, e.g. the UI's group name (#220, #337); a status also
 * matches its name in `statusWords`, e.g. 검토 필요 for `needs-review`
 * (#333); and a retry and the experiment it retries match each other's
 * number (#327).
 */
export function filterExperiments(
  experiments: ExperimentEntry[],
  query: string,
  discussLabel?: string,
  statusWords: Readonly<Record<string, string>> = {}
): ExperimentEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return experiments;
  return experiments.filter(e => {
    const status = e.status?.trim() ?? '';
    const haystack = [
      path.basename(e.folder),
      e.title ?? '',
      e.project ?? '',
      e.author ?? '',
      status,
      ...(Object.prototype.hasOwnProperty.call(statusWords, status) ? [statusWords[status]] : []),
      ...(hasDiscussion(e) ? ['discuss', discussLabel ?? ''] : []),
      experimentNumbers([...(e.retryOf ? [e.retryOf] : []), ...(e.retriedBy ?? [])]),
    ]
      .join('\u0000')
      .toLowerCase();
    return words.every(w => haystack.includes(w));
  });
}

// ===========================================================================
// Workflow catalog tree (read-only)
// ===========================================================================

const DBTL_ORDER = ['Design', 'Build', 'Test', 'Learn'];

export interface WorkflowTreeData {
  workflows: WorkflowItem[];
  hwUnitOps: UnitOperationItem[];
  swUnitOps: UnitOperationItem[];
}

/** How {@link buildWorkflowTree} words its tooltips, in the host's language. */
export interface WorkflowTreeLabels {
  /** The description to show for a catalog item; defaults to the item's own (#213). */
  describe?: (id: string, description: string) => string;
  equipment?: string;
  software?: string;
}

/** Build the 3-level workflow / unit-operation catalog tree. */
export function buildWorkflowTree(data: WorkflowTreeData, labels: WorkflowTreeLabels = {}): TreeNode[] {
  const describe = labels.describe ?? ((_id: string, description: string) => description);
  const grouped = groupWorkflowsByCategory(data.workflows);
  // Rank known DBTL categories by their fixed order; any unknown category (e.g.
  // "Uncategorized") gets a rank past the end so it sorts AFTER the known ones
  // rather than before "Design" (raw indexOf returns -1 for unknowns).
  const rank = (c: string): number => {
    const i = DBTL_ORDER.indexOf(c);
    return i === -1 ? DBTL_ORDER.length : i;
  };
  const categories = Object.keys(grouped).sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });

  const workflowRoot: TreeNode = {
    id: 'workflows',
    label: `Workflows [${data.workflows.length}]`,
    kind: 'workflowRoot',
    icon: 'symbol-class',
    children: categories.map(category => ({
      id: `category:${category}`,
      label: `${category} [${grouped[category].length}]`,
      kind: 'category' as const,
      icon: 'folder',
      children: grouped[category].map(wf => ({
        id: `workflow:${wf.id}`,
        label: `${wf.id}: ${wf.name}`,
        kind: 'workflow' as const,
        icon: 'file',
        tooltip: describe(wf.id, wf.description) || undefined,
        payload: wf,
      })),
    })),
  };

  const buildUnitOpRoot = (
    kind: 'hw' | 'sw',
    ops: UnitOperationItem[]
  ): TreeNode => ({
    id: `unitOps:${kind}`,
    label: `${kind === 'hw' ? 'HW' : 'SW'} Unit Operations [${ops.length}]`,
    kind: 'unitOpRoot',
    icon: 'symbol-method',
    payload: { opType: kind },
    children: ops.map(op => ({
      id: `unitOp:${op.id}`,
      label: `${op.id}: ${op.name}`,
      kind: 'unitOperation' as const,
      icon: 'symbol-function',
      tooltip:
        describe(op.id, op.description) +
        (op.equipment
          ? `\n${labels.equipment ?? 'Equipment'}: ${op.equipment}`
          : op.software
            ? `\n${labels.software ?? 'Software'}: ${op.software}`
            : ''),
      payload: { ...op, opType: kind },
    })),
  });

  return [
    workflowRoot,
    buildUnitOpRoot('hw', data.hwUnitOps),
    buildUnitOpRoot('sw', data.swUnitOps),
  ];
}

// ===========================================================================
// Sample tree (per-vault, disk-backed)
// ===========================================================================

export type SampleScope = 'local' | 'global';

export interface SampleTreeRoots {
  /** Absolute path to the document-local `resources/labsamples` folder. */
  local: string;
  /** Absolute path to the vault/workspace-global `resources/labsamples` folder. */
  global: string;
}

function sampleDetailNodes(idPrefix: string, rec: SampleRecord): TreeNode[] {
  const details: TreeNode[] = [];
  if (rec.alias) {
    details.push({
      id: `${idPrefix}:alias`,
      label: `alias: ${rec.alias}`,
      kind: 'sampleDetail',
    });
  }
  const description = rec.descriptions?.[0];
  if (description) {
    details.push({
      id: `${idPrefix}:description`,
      label: `description: ${description}`,
      kind: 'sampleDetail',
    });
  }
  if (rec.location) {
    details.push({
      id: `${idPrefix}:location`,
      label: `location: ${rec.location}`,
      kind: 'sampleDetail',
    });
  }
  if (rec.discarded) {
    details.push({
      id: `${idPrefix}:discarded`,
      label: `discarded: ${rec.discarded}`,
      kind: 'sampleDetail',
    });
  }
  return details;
}

async function buildScopeNode(
  fs: LabnoteFs,
  scope: SampleScope,
  folder: string,
  types: readonly string[],
  skipRead = false,
  labels: SampleTreeLabels = {}
): Promise<TreeNode> {
  const typeNodes: TreeNode[] = [];
  for (const type of types) {
    const records = skipRead ? {} : await loadSamplesByType(fs, folder, type);
    const ids = Object.keys(records).sort((a, b) =>
      compareSamples({ id: a, alias: records[a].alias }, { id: b, alias: records[b].alias })
    );
    const sampleNodes: TreeNode[] = ids.map(id => {
      const rec = records[id];
      const name = rec.alias ? `${id} | ${rec.alias}` : id;
      const label = rec.discarded ? `${name} ${labels.discarded ?? '(discarded)'}` : name;
      const nodeId = `sample:${scope}:${type}:${id}`;
      return {
        id: nodeId,
        label,
        kind: 'sample' as const,
        tooltip: rec.descriptions?.[0] || undefined,
        ...(rec.discarded ? { dimmed: true } : {}),
        payload: { scope, type, id, record: rec },
        children: sampleDetailNodes(nodeId, rec),
      };
    });

    typeNodes.push({
      id: `sampleType:${scope}:${type}`,
      label: `${type} [${ids.length}]`,
      kind: 'sampleType',
      icon: 'symbol-class',
      color: (sampleTypeColors as Record<string, string>)[type],
      payload: { scope, type },
      children:
        sampleNodes.length > 0
          ? sampleNodes
          : [
              {
                id: `sampleType:${scope}:${type}:empty`,
                label: 'No samples',
                kind: 'sampleDetail' as const,
              },
            ],
    });
  }

  return {
    id: `sampleRoot:${scope}`,
    label: scope === 'local' ? 'Samples (Local)' : 'Samples (Global)',
    kind: 'sampleRoot',
    // `sameFolder`: the Local root is the Global folder again, listed under Global (#111).
    payload: skipRead ? { scope, sameFolder: true } : { scope },
    children: typeNodes,
  };
}

/** Words {@link buildSampleTree} puts in labels, in the host's language. */
export interface SampleTreeLabels {
  /** Tag after a discarded sample's label (#158). Default `(discarded)`. */
  discarded?: string;
}

/** Build the 4-level sample tree for both scopes. */
export async function buildSampleTree(
  fs: LabnoteFs,
  roots: SampleTreeRoots,
  types: readonly string[],
  labels: SampleTreeLabels = {}
): Promise<TreeNode[]> {
  // With no experiment (or a vault-root note) the local folder is the global
  // one; list its samples once, under Global (#64).
  const sameFolder = isSameSampleFolder(roots.local, roots.global);
  return [
    await buildScopeNode(fs, 'local', roots.local, types, sameFolder, labels),
    await buildScopeNode(fs, 'global', roots.global, types, false, labels),
  ];
}

/** True when a `sample` node matches a query made by {@link normalizeSampleSearch}. */
function sampleMatchesQuery(node: TreeNode, query: string): boolean {
  const payload = node.payload as { id?: string; record?: SampleRecord } | undefined;
  const rec = payload?.record;
  return [payload?.id ?? '', rec?.alias ?? '', rec?.descriptions?.[0] ?? '', rec?.location ?? '']
    .map(normalizeSampleSearch)
    .join('\u0000')
    .includes(query);
}

/**
 * Filter a sample tree (from {@link buildSampleTree}) by a free-text query,
 * matching each sample's id, alias, description and location
 * (case-insensitive substring). Scope roots are preserved; a type node is kept
 * only when at least one sample under it matches, and its `[count]` label is
 * recomputed to the number of matches. An empty/whitespace query returns the
 * input unchanged (reference-equal), so callers can skip re-rendering work.
 */
export function filterSampleTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query.trim()) return nodes;
  const q = normalizeSampleSearch(query.trim());
  return nodes.map(root => {
    const typeNodes = (root.children ?? []).flatMap(typeNode => {
      const matches = (typeNode.children ?? []).filter(
        child => child.kind === 'sample' && sampleMatchesQuery(child, q)
      );
      if (matches.length === 0) return [] as TreeNode[];
      const type = (typeNode.payload as { type?: string } | undefined)?.type ?? typeNode.label;
      return [{ ...typeNode, label: `${type} [${matches.length}]`, children: matches }];
    });
    return { ...root, children: typeNodes };
  });
}
