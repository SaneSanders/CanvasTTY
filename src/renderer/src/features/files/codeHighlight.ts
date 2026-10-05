import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { MAX_HIGHLIGHT_TOKENS, withinHighlightLimits } from "./textPreview.ts";
import type { HighlightLines, HighlightToken } from "./textPreview.ts";

const lowlight = createLowlight(common);
type HighlightTree = ReturnType<typeof lowlight.highlight>;
type HighlightNode = HighlightTree | HighlightTree["children"][number];

export function isRegisteredLanguage(language: string | null | undefined): boolean {
  return typeof language === "string" && language.length > 0 && lowlight.registered(language);
}

function splitTokens(tree: HighlightTree): HighlightLines | null {
  const lines: HighlightToken[][] = [[]];
  const pending: { node: HighlightNode; classes: readonly string[] }[] = [{ node: tree, classes: [] }];
  let tokens = 0;
  while (pending.length > 0) {
    const { node, classes } = pending.pop()!;
    if (node.type === "text") {
      const parts = node.value.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) lines.push([]);
        if (parts[index].length > 0) {
          tokens += 1;
          if (tokens > MAX_HIGHLIGHT_TOKENS) return null;
          lines[lines.length - 1].push({ text: parts[index], classNames: classes });
        }
      }
    } else if (node.type === "root" || node.type === "element") {
      const own = node.type === "element" ? node.properties.className : null;
      const nextClasses = Array.isArray(own) ? [...classes, ...own.filter((value): value is string => typeof value === "string")] : classes;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index], classes: nextClasses });
      }
    }
  }
  return lines;
}

function highlighted(content: string, language: string | null | undefined): { tree: HighlightTree; lines: HighlightLines } | null {
  if (!isRegisteredLanguage(language) || !withinHighlightLimits(content)) return null;
  try {
    const tree = lowlight.highlight(language!, content);
    const lines = splitTokens(tree);
    return lines === null ? null : { tree, lines };
  } catch {
    return null;
  }
}

export function highlightCodeLines(content: string, language: string | null | undefined): HighlightLines | null {
  return highlighted(content, language)?.lines ?? null;
}

export function highlightCode(content: string, language: string | null | undefined): ReactElement | null {
  const result = highlighted(content, language);
  if (result === null) return null;
  try {
    return toJsxRuntime(result.tree, { Fragment, jsx, jsxs });
  } catch {
    return null;
  }
}
