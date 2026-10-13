/**
 * Unit Operation Template Helpers
 *
 * Centralised builders for the default body of a Unit Operation block.
 *
 * These templates are **written to disk** as part of `.labnote.md` files, so
 * the content is intentionally fixed in English regardless of the user's
 * VS Code language. Localising on the fly would cause the same workflow file
 * to appear differently for different locales, which would break parity
 * between collaborators sharing the same notebook.
 *
 * Two output shapes are provided:
 *   1. `buildSwUnitOpSections` / `buildHwUnitOpSections` — `{ heading, content }`
 *      pairs consumed by the Section Editor (`sectionEditorProvider`).
 *   2. `buildSwUnitOpMarkdown` / `buildHwUnitOpMarkdown` — fully rendered
 *      markdown blocks appended at the end of a workflow file by the
 *      "Add Unit Operation" / "Insert Unit Operation" commands.
 */

export interface UnitOpSection {
  heading: string;
  content: string;
}

export interface UnitOpMeta {
  experimenter: string;
  dateTime: string;
  /** Optional `Software: ...` line for SW unit ops. Empty string emits `- Software:` (no value). */
  software?: string;
  /** Optional `Equipment: ...` line for HW unit ops. Omitted when empty/undefined. */
  equipment?: string;
}

export const SW_PLACEHOLDERS = {
  Input: '- (artifacts/data/models from the previous step)',
  Output: '- (artifacts to pass to the next step: files, datasets, models)',
  Parameters: '- (options, hyperparameters, seed)',
  'QC Metrics': '- (performance metrics, QC indicators)',
  Method: '- (software/model + natural-language description)',
  Environment: '- (conda / poetry / container / OS / HW)',
  Discussion: '- (comments for the next step)',
} as const;

export const HW_PLACEHOLDERS = {
  Input: '- (samples from the previous step)',
  Reagent: '- (e.g. enzyme, buffer, etc.)',
  'Labware and Consumables': '- (e.g. plate, filter, tip, tube, etc.)',
  Equipment: '- (e.g. centrifuge, spectrophotometer, etc.)',
  Method: '- (method used in this step)',
  Output: '- (samples to the next step)',
  'Results & Discussions': '- (Any results and discussions. Link file path if needed)',
} as const;

function buildSwMetaContent(meta: UnitOpMeta): string {
  const softwareLine = meta.software ? `\n- Software: ${meta.software}` : '\n- Software:';
  return `- Experimenter: ${meta.experimenter}\n- Start_date: '${meta.dateTime}'\n- End_date: ''${softwareLine}`;
}

function buildHwMetaContent(meta: UnitOpMeta): string {
  const base = `- Experimenter: ${meta.experimenter}\n- Start_date: '${meta.dateTime}'\n- End_date: ''`;
  return meta.equipment ? `${base}\n- Equipment: ${meta.equipment}` : base;
}

/**
 * Build the section array for a Software Unit Operation, used by the
 * Section Editor when appending a new unit op object to the document model.
 */
export function buildSwUnitOpSections(meta: UnitOpMeta): UnitOpSection[] {
  return [
    { heading: 'Meta', content: buildSwMetaContent(meta) },
    { heading: 'Input', content: SW_PLACEHOLDERS.Input },
    { heading: 'Output', content: SW_PLACEHOLDERS.Output },
    { heading: 'Parameters', content: SW_PLACEHOLDERS.Parameters },
    { heading: 'QC Metrics', content: SW_PLACEHOLDERS['QC Metrics'] },
    { heading: 'Method', content: SW_PLACEHOLDERS.Method },
    { heading: 'Environment', content: SW_PLACEHOLDERS.Environment },
    { heading: 'Discussion', content: SW_PLACEHOLDERS.Discussion },
  ];
}

/**
 * Build the section array for a Hardware (lab) Unit Operation.
 */
export function buildHwUnitOpSections(meta: UnitOpMeta): UnitOpSection[] {
  return [
    { heading: 'Meta', content: buildHwMetaContent(meta) },
    { heading: 'Input', content: HW_PLACEHOLDERS.Input },
    { heading: 'Reagent', content: HW_PLACEHOLDERS.Reagent },
    { heading: 'Labware and Consumables', content: HW_PLACEHOLDERS['Labware and Consumables'] },
    { heading: 'Equipment', content: HW_PLACEHOLDERS.Equipment },
    { heading: 'Method', content: HW_PLACEHOLDERS.Method },
    { heading: 'Output', content: HW_PLACEHOLDERS.Output },
    { heading: 'Results & Discussions', content: HW_PLACEHOLDERS['Results & Discussions'] },
  ];
}

export interface UnitOpMarkdownInfo {
  opId: string;
  opName: string;
  opDescription: string;
  /** Extra suffix appended after the heading name (e.g. user-typed description). Already includes leading space if provided. */
  descriptionExtra?: string;
}

/**
 * Render a complete Software Unit Operation block as markdown text, ready to
 * be appended at the end of a workflow file. Used by the "Add Unit Operation"
 * and "Insert Unit Operation" commands which write directly to the buffer.
 */
export function buildSwUnitOpMarkdown(info: UnitOpMarkdownInfo, meta: UnitOpMeta): string {
  const softwareLine = meta.software ? `- Software: ${meta.software}` : '- Software:';
  const headingExtra = info.descriptionExtra ?? '';
  return `

---

### [${info.opId} ${info.opName}]${headingExtra}

> ${info.opDescription}

#### Meta
- Experimenter: ${meta.experimenter}
- Start_date: '${meta.dateTime}'
- End_date: ''
${softwareLine}

#### Input
${SW_PLACEHOLDERS.Input}

#### Output
${SW_PLACEHOLDERS.Output}

#### Parameters
${SW_PLACEHOLDERS.Parameters}

#### QC Metrics
${SW_PLACEHOLDERS['QC Metrics']}

#### Method
${SW_PLACEHOLDERS.Method}

#### Environment
${SW_PLACEHOLDERS.Environment}

#### Discussion
${SW_PLACEHOLDERS.Discussion}

`;
}

/**
 * Render a complete Hardware (lab) Unit Operation block as markdown text,
 * with the same role as `buildSwUnitOpMarkdown` for non-software steps.
 */
export function buildHwUnitOpMarkdown(info: UnitOpMarkdownInfo, meta: UnitOpMeta): string {
  const equipmentLine = meta.equipment ? `- Equipment: ${meta.equipment}\n` : '';
  const headingExtra = info.descriptionExtra ?? '';
  return `

---

### [${info.opId} ${info.opName}]${headingExtra}

> ${info.opDescription}

#### Meta
- Experimenter: ${meta.experimenter}
- Start_date: '${meta.dateTime}'
- End_date: ''
${equipmentLine}
#### Input
${HW_PLACEHOLDERS.Input}

#### Reagent
${HW_PLACEHOLDERS.Reagent}

#### Labware and Consumables
${HW_PLACEHOLDERS['Labware and Consumables']}

#### Equipment
${HW_PLACEHOLDERS.Equipment}

#### Method
${HW_PLACEHOLDERS.Method}

#### Output
${HW_PLACEHOLDERS.Output}

#### Results & Discussions
${HW_PLACEHOLDERS['Results & Discussions']}

`;
}
