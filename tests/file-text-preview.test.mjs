import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { detectFileLanguage, isMarkdownPath, COMMON_LANGUAGES } from "../src/renderer/src/features/files/fileLanguage.ts";
import { classifyTextPreview } from "../src/renderer/src/features/files/textPreview.ts";
import { highlightCode, highlightCodeLines, isRegisteredLanguage } from "../src/renderer/src/features/files/codeHighlight.ts";

const preview = (name, content, overrides = {}) => classifyTextPreview({ name, content, byteSize: Buffer.byteLength(content), truncated: false, ...overrides });
const source = (lines) => lines.map((line) => line.map((token) => token.text).join("")).join("\n");

test("known paths share a registered language", () => {
  for (const language of COMMON_LANGUAGES) assert.equal(isRegisteredLanguage(language), true, language);
  assert.equal(detectFileLanguage("src/FILE.TSX"), "typescript");
  assert.equal(detectFileLanguage("src\\FILE.mts"), "typescript");
  assert.equal(detectFileLanguage("src/page.html"), "xml");
  assert.equal(detectFileLanguage("LICENSE"), null);
  assert.equal(detectFileLanguage("a.constructor"), null);
  assert.equal(detectFileLanguage("a.md"), null);
  assert.equal(isMarkdownPath("docs/readme.MD"), true);
  assert.equal(preview("readme.md", "# Hello").language, "markdown");
  assert.equal(preview("note.txt", "hello").kind, "plain");
});

test("invalid JSON remains exact source", () => {
  const text = '{"unfinished": [true,\n';
  assert.equal(preview("data.json", text).highlightable, true);
  const lines = highlightCodeLines(text, "json");
  assert.notEqual(lines, null);
  assert.equal(source(lines), text);
  assert.ok(lines.flat().some((token) => token.classNames.includes("hljs-attr")));
});

test("multiline tokens retain blank lines", () => {
  const text = '/* first\n\nlast */\nconst value = `one\ntwo`;\n';
  const lines = highlightCodeLines(text, "typescript");
  assert.equal(source(lines), text);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines[1], []);
  assert.deepEqual(lines[5], []);
  assert.ok(lines[2].some((token) => token.classNames.includes("hljs-comment")));
  assert.ok(lines[4].some((token) => token.classNames.includes("hljs-string")));
});

test("HTML and Markdown remain inert source", () => {
  for (const [language, text] of [
    ["xml", '<script>alert(1)</script>\n<img src=x onerror="alert(2)">'],
    ["markdown", '# Title\n\n<script>alert(1)</script>\n[click](javascript:alert(2))']
  ]) {
    assert.equal(source(highlightCodeLines(text, language)), text);
    const html = renderToStaticMarkup(highlightCode(text, language));
    assert.ok(!/<(?:script|img|a)\b/.test(html));
    assert.ok(html.includes("&lt;"));
  }
});

test("bounded source falls back unchanged", () => {
  for (const text of ["x".repeat(4097), "\n".repeat(5000), `${"я".repeat(2048)}\n`.repeat(63)]) {
    const model = preview("source.ts", text);
    assert.equal(model.highlightable, false);
    assert.equal(model.richDisabled, true);
    assert.equal(highlightCodeLines(text, "typescript"), null);
    assert.equal(highlightCode(text, "typescript"), null);
  }
  assert.equal(preview("source.ts", "x", { truncated: true }).highlightable, false);
  assert.equal(preview("source.ts", "x", { byteSize: 500_000 }).highlightable, false);
  assert.equal(preview("source.ts", "x".repeat(4096)).highlightable, true);
  assert.equal(preview("source.ts", "\n".repeat(4999)).highlightable, true);
  assert.equal(highlightCodeLines("text", "unknown"), null);
  assert.equal(highlightCode("text", null), null);
});

test("too many tokens use plain source", () => {
  const text = `${"const x = 1; ".repeat(100)}\n`.repeat(51);
  assert.equal(preview("source.ts", text).highlightable, true);
  assert.equal(highlightCodeLines(text, "typescript") === null, true);
  assert.equal(highlightCode(text, "typescript") === null, true);
});
