import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SPAN_PERCENT, timeMarkers } from "../src/renderer/src/features/materials/mediaModel.ts";

const remark = (number, anchor, overrides = {}) => ({
  id: `r${number}`,
  number,
  status: "open",
  target: { materialId: "m", versionId: "v1", anchor },
  ...overrides
});

test("time remarks sit on the timeline by share of the duration, clamped to its end", () => {
  const markers = timeMarkers([
    remark(1, { kind: "time", start: 30, end: null }),
    remark(2, { kind: "time", start: 90, end: 150 }, { status: "sent", target: { materialId: "m", versionId: "old", anchor: { kind: "time", start: 90, end: 150 } } }),
    remark(3, { kind: "time", start: 119.9, end: 120 }),
    remark(4, { kind: "whole" })
  ], 120, new Set(["old"]));
  assert.deepEqual(markers.map(({ number, left, width, label, stale }) => ({ number, left: Math.round(left * 10) / 10, width: width === null ? null : Math.round(width * 10) / 10, label, stale })), [
    { number: 1, left: 25, width: null, label: "0:30", stale: false },
    { number: 2, left: 75, width: 25, label: "1:30–2:00", stale: true },
    { number: 3, left: 99.9, width: MIN_SPAN_PERCENT, label: "1:59.9–2:00", stale: false }
  ]);
  assert.deepEqual(timeMarkers([remark(1, { kind: "time", start: 1, end: null })], null, new Set()), []);
});
