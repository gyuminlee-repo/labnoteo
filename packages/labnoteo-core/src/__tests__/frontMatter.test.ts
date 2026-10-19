// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// Phase 0 regression safety net for the front-matter primitives in
// `sections/frontMatter.ts`. This is a NEW file, deliberately separate from
// `frontMatterYaml.test.ts` (which exercises the lossy parseWorkflowMd /
// serializeWorkflowMd removed in Phase 2). Here we only touch
// `parseFrontMatterYaml` / `serializeFrontMatterEntry`.
//
// Correct behaviour is locked in with plain `it(...)`. Reproduced data-loss
// bugs are pinned with `it.fails(...)`: they pass now *because* the assertion
// throws against current behaviour, and Phase 1-2 (yaml.dump for scalars +
// line-anchored closing fence) will flip them to normal `it(...)`.
import { parseFrontMatterYaml, planDateInsertion, serializeFrontMatterEntry } from '../sections/frontMatter';
import { isInFrontMatter } from '../sections/documentHead';

// #106: the date commands typed straight into the YAML.
describe('date insertion and the front matter', () => {
  const DOC = ['---', "title: 'X'", "end_date: ''", 'start_date:', 'tags:', '  - a', '---', '', '# X', 'body'].join(
    '\n'
  );
  const at = (line: number, col = 0): number =>
    DOC.split('\n')
      .slice(0, line)
      .reduce((n, l) => n + l.length + 1, 0) + col;
  const apply = (plan: ReturnType<typeof planDateInsertion>): string =>
    'reason' in plan ? 'refused' : DOC.slice(0, plan.from) + plan.text + DOC.slice(plan.to);

  it('tells front matter from body, --- lines included', () => {
    expect(isInFrontMatter(DOC, at(0))).toBe(true);
    expect(isInFrontMatter(DOC, at(6, 3))).toBe(true);
    expect(isInFrontMatter(DOC, at(7))).toBe(false);
    expect(isInFrontMatter('---\ntitle: x\n\n# Body', 5)).toBe(false);
  });

  it('replaces the selection in the body', () => {
    expect(planDateInsertion(DOC, at(9, 4), at(9, 4), '2026-10-18')).toEqual({
      from: at(9, 4),
      to: at(9, 4),
      text: '2026-10-18',
    });
  });

  it("fills a key whose value is '' or missing", () => {
    expect(apply(planDateInsertion(DOC, at(2, 5), at(2, 5), '2026-10-18'))).toContain('\nend_date: 2026-10-18\n');
    expect(apply(planDateInsertion(DOC, at(3, 11), at(3, 11), '2026-10-18'))).toContain('\nstart_date: 2026-10-18\n');
    expect(parseFrontMatterYaml(apply(planDateInsertion(DOC, at(2), at(2), '2026-10-18'))).frontMatter.end_date).toBe(
      '2026-10-18'
    );
  });

  it('refuses a line with a value, a --- line and a list item', () => {
    for (const line of [1, 0, 6, 5]) {
      expect(planDateInsertion(DOC, at(line, 1), at(line, 1), '2026-10-18')).toEqual({ reason: 'frontMatter' });
    }
  });

  it('treats an unclosed --- block as body', () => {
    const doc = '---\ntitle: x\n';
    expect(planDateInsertion(doc, 8, 8, 'D')).toEqual({ from: 8, to: 8, text: 'D' });
  });

  // #167: a unit op's Meta date lines follow the same rule.
  it('fills an empty Start_date/End_date inside its quotes and refuses one with a value', () => {
    const body = "\n- Experimenter: 홍길동\n- Start_date: '2026-10-01 09:00'\n- End_date: ''\n- End_date:\n";
    const doc = `---\ntitle: x\n---\n${body}`;
    const lineAt = (text: string, col: number) => doc.indexOf(text) + col;
    const fill = (pos: number) => {
      const plan = planDateInsertion(doc, pos, pos, '2026-10-19');
      return 'reason' in plan ? plan.reason : doc.slice(0, plan.from) + plan.text + doc.slice(plan.to);
    };
    expect(fill(lineAt("- End_date: ''", 3))).toContain("\n- End_date: '2026-10-19'\n- End_date:\n");
    expect(fill(lineAt('- End_date:\n', 2))).toContain("\n- End_date: '2026-10-19'\n");
    expect(fill(lineAt('- Start_date', 5))).toBe('metaDate');
    expect(fill(lineAt('- Experimenter', 5))).toContain('홍길동');
  });
});

