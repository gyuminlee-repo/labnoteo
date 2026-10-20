/**
 * Bundled workflow / unit-operation catalogs.
 *
 * These JSON files are the SINGLE SOURCE of the default catalogs. They are
 * inlined into both the VS Code extension bundle (esbuild) and the Obsidian
 * plugin bundle (esbuild), because Obsidian community plugins ship only
 * `main.js` / `manifest.json` / `styles.css` and cannot rely on loose files
 * on disk. The extension seeds an editable workspace copy from these
 * constants (see `ensureWorkflowResources`).
 *
 * Vault copies are seeded once and brought up to date only by "Update
 * catalogs", which tells an unedited field by its earlier bundled value. So
 * when a name or description here changes, add the old value to
 * `EARLIER_BUNDLED`, and add a new id to `ADDED_BUNDLED_IDS`
 * (`./earlierBundled`).
 */
import workflowsJson from './workflows_en.json';
import unitOperationsHwJson from './unitoperations_hw_en.json';
import unitOperationsSwJson from './unitoperations_sw_en.json';

export interface WorkflowItem {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface WorkflowJson {
  version: string;
  language: string;
  lastUpdated: string;
  workflows: WorkflowItem[];
}

export interface UnitOperationItem {
  id: string;
  name: string;
  description: string;
  equipment?: string; // HW unit operations
  software?: string; // SW unit operations
}

export interface UnitOperationJson {
  version: string;
  language: string;
  lastUpdated: string;
  unitOperations: UnitOperationItem[];
}

export const WORKFLOWS_CATALOG: WorkflowJson = workflowsJson as WorkflowJson;
export const UNIT_OPERATIONS_HW_CATALOG: UnitOperationJson = unitOperationsHwJson as UnitOperationJson;
export const UNIT_OPERATIONS_SW_CATALOG: UnitOperationJson = unitOperationsSwJson as UnitOperationJson;

/** Catalog file names as they are seeded into `resources/workflows/`. */
export const CATALOG_FILE_NAMES = {
  workflows: 'workflows_en.json',
  unitOperationsHw: 'unitoperations_hw_en.json',
  unitOperationsSw: 'unitoperations_sw_en.json',
} as const;
