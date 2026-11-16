/**
 * The files a note links, by name, for the scan writers that trash an image only when no link to
 * it is left. A link missed is an image trashed under it, so where reading is unsure the answer
 * leans to "linked": {@link mayLinkName} also takes the name standing as a path's last part
 * anywhere in the text.
 */
import * as posix from '@labnoteo/core/posix';

/** ASCII punctuation, which a backslash escapes in CommonMark. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** `target` as the file name it ends in, lower-cased: escapes undone, `%XX` decoded. */
function nameOf(target: string): string {
  let path = target.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  try {
    path = decodeURIComponent(path);
  } catch {
    // A `%` that is no escape: the path as written.
  }
  return posix.basename(path.replace(/\\/g, '/')).trim().toLowerCase();
}

/**
 * The destination of an inline link whose `(` is at `at` (CommonMark): `<…>` (spaces allowed,
 * no line break), or a run without spaces whose parentheses balance, `\`-escapes kept as is.
 */
function destinationAt(text: string, at: number): string | undefined {
  let i = at + 1;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text[i] === '\n') {
    i++;
    while (text[i] === ' ' || text[i] === '\t') i++;
  }
  if (text[i] === '<') {
    let out = '';
    for (i++; i < text.length && text[i] !== '>' && text[i] !== '\n'; i++) {
      if (text[i] === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) out += text[i++];
      out += text[i];
    }
    return text[i] === '>' ? out : undefined;
  }
  let out = '';
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      out += c + text[++i];
      continue;
    }
    if (/\s/.test(c) || c.charCodeAt(0) < 0x20) break;
    if (c === '(') depth++;
    if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    out += c;
  }
  return out || undefined;
}

/**
 * The file names `text` links, lower-cased: wiki links and embeds (`[[a/b.jpg]]`, `![[b.jpg|200]]`,
 * `[[b#heading]]`, `[[b^block]]`), inline links and images (`![](a/b%20c.jpg)`, `[x](<a b.jpg> "t")`,
 * parentheses in the path), and reference definitions (`[x]: a/b.jpg`), each by its path's last part.
 */
export function linkedNames(text: string): Set<string> {
  const names = new Set<string>();
  const add = (target: string | undefined): void => {
    const name = target === undefined ? '' : nameOf(target);
    if (name) names.add(name);
  };
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) add(m[1].split(/[|#^]/)[0]);
  for (let at = text.indexOf(']('); at !== -1; at = text.indexOf('](', at + 2)) add(destinationAt(text, at + 1));
  for (const m of text.matchAll(/^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)/gm)) add(m[1].replace(/^<|>$/g, ''));
  return names;
}

/**
 * Whether `text` may link the file named `name`: a link {@link linkedNames} reads, or, leaning to
 * keep, the name standing as the last part of a path anywhere (as written, escapes undone, or
 * `%XX` decoded), so a link form not read above still keeps the file.
 */
export function mayLinkName(text: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (linkedNames(text).has(lower)) return true;
  const unescaped = text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  let decoded = unescaped;
  try {
    decoded = decodeURIComponent(unescaped.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    // Left as it is.
  }
  const escapedName = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const standing = new RegExp(`(?:^|[\\s/\\\\[(<|:"'=])${escapedName}(?=$|[\\s)\\]>|#^"'?&])`, 'm');
  return [text, unescaped, decoded].some(t => standing.test(t.toLowerCase()));
}
