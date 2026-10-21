/**
 * `migrateSettings` guards the one input the plugin cannot control: whatever is
 * sitting in a user's `data.json` from an older release. These cases pin the
 * two behaviours that matter — garbage is rejected rather than copied through,
 * and the pre-schema `llmEndpoint` split lands on the right provider field.
 */
import { describe, it, expect } from 'vitest';
import {
  countSampleRecords,
  migrateSettings,
  partitionCustomSampleTypes,
  removedCustomSampleTypes,
  DEFAULT_SETTINGS,
  CURRENT_SCHEMA_VERSION,
} from '../../src/settings';

// #81: the field must not accept a type that `@` autocompletion cannot read.
describe('partitionCustomSampleTypes', () => {
  it('saves letters, digits and _ (Korean included) and rejects spaces and -', () => {
    expect(partitionCustomSampleTypes('Cell Line, Strain-A, 배지, Cell_2', [])).toEqual({
      save: ['배지', 'Cell_2'],
      rejected: [
        { name: 'Cell Line', suggestion: 'Cell_Line' },
        { name: 'Strain-A', suggestion: 'Strain_A' },
      ],
      legacyInvalid: [],
      caseDuplicates: [],
      legacyCaseDuplicates: [],
    });
  });

  it('rejects the autocomplete keywords sample and item', () => {
    expect(partitionCustomSampleTypes('Sample, item', []).save).toEqual([]);
  });

  it('keeps an invalid name stored by an older release, so its samples stay linked', () => {
    const out = partitionCustomSampleTypes('Cell Line, Strain-A', ['Cell Line']);
    expect(out.save).toEqual(['Cell Line']);
    expect(out.legacyInvalid).toEqual(['Cell Line']);
    expect(out.rejected.map(r => r.name)).toEqual(['Strain-A']);
  });

  // #222: Windows opens dna.json and DNA.json as one file.
  it('rejects a name that differs from a built-in or an earlier type only in case', () => {
    const out = partitionCustomSampleTypes('Strain, dna, strain, 배지', []);
    expect(out.save).toEqual(['Strain', '배지']);
    expect(out.caseDuplicates).toEqual([
      { name: 'dna', clashesWith: 'DNA' },
      { name: 'strain', clashesWith: 'Strain' },
    ]);
  });

  it('keeps a case duplicate stored before, so its samples stay linked, and reports it', () => {
    const out = partitionCustomSampleTypes('Strain, dna, strain', ['Strain', 'dna', 'strain']);
    expect(out.save).toEqual(['Strain', 'dna', 'strain']);
    expect(out.caseDuplicates).toEqual([]);
    expect(out.legacyCaseDuplicates).toEqual([
      { name: 'dna', clashesWith: 'DNA' },
      { name: 'strain', clashesWith: 'Strain' },
    ]);
  });
});

// #137: samples of a type taken out of the list stop showing.
describe('removedCustomSampleTypes / countSampleRecords', () => {
  it('lists the types the new list dropped', () => {
    expect(removedCustomSampleTypes(['CellLine', 'Strain', '배지'], ['Strain'])).toEqual(['CellLine', '배지']);
    expect(removedCustomSampleTypes(['CellLine'], ['CellLine', 'Media'])).toEqual([]);
  });

  it('ignores a change of case and built-in names, which still show', () => {
    expect(removedCustomSampleTypes(['CellLine', 'dna'], ['cellline'])).toEqual([]);
  });

  it('counts the samples in the type files, skipping empty and broken ones', () => {
    const json = JSON.stringify({ 'CellLine-1': { alias: 'HeLa' }, 'CellLine-2': { alias: null } });
    expect(countSampleRecords([json, JSON.stringify({ 'CellLine-3': {} }), '', '{broken', '[]'])).toBe(3);
    expect(countSampleRecords([])).toBe(0);
  });
});

