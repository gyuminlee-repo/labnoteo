/**
 * #61: the model returned `{"type":"Equip","id":"ND-11"}` for a NanoDrop and
 * the id was saved as given. Extracted samples are now fitted to the sample
 * rules before `create_sample` sees them.
 */
import { describe, it, expect } from 'vitest';
import { prepareExtractedSamples } from '../../src/llm/commands';

const TYPES = ['DNA', 'Plasmid', 'Equip', '배지'];

describe('prepareExtractedSamples', () => {
  it('keeps valid ids, spelling type and prefix like the known type', () => {
    expect(prepareExtractedSamples([{ type: 'equip', id: 'equip-3', alias: 'NanoDrop' }], TYPES)).toEqual({
      samples: [{ type: 'Equip', id: 'Equip-3', alias: 'NanoDrop', description: undefined }],
      regenerated: 0,
      unknownType: 0,
    });
  });

  it('drops an id that breaks <Type>-<number>, keeping it as the alias when there is none', () => {
    const out = prepareExtractedSamples(
      [
        { type: 'Equip', id: 'ND-11', description: 'spectrophotometer' },
        { type: 'Plasmid', id: 'pUC19', alias: 'cloning vector' },
      ],
      TYPES
    );
    expect(out.samples).toEqual([
      { type: 'Equip', alias: 'ND-11', description: 'spectrophotometer' },
      { type: 'Plasmid', alias: 'cloning vector', description: undefined },
    ]);
    expect(out.regenerated).toBe(2);
  });

  it('replaces the characters that would split a sample in a note (#98)', () => {
    const out = prepareExtractedSamples(
      [
        { type: 'DNA', id: 'DNA-1', alias: 'EXT-01;여름', description: '여름 추출; 2차' },
        { type: 'DNA', id: 'ratio:1', description: '희석 1:10' },
      ],
      TYPES
    );
    expect(out.samples).toEqual([
      { type: 'DNA', id: 'DNA-1', alias: 'EXT-01-여름', description: '여름 추출, 2차' },
      { type: 'DNA', alias: 'ratio-1', description: '희석 1:10' },
    ]);
  });

  it('skips unknown types and accepts custom ones', () => {
    const out = prepareExtractedSamples([{ type: 'Gizmo' }, { type: '배지', id: '배지-1' }], TYPES);
    expect(out.samples).toEqual([{ type: '배지', id: '배지-1', alias: undefined, description: undefined }]);
    expect(out.unknownType).toBe(1);
  });

  it('leaves the id out when the model gave none', () => {
    expect(prepareExtractedSamples([{ type: 'DNA', alias: 'insert' }], TYPES).samples).toEqual([
      { type: 'DNA', id: undefined, alias: 'insert', description: undefined },
    ]);
  });
});
