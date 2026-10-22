import { describe, it, expect } from 'vitest';
import { createWorkflowContent } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../../packages/labnoteo-core/src/lib/unitOpTemplate';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '../../packages/labnoteo-core/src/sections/workflowSectionParser';
import { listWorksheetUnitOps, paginateWorksheet } from '../../packages/labnoteo-core/src/lib/worksheet';
import { decodeScanPayload } from '../../packages/labnoteo-core/src/lib/scanPayload';
import { buildPrintHtml, escapeHtml, type PrintPage } from '../../src/print/printPages';
import { plainInline, worksheetPrintPages } from '../../src/print/worksheetPrint';
import { sliceIntoPages, type MeasuredBlock } from '../../src/print/fullNotePrint';

describe('buildPrintHtml', () => {
  const page = (over: Partial<PrintPage> = {}): PrintPage => ({
    payload: 'LN1:LN-7K3M9QX2:1:UHW010:1/1:261015',
    label: 'LN-7K3M9QX2 · UHW010 · 1/1',
    header: 'H',
    body: 'B',
    footer: 'F',
    ...over,
  });

  it('puts the same QR code in two corners of every page, at the paper size', () => {
    const html = buildPrintHtml('Note <1>', 'letter', [page(), page({ label: 'second' })]);
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    expect(html.match(/<div class="qr tr"><svg/g)).toHaveLength(2);
    expect(html.match(/<div class="qr bl"><svg/g)).toHaveLength(2);
    expect(html).toContain('@page { size: 215.9mm 279.4mm;');
    expect(html).toContain('<title>Note &lt;1&gt;</title>');
  });

  it('escapes note text', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
});

describe('worksheetPrintPages', () => {
  /** The printed body of a lab unit operation whose Markdown `edit` has rewritten. */
  function worksheetBody(edit: (md: string) => string): string {
    let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, {
      noteId: 'LN-7K3M9QX2',
    });
    const block = buildHwUnitOpMarkdown(
      { opId: 'UHW090', opName: 'Electroporation', opDescription: 'step' },
      { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
    const pages = paginateWorksheet(listWorksheetUnitOps(edit(md)));
    return worksheetPrintPages(pages, {
      noteTitle: 'Note',
      noteId: 'LN-7K3M9QX2',
      printedOn: '2026-10-15',
      t: (s: string, ...args: Array<string | number | boolean>) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s),
    })
      .map(p => p.body)
      .join('');
  }

  it('gives every page a QR naming the note, unit operation and page, and escapes note text', () => {
    let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, {
      noteId: 'LN-7K3M9QX2',
    });
    const block = buildHwUnitOpMarkdown(
      { opId: 'UHW010', opName: 'Liquid <Handling>', opDescription: 'step' },
      { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
    const pages = paginateWorksheet(listWorksheetUnitOps(md));
    const printed = worksheetPrintPages(pages, {
      noteTitle: 'A & B',
      noteId: 'LN-7K3M9QX2',
      printedOn: '2026-10-15',
      t: (s: string, ...args: Array<string | number | boolean>) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s),
    });
    expect(printed).toHaveLength(pages.length);
    printed.forEach((p, i) => {
      expect(decodeScanPayload(p.payload)).toEqual({
        noteId: 'LN-7K3M9QX2',
        unitOpIndex: 1,
        opId: 'UHW010',
        page: i + 1,
        pageCount: pages.length,
        printedOn: '2026-10-15',
      });
      expect(p.header).toContain('A &amp; B');
      expect(p.header).not.toContain('<Handling>');
    });
    expect(printed[0].header).toContain('Liquid &lt;Handling&gt;');
    expect(printed[0].body).toContain('<div class="sec"><h3>Reagent</h3></div>');
    expect(printed.map(p => p.body).join('')).not.toContain('ruled');
  });

  it('prints what is nested under a step below it and a step\'s table as a table (#254)', () => {
    const body = worksheetBody(md =>
      md.replace(
        '#### Method\n- (method used in this step)',
        [
          '#### Method',
          '1. 컴피턴트 세포 준비',
          '    - 얼음 위 10분',
          '2. 전기천공 조건',
          '',
          '| 전압 | 큐벳 |',
          '| --- | --- |',
          '| 1.8 kV | 1 mm |',
        ].join('\n')
      )
    );
    expect(body).toContain('<span class="n">2.</span><div class="s">전기천공 조건');
    expect(body).toContain('<ul class="sub"><li>얼음 위 10분</li></ul>');
    expect(body).toContain('<table class="grid"><tr><th>전압</th><th>큐벳</th></tr><tr><td>1.8 kV</td><td>1 mm</td></tr></table>');
    expect(body).not.toContain('| ---');
  });

  it('prints a text section\'s list with bullets instead of its Markdown marks (#253)', () => {
    const body = worksheetBody(md =>
      md.replace(
        '#### Equipment\n- (e.g. centrifuge, spectrophotometer, etc.)',
        '#### Equipment\n- Acoustic liquid dispenser\n  - 384-well head'
      )
    );
    expect(body).toContain('<ul class="bul"><li class="d0">Acoustic liquid dispenser</li><li class="d1">384-well head</li></ul>');
    expect(body).not.toContain('<p>- Acoustic');
  });

  it('reduces inline markdown to its text', () => {
    expect(plainInline('**Spin** `300 g` with [[DNA-1|plasmid]] see [doc](http://x) ![[img.png]]')).toBe(
      'Spin 300 g with plasmid see doc [img.png]'
    );
  });
});

describe('sliceIntoPages', () => {
  const block = (top: number, height: number, opId?: string): MeasuredBlock => ({ top, bottom: top + height, opId });

  it('cuts before the block that would overflow and names the unit operation each page starts in', () => {
    const blocks = [block(0, 40), block(40, 40), block(80, 40, 'UHW010'), block(120, 40), block(160, 40, 'UHW020'), block(200, 40)];
    expect(sliceIntoPages(blocks, 100)).toEqual([
      { from: 0, to: 2, unitOpIndex: 0, opId: '' },
      { from: 2, to: 4, unitOpIndex: 1, opId: 'UHW010' },
      { from: 4, to: 6, unitOpIndex: 2, opId: 'UHW020' },
    ]);
  });

  it('never leaves a unit-operation heading at the bottom of a page', () => {
    const blocks = [block(0, 50), block(50, 10, 'UHW010'), block(60, 60)];
    expect(sliceIntoPages(blocks, 100).map(p => [p.from, p.to, p.opId])).toEqual([
      [0, 1, ''],
      [1, 3, 'UHW010'],
    ]);
  });

  it('gives a block taller than a page a page of its own', () => {
    const blocks = [block(0, 30), block(30, 300), block(330, 30)];
    expect(sliceIntoPages(blocks, 100).map(p => [p.from, p.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(sliceIntoPages([], 100)).toEqual([]);
  });
});
