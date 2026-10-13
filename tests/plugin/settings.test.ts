/**
 * `migrateSettings` guards the one input the plugin cannot control: whatever is
 * sitting in a user's `data.json` from an older release. These cases pin the
 * two behaviours that matter — garbage is rejected rather than copied through,
 * and the pre-schema `llmEndpoint` split lands on the right provider field.
 */
import { describe, it, expect } from 'vitest';
import { migrateSettings, DEFAULT_SETTINGS, CURRENT_SCHEMA_VERSION } from '../../src/settings';

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
