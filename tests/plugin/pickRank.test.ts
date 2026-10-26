/**
 * #324: typing a Korean name put items that only mention it in their
 * description first, so Enter picked the wrong unit operation.
 */
import { describe, it, expect } from 'vitest';
import type { PickItem } from '@labnoteo/core';
import { rankPickItems } from '../../src/modals';

const op = (id: string, name: string, ko: string, detail: string): PickItem<string> => ({
  label: `${id}: ${name}`,
  description: `${ko} · Hardware`,
  detail,
  keywords: [ko],
  value: id,
});

const ITEMS = [
  op('UHW060', 'Colony Picking', '콜로니 피킹', '액체 배양으로 옮길 콜로니를 고릅니다.'),
  op('UHW130', 'Sealing', '실링', 'PCR, 배양 전에 플레이트를 밀봉합니다.'),
  op('UHW180', 'Incubation', '배양', '정해진 온도에서 키웁니다.'),
  op('UHW190', 'Fermentation', '발효 배양', '발효조에서 키웁니다.'),
];

describe('rankPickItems', () => {
  it('puts an exact Korean name first, ahead of items only describing it', () => {
    expect(rankPickItems(ITEMS, '배양').map(i => i.value)).toEqual(['UHW180', 'UHW190', 'UHW060', 'UHW130']);
  });

  it('ranks a label word, then the label, ahead of descriptions', () => {
    expect(rankPickItems(ITEMS, 'incubation')[0].value).toBe('UHW180');
    expect(rankPickItems(ITEMS, 'uhw1').map(i => i.value)).toEqual(['UHW130', 'UHW180', 'UHW190']);
  });

  it('ranks an English description kept as a keyword with the detail', () => {
    const items: PickItem<string>[] = [
      { label: 'A: Plating', keywords: ['플레이팅', 'Spread cells on agar for culture'], value: 'A' },
      { label: 'B: Incubation', keywords: ['culture'], value: 'B' },
    ];
    expect(rankPickItems(items, 'culture').map(i => i.value)).toEqual(['B', 'A']);
  });

  it('keeps the given order for an empty query and drops what does not match', () => {
    expect(rankPickItems(ITEMS, '  ').map(i => i.value)).toEqual(['UHW060', 'UHW130', 'UHW180', 'UHW190']);
    expect(rankPickItems(ITEMS, '원심')).toEqual([]);
  });

  // #401: spaces left out, or words in another order, found nothing.
  it('finds a query typed without spaces or with its words reordered, last', () => {
    const items = [
      op('UHW100', 'Enzyme Activity Assay', '효소 활성 측정', ''),
      op('UHW200', 'Primer Design', '프라이머 설계', ''),
      op('USW300', 'Data Analysis', '데이터 분석', ''),
      op('UHW400', 'The Access Check', '접근 확인', ''),
    ];
    const found = (q: string) => rankPickItems(items, q).map(i => i.value);
    expect(found('효소활성')).toEqual(['UHW100']);
    expect(found('프라이머설계')).toEqual(['UHW200']);
    expect(found('데이터분석')).toEqual(['USW300']);
    expect(found('primerdesign')).toEqual(['UHW200']);
    expect(found('activity enzyme')).toEqual(['UHW100']);
    expect(found('측정 효소')).toEqual(['UHW100']);
    expect(found('eac')).toEqual([]);
  });

  it('keeps those matches after the ones found as typed', () => {
    const items = [
      op('UHW100', 'Enzyme Activity Assay', '효소 활성 측정', ''),
      op('UHW110', 'Enzymeactivity Prep', '효소활성 준비', ''),
    ];
    expect(rankPickItems(items, '효소활성').map(i => i.value)).toEqual(['UHW110', 'UHW100']);
  });
});
