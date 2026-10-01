import assert from "node:assert/strict";
import test from "node:test";
import {
  followLive,
  lineAnchor,
  lineAt,
  lineMarkers,
  TEXT_MARKER_LANES,
  textEditState,
  textFailureKey,
  visibleRows
} from "../src/renderer/src/features/materials/materialTextModel.ts";
import { DIFF_EDIT_LIMIT, DIFF_LINE_LIMIT, diffLines, diffRows } from "../src/renderer/src/features/materials/textDiff.ts";

function remark(number, start, end, overrides = {}) {
  return {
    id: `r${number}`,
    number,
    status: "open",
    target: { materialId: "m", versionId: "v1", anchor: { kind: "lines", start, end } },
    ...overrides
  };
}

test("a line selection becomes an ordered range inside the text", () => {
  assert.deepEqual(lineAnchor(9, 3, 20), { kind: "lines", start: 3, end: 9 });
  assert.deepEqual(lineAnchor(0, 40, 20), { kind: "lines", start: 1, end: 20 });
  assert.equal(lineAt(37, 180, 100), 13);
  assert.equal(lineAt(-5, 0, 100), 1);
  assert.equal(lineAt(99_999, 0, 100), 100);
});

test("only rows near the viewport are rendered", () => {
  assert.deepEqual(visibleRows(0, 180, 10_000), { first: 0, last: 34 });
  assert.deepEqual(visibleRows(18_000, 180, 10_000), { first: 976, last: 1034 });
  assert.deepEqual(visibleRows(0, 180, 3), { first: 0, last: 2 });
});

test("overlapping line remarks get separate lanes, clamped to the text", () => {
  const markers = lineMarkers([
    remark(1, 2, 10),
    remark(2, 5, 6, { status: "sent" }),
    remark(3, 12, 400, { target: { materialId: "m", versionId: "old", anchor: { kind: "lines", start: 12, end: 400 } } }),
    remark(4, 1, 1, { target: { materialId: "m", versionId: "v1", anchor: { kind: "whole" } } })
  ], 50, new Set(["old"]));
  assert.deepEqual(markers.map(({ number, start, end, lane, stale, status }) => ({ number, start, end, lane, stale, status })), [
    { number: 1, start: 2, end: 10, lane: 0, stale: false, status: "open" },
    { number: 2, start: 5, end: 6, lane: 1, stale: false, status: "sent" },
    { number: 3, start: 12, end: 50, lane: 0, stale: true, status: "open" }
  ]);
  const crowded = lineMarkers([1, 2, 3, 4, 5].map((number) => remark(number, 1, 5)), 10, new Set());
  assert.equal(Math.max(...crowded.map((marker) => marker.lane)), TEXT_MARKER_LANES - 1);
});

test("an edit is a draft until saved, and a conflict once the disk moved on", () => {
  const live = { text: "a\n", hash: "h1", eol: "lf", bom: false, editable: true, byteSize: 2 };
  assert.equal(textEditState(null, null, live), "clean");
  assert.equal(textEditState("h1", "a\n", live), "clean");
  assert.equal(textEditState("h1", "b\n", live), "draft");
  assert.equal(textEditState("h0", "a\n", live), "conflict");
  assert.equal(textFailureKey("not-text"), "materialTextNotText");
  assert.equal(textFailureKey("missing"), "materialUnreadable");
});

test("an editor without edits follows the disk, and real edits stay a conflict", () => {
  const live = { text: "fixed by agent\n", hash: "h2", eol: "lf", bom: false, editable: true, byteSize: 15 };
  assert.equal(followLive({ baseHash: "h2", baseText: "fixed by agent\n", text: "mine\n" }, live), null);
  assert.equal(followLive({ baseHash: "h2", baseText: "fixed by agent\n", text: "fixed by agent\n" }, live), null);
  assert.deepEqual(followLive({ baseHash: "h1", baseText: "old\n", text: "old\n" }, live), { baseHash: "h2", baseText: "fixed by agent\n", text: "fixed by agent\n" });
  assert.deepEqual(followLive({ baseHash: "h1", baseText: null, text: "fixed by agent\n" }, live), { baseHash: "h2", baseText: "fixed by agent\n", text: "fixed by agent\n" });
  assert.equal(followLive({ baseHash: "h1", baseText: "old\n", text: "mine\n" }, live), null);
  assert.equal(followLive({ baseHash: "h1", baseText: null, text: "old\n" }, live), null);
});

test("the line diff rebuilds both sides with a minimal number of changed lines", () => {
  const lcs = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    return table[0][0];
  };
  let seed = 11;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let round = 0; round < 400; round += 1) {
    const make = () => Array.from({ length: Math.floor(random() * 12) }, () => "abcd"[Math.floor(random() * 4)]);
    const before = make();
    const after = make();
    const diff = diffLines(before, after);
    assert.deepEqual(diff.filter((line) => line.kind !== "added").map((line) => line.text), before);
    assert.deepEqual(diff.filter((line) => line.kind !== "removed").map((line) => line.text), after);
    assert.equal(diff.filter((line) => line.kind === "same").length, lcs(before, after));
    for (const line of diff) {
      if (line.before !== null) assert.equal(before[line.before - 1], line.text);
      if (line.after !== null) assert.equal(after[line.after - 1], line.text);
    }
  }
});

test("unchanged stretches fold around the changes, and huge inputs are declined", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[14] = "changed";
  const rows = diffRows(diffLines(before, after));
  assert.deepEqual(rows.map((row) => row.kind === "skip" ? `skip ${row.count}` : `${row.kind} ${row.before ?? "-"}/${row.after ?? "-"}`), [
    "skip 11", "same 12/12", "same 13/13", "same 14/14", "removed 15/-", "added -/15", "same 16/16", "same 17/17", "same 18/18", "skip 12"
  ]);
  assert.equal(diffLines(new Array(DIFF_LINE_LIMIT + 1).fill("x"), ["x"]), null);
  assert.equal(diffLines([], Array.from({ length: DIFF_EDIT_LIMIT + 1 }, (_, index) => `${index}`)), null);
  assert.equal(diffLines(Array.from({ length: DIFF_EDIT_LIMIT + 1 }, (_, index) => `${index}`), []), null);
  const small = diffLines([], ["a", "b"]);
  assert.deepEqual(small.map((line) => line.kind), ["added", "added"]);
});

test("the diff view renders a measured window instead of every row at once", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextDiffView.tsx", import.meta.url), "utf8");
  assert.match(source, /rows\.slice\(first, last\)/);
  assert.match(source, /offsetHeight/);
});
