/**
 * #38: note templates cite palette commands by name. Core cannot read the
 * plugin's Korean catalog, so it keeps its own copy of the Korean labels; this
 * pins that copy to the strings the palette actually shows.
 */
import { describe, it, expect } from 'vitest';
import obsidianKo from '../../src/l10n.ko';
import {
  KO_COMMAND_NAMES,
  generateReadmeContent,
} from '@labnoteo/core/lib/labnoteStructure';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';

describe('template command names match the Korean palette labels', () => {
  it('uses the l10n.ko labels for the commands the templates cite', () => {
    expect(KO_COMMAND_NAMES.createWorkflow).toBe(obsidianKo['Create workflow']);
    expect(KO_COMMAND_NAMES.insertUnitOperation).toBe(obsidianKo['Insert unit operation']);
    expect(KO_COMMAND_NAMES.syncWorkflowChecklist).toBe(obsidianKo['Sync workflow checklist with folder']);
  });

  it('puts those labels into notes created under a Korean UI', () => {
    const readme = generateReadmeContent('Assay', '', { locale: 'ko' });
    expect(readme).toContain(`\`${obsidianKo['Create workflow']}\``);

    const workflow = createWorkflowContent(
      { id: 'WD010', name: 'Design', description: 'desc' },
      'Dr. Kim',
      undefined,
      { locale: 'ko' }
    );
    expect(workflow).toContain(`\`${obsidianKo['Insert unit operation']}\``);
  });
});
