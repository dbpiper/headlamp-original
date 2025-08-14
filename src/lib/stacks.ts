import { ansi } from './ansi';

export const isStackLine = (line: string) => /\s+at\s+/.test(line);

export const stripAnsiSimple = (text: string): string => {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const charCode = text.charCodeAt(i);
    if (charCode === 27 /* ESC */) {
      if (text.charAt(i + 1) === '[') {
        i += 2;
        while (i < text.length) {
          const code = text.charCodeAt(i);
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
          i += 1;
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    out += text.charAt(i);
  }
  return out;
};

export const firstTestLocation = (lines: readonly string[], projectHint: RegExp) => {
  for (const ln of lines) {
    const match = ln.match(/\(([^()]+?:\d+:\d+)\)/) || ln.match(/\s([\w./-]+?:\d+:\d+)\s*$/);
    if (match && projectHint.test(match[1]!)) {
      return match[1]!;
    }
  }
  return undefined;
};

export const collapseStacks = (lines: readonly string[]) => {
  const out: string[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden > 0) {
      out.push(ansi.gray(`      … ${hidden} stack frame${hidden === 1 ? '' : 's'} hidden`));
      hidden = 0;
    }
  };
  for (const raw of lines) {
    const ln = stripAnsiSimple(raw);
    if (isStackLine(ln)) {
      // Treat any stack frame inside node_modules or node: internals as noisy.
      // We do NOT keep these frames, as they are generally runner internals and
      // overwhelm the useful frames.
      const noisy = /node_modules\//.test(ln) || /\s+at\s+node:/.test(ln);
      const keep = !noisy;
      if (!keep) {
        hidden += 1;
        // eslint-disable-next-line no-continue
        continue;
      }
      flush();
      out.push(raw);
    } else {
      flush();
      out.push(raw);
    }
  }
  flush();
  return out;
};
