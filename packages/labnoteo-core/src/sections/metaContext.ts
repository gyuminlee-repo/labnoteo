import { listHeadings } from './sectionEdit';
import { classifyNote, isPlain } from './codeFences';

/** Whether a selection overlaps a property in a recognised unit operation's Meta section. */
export function overlapsMetaProperty(doc: string, from: number, to: number): boolean {
  const headings = listHeadings(doc);
  const lines = doc.split('\n');
  // Lines as the one block reading has them: a `key:` line in a fence, code or HTML block is no property.
  const kinds = classifyNote(lines.map(l => l.replace(/\r$/, '')));
  let offset = 0;
  for (let line = 0; line < lines.length; line++) {
    const end = offset + lines[line].length;
    if (end >= from && offset <= to && isPlain(kinds[line]) && /^\s*(?:[-*]\s+)?[\w]+\s*:/.test(lines[line])) {
      const section = headings.filter(h => h.line <= line && h.level <= 4).pop();
      if (section?.level === 4 && section.text.trim().toLowerCase() === 'meta' && /^\[[A-Z]+\d+\s/.test(section.parentHeading)) return true;
    }
    offset = end + 1;
  }
  return false;
}