describe('migrateSettings', () => {
  it('returns the defaults for a missing or non-object blob', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps well-typed values', () => {
    const out = migrateSettings({
      sampleTracking: false,
      customSampleTypes: ['Antibody'],
      globalSampleFolder: 'custom/samples',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'sk-test',
      mcpEnabled: true,
    });
    expect(out.sampleTracking).toBe(false);
    expect(out.customSampleTypes).toEqual(['Antibody']);
    expect(out.globalSampleFolder).toBe('custom/samples');
    expect(out.llmProvider).toBe('openai');
    expect(out.llmModel).toBe('gpt-4o-mini');
    expect(out.llmApiKey).toBe('sk-test');
    expect(out.mcpEnabled).toBe(true);
  });

  it('falls back to the default for a wrongly-typed value', () => {
    const out = migrateSettings({
      sampleTracking: 'yes',
      globalSampleFolder: 123,
      llmModel: null,
      mcpEnabled: 1,
    });
    expect(out.sampleTracking).toBe(DEFAULT_SETTINGS.sampleTracking);
    expect(out.globalSampleFolder).toBe(DEFAULT_SETTINGS.globalSampleFolder);
    expect(out.llmModel).toBe(DEFAULT_SETTINGS.llmModel);
    expect(out.mcpEnabled).toBe(DEFAULT_SETTINGS.mcpEnabled);
  });

  // #204
  it('keeps the workflow view grouping and defaults to status', () => {
    expect(migrateSettings({}).workflowViewGroupBy).toBe('status');
    expect(migrateSettings({ workflowViewGroupBy: 'project' }).workflowViewGroupBy).toBe('project');
    expect(migrateSettings({ workflowViewGroupBy: 'discuss' }).workflowViewGroupBy).toBe('discuss');
    expect(migrateSettings({ workflowViewGroupBy: 'owner' }).workflowViewGroupBy).toBe('status');
  });

  it('keeps the catalog notice hash only when it is a string', () => {
    expect(migrateSettings({}).catalogNoticeHash).toBe('');
    expect(migrateSettings({ catalogNoticeHash: 'abc123' }).catalogNoticeHash).toBe('abc123');
    expect(migrateSettings({ catalogNoticeHash: 42 }).catalogNoticeHash).toBe('');
  });

  it('defaults autoUpdateLastUpdated to on and keeps a stored boolean', () => {
    expect(migrateSettings({}).autoUpdateLastUpdated).toBe(true);
    expect(migrateSettings({ autoUpdateLastUpdated: false }).autoUpdateLastUpdated).toBe(false);
    expect(migrateSettings({ autoUpdateLastUpdated: 'no' }).autoUpdateLastUpdated).toBe(true);
  });

  // #43: the MCP token survives restarts, but only in the shape we generate.
  it('keeps a well-formed MCP token and drops anything else', () => {
    const token = 'a1'.repeat(24);
    expect(migrateSettings({ mcpToken: token }).mcpToken).toBe(token);
    expect(migrateSettings({}).mcpToken).toBe('');
    expect(migrateSettings({ mcpToken: 'short' }).mcpToken).toBe('');
    expect(migrateSettings({ mcpToken: 'A1'.repeat(24) }).mcpToken).toBe('');
    expect(migrateSettings({ mcpToken: 42 }).mcpToken).toBe('');
  });

  it('keeps in-range scan settings and falls back otherwise', () => {
    expect(migrateSettings({})).toMatchObject({ scanMaxImageEdge: 2400, scanJpegQuality: 0.85, worksheetPaperSize: 'a4' });
    expect(migrateSettings({ scanMaxImageEdge: 3200.4, scanJpegQuality: 0.7, worksheetPaperSize: 'letter' }))
      .toMatchObject({ scanMaxImageEdge: 3200, scanJpegQuality: 0.7, worksheetPaperSize: 'letter' });
    expect(migrateSettings({ scanMaxImageEdge: 100, scanJpegQuality: 2, worksheetPaperSize: 'a3' }))
      .toMatchObject({ scanMaxImageEdge: 2400, scanJpegQuality: 0.85, worksheetPaperSize: 'a4' });
  });

  it('keeps the scan embed width when in range or zero and falls back otherwise', () => {
    expect(migrateSettings({}).scanEmbedWidth).toBe(200);
    expect(migrateSettings({ scanEmbedWidth: 480.4 }).scanEmbedWidth).toBe(480);
    expect(migrateSettings({ scanEmbedWidth: 0 }).scanEmbedWidth).toBe(0);
    expect(migrateSettings({ scanEmbedWidth: 50 }).scanEmbedWidth).toBe(200);
    expect(migrateSettings({ scanEmbedWidth: 5000 }).scanEmbedWidth).toBe(200);
  });

  it('moves the 300 px width saved by schema 1 to the new default, but keeps a later choice', () => {
    expect(migrateSettings({ schemaVersion: 1, scanEmbedWidth: 300 }).scanEmbedWidth).toBe(200);
    expect(migrateSettings({ schemaVersion: 2, scanEmbedWidth: 300 }).scanEmbedWidth).toBe(300);
    expect(migrateSettings({ schemaVersion: 1, scanEmbedWidth: 480 }).scanEmbedWidth).toBe(480);
  });

  it('rejects an unknown provider rather than trusting the string', () => {
    expect(migrateSettings({ llmProvider: 'anthropic' }).llmProvider).toBe('none');
  });

  it('drops non-string entries from customSampleTypes', () => {
    expect(migrateSettings({ customSampleTypes: ['DNA', 7, null, 'RNA'] }).customSampleTypes).toEqual(
      ['DNA', 'RNA']
    );
  });

  it('drops unknown keys instead of copying them through', () => {
    const out = migrateSettings({ someStaleKey: 'x' }) as unknown as Record<string, unknown>;
    expect(out.someStaleKey).toBeUndefined();
  });

  it('always stamps the current schema version', () => {
    expect(migrateSettings({ schemaVersion: 0 }).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateSettings({ schemaVersion: 999 }).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  describe('legacy llmEndpoint migration', () => {
    it('lands on the Ollama field when that provider was active', () => {
      const out = migrateSettings({ llmProvider: 'ollama', llmEndpoint: 'http://box:11434' });
      expect(out.llmEndpointOllama).toBe('http://box:11434');
      expect(out.llmEndpointOpenai).toBe(DEFAULT_SETTINGS.llmEndpointOpenai);
    });

    it('lands on the OpenAI field when that provider was active', () => {
      const out = migrateSettings({ llmProvider: 'openai', llmEndpoint: 'https://proxy.example' });
      expect(out.llmEndpointOpenai).toBe('https://proxy.example');
      expect(out.llmEndpointOllama).toBe(DEFAULT_SETTINGS.llmEndpointOllama);
    });

    it('defaults to Ollama, which was the pre-split default', () => {
      expect(migrateSettings({ llmEndpoint: 'http://box:11434' }).llmEndpointOllama).toBe(
        'http://box:11434'
      );
    });

    it('is ignored once either new field is present', () => {
      const out = migrateSettings({
        llmProvider: 'ollama',
        llmEndpoint: 'http://stale:11434',
        llmEndpointOllama: 'http://current:11434',
      });
      expect(out.llmEndpointOllama).toBe('http://current:11434');
    });

    it('ignores an empty legacy endpoint', () => {
      expect(migrateSettings({ llmEndpoint: '' }).llmEndpointOllama).toBe(
        DEFAULT_SETTINGS.llmEndpointOllama
      );
    });
  });
});
