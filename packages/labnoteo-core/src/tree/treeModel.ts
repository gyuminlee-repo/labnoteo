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
import { sampleTypeColors } from '../lib/sampleUtils';

/** A node kind; mirrors the VS Code `contextValue`s used for menu wiring. */
export type TreeNodeKind =
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
  children?: TreeNode[];
  /** Kind-specific data the platform layer needs for actions. */
  payload?: unknown;
}

// ===========================================================================
// Workflow catalog tree (read-only)
// ===========================================================================

const DBTL_ORDER = ['Design', 'Build', 'Test', 'Learn', 'General'];

export interface WorkflowTreeData {
  workflows: WorkflowItem[];
  hwUnitOps: UnitOperationItem[];
  swUnitOps: UnitOperationItem[];
}

/** Build the 3-level workflow / unit-operation catalog tree. */
export function buildWorkflowTree(data: WorkflowTreeData): TreeNode[] {
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
        tooltip: wf.description || undefined,
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
        op.description +
        (op.equipment
          ? `\nEquipment: ${op.equipment}`
          : op.software
            ? `\nSoftware: ${op.software}`
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
  return details;
}

async function buildScopeNode(
  fs: LabnoteFs,
  scope: SampleScope,
  folder: string,
  types: readonly string[],
  skipRead = false
): Promise<TreeNode> {
  const typeNodes: TreeNode[] = [];
  for (const type of types) {
    const records = skipRead ? {} : await loadSamplesByType(fs, folder, type);
    const ids = Object.keys(records);
    const sampleNodes: TreeNode[] = ids.map(id => {
      const rec = records[id];
      const label = rec.alias ? `${id} | ${rec.alias}` : id;
      const nodeId = `sample:${scope}:${type}:${id}`;
      return {
        id: nodeId,
        label,
        kind: 'sample' as const,
        tooltip: rec.descriptions?.[0] || undefined,
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

/** Build the 4-level sample tree for both scopes. */
export async function buildSampleTree(
  fs: LabnoteFs,
  roots: SampleTreeRoots,
  types: readonly string[]
): Promise<TreeNode[]> {
  // With no experiment (or a vault-root note) the local folder is the global
  // one; list its samples once, under Global (#64).
  const sameFolder = isSameSampleFolder(roots.local, roots.global);
  return [
    await buildScopeNode(fs, 'local', roots.local, types, sameFolder),
    await buildScopeNode(fs, 'global', roots.global, types),
  ];
}

/** True when a `sample` node matches a lower-cased free-text query. */
function sampleMatchesQuery(node: TreeNode, lowerQuery: string): boolean {
  const payload = node.payload as { id?: string; record?: SampleRecord } | undefined;
  const rec = payload?.record;
  const haystack = [
    payload?.id ?? '',
    rec?.alias ?? '',
    rec?.descriptions?.[0] ?? '',
    rec?.location ?? '',
  ]
    .join('\u0000')
    .toLowerCase();
  return haystack.includes(lowerQuery);
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
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
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
