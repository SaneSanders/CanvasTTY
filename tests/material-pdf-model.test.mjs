import assert from "node:assert/strict";
import test from "node:test";
import { PDF_PAGE_GAP, PDF_PIXEL_LIMIT, pdfLayout, pdfScale, visiblePages } from "../src/renderer/src/features/materials/pdfModel.ts";

test("pages stack at the card width with their own proportions", () => {
  const layout = pdfLayout([{ width: 600, height: 800 }, { width: 800, height: 600 }, { width: 600, height: 800 }], 300);
  assert.deepEqual(layout.heights, [400, 225, 400]);
  assert.deepEqual(layout.tops, [PDF_PAGE_GAP, PDF_PAGE_GAP * 2 + 400, PDF_PAGE_GAP * 3 + 625]);
  assert.equal(layout.total, PDF_PAGE_GAP * 4 + 1025);
});

test("only pages near the view are rendered", () => {
  const layout = pdfLayout(Array.from({ length: 10 }, () => ({ width: 600, height: 800 })), 300);
  assert.deepEqual(visiblePages(layout, 0, 300), [0, 1]);
  assert.deepEqual(visiblePages(layout, 1_300, 300), [2, 3, 4]);
});

test("a page renders at the asked scale unless that would exceed the pixel limit", () => {
  assert.equal(pdfScale({ width: 595, height: 842 }, 2), 2);
  const poster = { width: 2384, height: 3370 };
  const scale = pdfScale(poster, 2);
  assert.ok(scale < 2);
  assert.ok(Math.abs(poster.width * scale * poster.height * scale - PDF_PIXEL_LIMIT) < 1);
});

test("page rendering follows a rounded, deferred width so resizes do not flicker", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/PdfMaterialBody.tsx", import.meta.url), "utf8");
  assert.match(source, /Math\.round\(view\.width - 24\)/);
  assert.match(source, /useDeferredValue\(width\)/);
  assert.doesNotMatch(source, /width=\{width\}/);
});

test("the visibility observer re-arms when a too-large pdf shrinks back", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/PdfMaterialBody.tsx", import.meta.url), "utf8");
  const observer = source.slice(source.indexOf("new IntersectionObserver"), source.indexOf("}, [seen"));
  assert.match(source, /\}, \[seen, tooLarge\]\);/);
});