describe('parseFrontMatterYaml', () => {
  it('parses a simple block and strips it from the body', () => {
    const { frontMatter, body } = parseFrontMatterYaml('---\ntitle: X\nn: 3\n---\nBody line\n');
    expect(frontMatter).toEqual({ title: 'X', n: 3 });
    expect(body).toBe('Body line\n');
  });

  it('returns an empty object and the full body when there is no front matter', () => {
    const md = 'No front matter here.\n';
    const { frontMatter, body } = parseFrontMatterYaml(md);
    expect(frontMatter).toEqual({});
    expect(body).toBe(md);
  });

  it('keeps ISO dates as plain strings (CORE_SCHEMA)', () => {
    const { frontMatter } = parseFrontMatterYaml('---\ncreated_date: 2026-01-15\n---\n');
    expect(frontMatter.created_date).toBe('2026-01-15');
  });

  // Fixed in Phase 1-2: the closing-fence regex is now line-anchored, so a
  // `----` (4-dash) line is NOT a valid closing fence — there is no front
  // matter and the body is left intact.
  it('does not treat a ---- (4-dash) line as the closing fence', () => {
    const { frontMatter, body } = parseFrontMatterYaml('---\na: 1\n----\nbody text\n');
    expect(frontMatter).toEqual({});
    expect(body).toContain('a: 1');
  });

  // `parseError` exists because an empty `frontMatter` is ambiguous: it means
  // both "this note has no fields" and "this block is broken". Callers that
  // re-serialize the result were erasing every field in the note for the
  // second case, so the two have to be distinguishable.
  describe('parseError', () => {
    it('reports an unquoted colon, which is the realistic way to break a block', () => {
      const { frontMatter, parseError } = parseFrontMatterYaml(
        '---\ntitle: EXP: 3rd try\nauthor: Kim\n---\nbody\n'
      );
      expect(parseError).toBeTruthy();
      expect(frontMatter).toEqual({});
    });

    it('reports a block that parses but is not a mapping', () => {
      // Valid YAML, no fields to read — re-serializing would drop the text.
      expect(parseFrontMatterYaml('---\njust a string\n---\nbody\n').parseError).toBeTruthy();
      expect(parseFrontMatterYaml('---\n- a\n- b\n---\nbody\n').parseError).toBeTruthy();
    });

    it('stays unset for a note with no front matter at all', () => {
      // Not an error: most notes in a vault legitimately have no block.
      expect(parseFrontMatterYaml('# Just a heading\n').parseError).toBeUndefined();
    });

    it('stays unset for an empty block', () => {
      expect(parseFrontMatterYaml('---\n---\nbody\n').parseError).toBeUndefined();
    });

    it('stays unset for a block that parses cleanly', () => {
      expect(parseFrontMatterYaml('---\ntitle: X\n---\nbody\n').parseError).toBeUndefined();
    });

    it('still returns the body so the note can be rendered', () => {
      const { body } = parseFrontMatterYaml('---\ntitle: EXP: 3rd try\n---\nbody text\n');
      expect(body).toBe('body text\n');
    });
  });
});

describe('serializeFrontMatterEntry', () => {
  it('emits a compact one-liner for a scalar', () => {
    expect(serializeFrontMatterEntry('title', 'Protein Folding')).toBe('title: Protein Folding');
  });

  it('emits proper YAML for a list and round-trips it', () => {
    const line = serializeFrontMatterEntry('tags', ['pcr', 'failed']);
    const { frontMatter } = parseFrontMatterYaml(`---\n${line}\n---\n`);
    expect(frontMatter.tags).toEqual(['pcr', 'failed']);
  });

  it('emits an empty value for null/undefined', () => {
    expect(serializeFrontMatterEntry('end_date', null)).toBe('end_date: ');
    expect(serializeFrontMatterEntry('end_date', undefined)).toBe('end_date: ');
  });

  // Fixed in Phase 1-2: a scalar value containing a colon is now routed through
  // yaml.dump, so it is quoted (`title: 'Exp: run 1'`) and survives a
  // serialize -> parse round-trip instead of resetting the block to {}.
  it('round-trips a scalar value that contains a colon', () => {
    const line = serializeFrontMatterEntry('title', 'Exp: run 1');
    const { frontMatter } = parseFrontMatterYaml(`---\n${line}\n---\nbody`);
    expect(frontMatter.title).toBe('Exp: run 1');
  });
});
