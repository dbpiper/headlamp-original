import * as path from 'node:path';

import type { Chunk, Ctx, PrettyFns } from './model';
import { ansi } from '../ansi';
import { Colors } from '../colors';
import { collapseStacks, firstTestLocation, stripAnsiSimple, isStackLine } from '../stacks';
import { colorStackLine } from './fns';

const relPath = (abs: string, cwd: string) => abs.replace(/\\/g, '/').replace(`${cwd}/`, '');

export const renderChunks = (
  chunks: ReadonlyArray<Chunk>,
  ctx: Ctx,
  fns: PrettyFns,
  opts?: { readonly onlyFailures?: boolean },
): { readonly text: string; readonly hadParsed: boolean } => {
  const out: string[] = [];
  const seenFiles = new Set<string>();
  const seenFailures = new Set<string>();
  const onlyFailures = Boolean(opts?.onlyFailures);
  let currentRelFile: string | null = null;

  const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const ch of chunks) {
    if (ch.tag === 'PassFail') {
      const rel = relPath(ch.rel, ctx.cwd);
      if (seenFiles.has(rel)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      seenFiles.add(rel);
      currentRelFile = rel;
      if (!(onlyFailures && ch.badge === 'PASS')) {
        out.push(fns.buildFileBadgeLine(rel, ch.badge === 'FAIL' ? 1 : 0));
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ch.tag === 'FailureBlock') {
      out.push(fns.drawFailLine());
      const location = firstTestLocation(ch.lines, ctx.projectHint);
      const rel = location ? relPath(location.split(':')[0] ?? '', ctx.cwd) : '';
      const headerText = rel ? `${rel} > ${ch.title}` : ch.title;
      out.push(`${Colors.Failure('×')} ${ansi.white(headerText)}`);

      const codeStart = fns.findCodeFrameStart(ch.lines);
      const collapsedForSrc = collapseStacks(ch.lines.slice(0));
      const deepestLoc = fns.deepestProjectLoc(collapsedForSrc, ctx.projectHint);
      let effectiveLoc = deepestLoc;
      if (!effectiveLoc && currentRelFile) {
        try {
          const abs = path.resolve(ctx.cwd, currentRelFile);
          const source = ctx.readSource(abs);
          const testName = (() => {
            const parts = ch.title.split('>');
            return (parts[parts.length - 1] || ch.title).trim();
          })();
          const itRe = new RegExp(
            String.raw`\b(?:it|test)\s*\(\s*['\"]${escapeRegExp(testName)}['\"]`,
          );
          let index = source.findIndex((line) => itRe.test(line));
          if (index < 0) {
            // fallback: search for expect within file to give some context
            index = source.findIndex((line) => /\bexpect\s*\(/.test(line));
          } else {
            // try to find first expect within the test block window (~80 lines)
            const windowEnd = Math.min(source.length, index + 80);
            for (let i = index; i < windowEnd; i += 1) {
              if (/\bexpect\s*\(/.test(source[i]!)) {
                index = i;
                break;
              }
            }
          }
          if (index >= 0) {
            effectiveLoc = { file: abs.replace(/\\/g, '/'), line: index + 1 };
          }
        } catch {
          /* ignore source fallback errors */
        }
      }

      if (codeStart >= 0) {
        out.push('', ...fns.buildCodeFrameSection(ch.lines, ctx, effectiveLoc), '');
      } else {
        out.push('', ...fns.buildCodeFrameSection(ch.lines, ctx, effectiveLoc), '');
      }
      const pretty = fns.buildPrettyDiffSection(undefined, ch.lines);
      out.push(...pretty);
      const hasPretty = pretty.length > 0;
      const details = fns.linesFromDetails(undefined);
      // If we found almost no info, synthesize a minimal message section by scanning for
      // non-empty non-stack lines around the code frame / first hint line
      const minimal = (() => {
        const plain = ch.lines.map((ln) => stripAnsiSimple(ln));
        const hint = plain.findIndex(
          (lineText) =>
            /expect\(.+?\)\.(?:to|not\.)/.test(lineText) || /\bError:?\b/.test(lineText),
        );
        const acc: string[] = [];
        const start = hint >= 0 ? hint : 0;
        for (let i = start; i < plain.length; i += 1) {
          const ln = plain[i]!;
          if (!ln.trim()) {
            break;
          }
          if (isStackLine(ln)) {
            break;
          }
          acc.push(ln);
        }
        return acc;
      })();
      const collapsedForTail = collapseStacks(ch.lines.slice(0));
      const stackPreview = ctx.showStacks
        ? collapsedForTail
            .filter((ln) => isStackLine(stripAnsiSimple(ln)))
            .filter((ln) => ctx.projectHint.test(stripAnsiSimple(ln)))
            .slice(0, 2)
            .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`)
        : [];
      out.push(
        ...fns.buildMessageSection(minimal.length ? minimal : ch.lines, details, ctx, {
          suppressDiff: hasPretty,
          stackPreview,
        }),
      );
      if (minimal.length === 0 && fns.buildFallbackMessageBlock) {
        out.push(...fns.buildFallbackMessageBlock(ch.lines, { messages: details.messages }));
      }
      // Extract inline console errors when present in raw output
      const consoleInline = (() => {
        const plain = ch.lines.map((ln) => stripAnsiSimple(ln));
        const cand = plain
          .filter((ln) => /\bconsole\.(error|warn)\s*\(/i.test(ln) || /^\s*Error:/.test(ln))
          .map((ln) => ln.trim())
          .filter((ln) => ln.length > 0)
          .sort((a, b) => b.length - a.length)
          .slice(0, 3);
        return cand;
      })();
      if (consoleInline.length > 0) {
        out.push(ansi.dim('    Console errors:'), ...consoleInline.map((ln) => `      ${ln}`), '');
      }
      if (ctx.showStacks && fns.buildStackSection && stackPreview.length === 0) {
        const collapsed = collapseStacks(ch.lines.slice(0));
        out.push(...fns.buildStackSection(collapsed, ctx));
      }
      out.push(fns.drawFailLine(), '');
      if (rel) {
        seenFailures.add(`${rel}|${ch.title}`);
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ch.tag === 'Summary') {
      out.push(ch.line);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ch.tag === 'Stack') {
      if (ctx.showStacks) {
        out.push(ch.line);
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    // Hide miscellaneous non-failure lines when onlyFailures is true
    if (!onlyFailures) {
      out.push(ch.line);
    }
  }
  const hadParsed =
    seenFiles.size > 0 ||
    seenFailures.size > 0 ||
    out.some((lineText) => /^(?:\s*)(PASS|FAIL)\b/.test(stripAnsiSimple(lineText)));
  return { text: out.join('\n'), hadParsed };
};
