import { detectFileLanguage, isMarkdownPath } from "./fileLanguage.ts";

export const MAX_HIGHLIGHT_BYTES = 250 * 1024;
export const MAX_HIGHLIGHT_LINES = 5_000;
export const MAX_HIGHLIGHT_LINE_LENGTH = 4_096;
export const MAX_HIGHLIGHT_TOKENS = 20_000;

export interface HighlightToken {
  text: string;
  classNames: readonly string[];
}

export type HighlightLines = readonly (readonly HighlightToken[])[];

export interface TextPreviewInput {
  name: string;
  content: string;
  byteSize: number;
  truncated: boolean;
}

export interface TextPreviewModel {
  kind: "plain" | "code" | "markdown";
  language: string | null;
  highlightable: boolean;
  richDisabled: boolean;
}

export function withinHighlightLimits(content: string, byteSize?: number): boolean {
  if (content.length > MAX_HIGHLIGHT_BYTES) return false;
  if (byteSize !== undefined && (!Number.isFinite(byteSize) || byteSize < 0 || byteSize > MAX_HIGHLIGHT_BYTES)) return false;
  if (new TextEncoder().encode(content).length > MAX_HIGHLIGHT_BYTES) return false;
  let lines = 1;
  let length = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lines += 1;
      length = 0;
      if (lines > MAX_HIGHLIGHT_LINES) return false;
    } else {
      length += 1;
      if (length > MAX_HIGHLIGHT_LINE_LENGTH) return false;
    }
  }
  return true;
}

export function classifyTextPreview(input: TextPreviewInput): TextPreviewModel {
  const markdown = isMarkdownPath(input.name);
  const language = markdown ? "markdown" : detectFileLanguage(input.name);
  const highlightable = language !== null && !input.truncated && withinHighlightLimits(input.content, input.byteSize);
  return {
    kind: highlightable ? markdown ? "markdown" : "code" : "plain",
    language,
    highlightable,
    richDisabled: language !== null && !highlightable
  };
}
