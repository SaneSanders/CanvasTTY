import assert from "node:assert/strict";
import test from "node:test";
import { elementAt, observedElements, pagePoint, pageViewport, sanitizePageUrl } from "../src/renderer/src/features/materials/browserPage.ts";
import { scenarioStepIcon, scenarioStepSummary, scenarioStopKey } from "../src/renderer/src/features/materials/scenarioModel.ts";

const frame = { left: 128.76, top: 310.52, width: 822, height: 429, zoom: 0.92 };

test("a pointer on the browser card maps to the page's own pixels at the canvas zoom", () => {
  const point = pagePoint(194.24, 668.21, frame);
  assert.deepEqual({ x: Math.round(point.x), y: Math.round(point.y) }, { x: 71, y: 389 });
  const viewport = pageViewport(frame);
  assert.deepEqual({ width: Math.round(viewport.width), height: Math.round(viewport.height) }, { width: 893, height: 466 });
});

test("the element under a click is the innermost one that contains it", () => {
  const elements = observedElements({
    elements: [
      { role: "group", name: "Form", bounds: { x: 0, y: 200, width: 600, height: 240 } },
      { role: "button", name: "Buy now", bounds: { x: 32, y: 369, width: 520, height: 48 } },
      { role: "link", name: "Hidden", bounds: null }
    ]
  });
  assert.deepEqual(elements.map((element) => element.name), ["Form", "Buy now"]);
  assert.equal(elementAt(elements, { x: 71, y: 389 }).name, "Buy now");
  assert.equal(elementAt(elements, { x: 580, y: 220 }).name, "Form");
  assert.equal(elementAt(elements, { x: 700, y: 20 }), null);
});

test("steps read as facts, and the person's expectation reads as theirs", () => {
  const step = (overrides) => ({ index: 0, at: 1, url: "http://127.0.0.1:8765/index.html", title: "Acme store", point: null, element: null, text: null, image: null, ...overrides });
  assert.equal(scenarioStepSummary(step({ kind: "start" }), "en"), "Opened Acme store");
  assert.equal(scenarioStepSummary(step({ kind: "click", element: { role: "button", name: "Buy now" } }), "en"), "Click: button “Buy now”");
  assert.equal(scenarioStepSummary(step({ kind: "click", element: { role: "button", name: "Buy now" } }), "ru"), "Нажатие: button «Buy now»");
  assert.equal(scenarioStepSummary(step({ kind: "click", point: { x: 10.4, y: 20.6 } }), "en"), "Click: (10, 21)");
  assert.equal(scenarioStepSummary(step({ kind: "navigate", title: "" }), "en"), "Went to 127.0.0.1:8765/index.html");
  assert.equal(scenarioStepSummary(step({ kind: "expectation", text: "A thank-you message appears." }), "ru"), "Ожидается: A thank-you message appears.");
  assert.deepEqual(["start", "click", "navigate", "expectation", "tab-left"].map(scenarioStepIcon), ["browser", "scenario", "arrow", "flag", "browser"]);
  assert.deepEqual(["stopped", "limit", "browser-closed", "app-closed", null].map(scenarioStopKey),
    [null, "scenarioStoppedLimit", "scenarioStoppedBrowser", "scenarioStoppedApp", null]);
});

test("a stored page url drops query, fragment and token-like path segments", () => {
  assert.equal(sanitizePageUrl("https://shop.example/items?session=abc#top"), "https://shop.example/items");
  assert.equal(sanitizePageUrl("https://shop.example/u/9f8a7b6c5d4e3f2a1b0c/posts"), "https://shop.example/u/…/posts");
  assert.equal(sanitizePageUrl("https://shop.example/u/9f8a7b6c-5d4e-3f2a-8b0c-1d2e3f4a5b6c/posts"), "https://shop.example/u/…/posts");
  assert.equal(sanitizePageUrl("https://shop.example/items/42"), "https://shop.example/items/42");
  assert.equal(sanitizePageUrl("https://shop.example/blog/release-notes-2026"), "https://shop.example/blog/release-notes-2026");
  assert.equal(sanitizePageUrl("https://shop.example/docs/index-v2-stable"), "https://shop.example/docs/index-v2-stable");
  assert.equal(sanitizePageUrl("https://shop.example/"), "https://shop.example");
  assert.equal(sanitizePageUrl("not a url"), "not a url");
});

test("the browser card renders the viewport element page capture measures", async () => {
  const { readFile } = await import("node:fs/promises");
  const card = await readFile(new URL("../src/renderer/src/features/browser/BrowserCard.tsx", import.meta.url), "utf8");
  assert.match(card, /className="browser-card__viewport"/);
});
