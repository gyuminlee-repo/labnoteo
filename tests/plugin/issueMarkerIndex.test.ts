/**
 * #119: a marker copied with its ID joins the original's issue. The index
 * finds such IDs within an experiment the way `validate` does.
 */
import { describe, it, expect, vi } from 'vitest';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { IssueMarkerIndex, markerExperimentDir, noteMarkerIds } from '../../src/issueMarkerIndex';

const DIR = 'labnote/039_Test';
const A = `${DIR}/001_WD010_A.labnote.md`;
const B = `${DIR}/002_WD020_B.labnote.md`;
const README = `${DIR}/README.labnote.md`;

async function loaded(files: Record<string, string>) {
  const fs = new MemFileSystem(files);
  const onChange = vi.fn();
  const index = new IssueMarkerIndex(fs, onChange);
  expect(index.othersFor(A)).toBeUndefined();
  await vi.waitFor(() => expect(index.othersFor(A)).toBeDefined());
  return { index, onChange };
}

describe('noteMarkerIds', () => {
  it('reads the markers outside front matter and fenced code', () => {
    const md = '---\ntitle: x\n---\n@issue;ISS-a;밖\n```\n@issue;ISS-b;예시\n```\n';
    expect(noteMarkerIds(md)).toEqual(['ISS-a']);
  });

  // #266: a commented-out marker shares no issue, so it is no duplicate either.
  it('leaves out the markers in comments', () => {
    expect(noteMarkerIds('<!-- @issue;ISS-a;끔 -->\n%% @issue;ISS-b;끔 %%\n@issue;ISS-c;밖')).toEqual(['ISS-c']);
  });
});

describe('markerExperimentDir', () => {
  it('covers the notes directly in an experiment folder', () => {
    expect(markerExperimentDir(A)).toBe(DIR);
    expect(markerExperimentDir(`${DIR}/sub/x.labnote.md`)).toBeUndefined();
    expect(markerExperimentDir(`${DIR}/note.md`)).toBeUndefined();
    expect(markerExperimentDir('note.labnote.md')).toBeUndefined();
  });
});

describe('IssueMarkerIndex', () => {
  it('gives each note the marker IDs of the other notes of its experiment', async () => {
    const { index, onChange } = await loaded({
      [A]: '@issue;ISS-a;첫째',
      [B]: '@issue;ISS-b;둘째',
      [README]: '```\n@issue;ISS-c;예시\n```',
    });
    expect([...index.othersFor(A)!.ids]).toEqual([['ISS-b', '002_WD020_B.labnote.md']]);
    expect(onChange).toHaveBeenCalled();
  });

  it('reports a pasted marker once, naming the note that has it', async () => {
    const { index } = await loaded({ [A]: '@issue;ISS-a;첫째', [B]: '' });
    const before = index.othersFor(A)!.version;

    expect(index.update(B, '@issue;ISS-a;붙여 넣은 질문')).toEqual([
      { id: 'ISS-a', owner: '001_WD010_A.labnote.md' },
    ]);
    expect(index.othersFor(A)!.version).toBeGreaterThan(before);
    expect(index.othersFor(A)!.ids.get('ISS-a')).toBe('002_WD020_B.labnote.md');
    // Saving again with the duplicate still there says nothing new.
    expect(index.update(B, '@issue;ISS-a;붙여 넣은 질문\n더 적음')).toEqual([]);
  });

  it('reports a marker repeated within one note', async () => {
    const { index } = await loaded({ [A]: '@issue;ISS-a;첫째' });
    expect(index.update(A, '@issue;ISS-a;첫째\n@issue;ISS-a;둘째')).toEqual([{ id: 'ISS-a', owner: undefined }]);
  });

  it('ignores a duplicate inside a code block', async () => {
    const { index } = await loaded({ [A]: '@issue;ISS-a;첫째', [B]: '' });
    expect(index.update(B, '```\n@issue;ISS-a;예시\n```')).toEqual([]);
  });

  it('forgets a deleted note', async () => {
    const { index } = await loaded({ [A]: '', [B]: '@issue;ISS-b;둘째' });
    index.remove(B);
    expect(index.othersFor(A)!.ids.size).toBe(0);
  });
});
