import assert from "node:assert/strict";
import test from "node:test";
import {
  constrainMaterialResize,
  freeSpotBelow,
  handoffDraftKey,
  spotBeside,
  MATERIAL_MAX_SIZE,
  MATERIAL_MIN_SIZE,
  materialCardSize,
  materialsAtPoint,
  materialType,
  materialUrl
} from "../src/shared/materials.ts";

test("file names map to a kind and a served type; everything else stays a plain file", () => {
  assert.deepEqual(materialType("Hero.PNG"), { kind: "image", mimeType: "image/png" });
  assert.deepEqual(materialType("clip.mov"), { kind: "video", mimeType: "video/quicktime" });
  assert.deepEqual(materialType("voice.m4a"), { kind: "audio", mimeType: "audio/mp4" });
  assert.deepEqual(materialType("README.md"), { kind: "text", mimeType: "text/markdown" });
  assert.deepEqual(materialType("App.tsx"), { kind: "text", mimeType: "text/typescript" });
  assert.deepEqual(materialType("brief.pdf"), { kind: "pdf", mimeType: "application/pdf" });
  assert.deepEqual(materialType("archive.zip"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType(".env"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("Makefile"), { kind: "file", mimeType: "application/octet-stream" });
});

test("material URLs name the live file with its revision or one pinned version", () => {
  assert.equal(materialUrl("a1", null, 3), "canvastty-material://a1/live?r=3");
  assert.equal(materialUrl("a1", "v-2"), "canvastty-material://a1/v/v-2");
});

test("image cards keep the picture's proportions inside the default box plus the header", () => {
  assert.deepEqual(materialCardSize("image", { width: 1920, height: 1080 }), { width: 440, height: 302 });
  assert.deepEqual(materialCardSize("image", { width: 300, height: 200 }), { width: 300, height: 254 });
  assert.deepEqual(materialCardSize("image", { width: 20, height: 4000 }), { width: MATERIAL_MIN_SIZE.width, height: 494 });
  assert.deepEqual(materialCardSize("image", null), { width: 420, height: 320 });
  assert.deepEqual(materialCardSize("audio", { width: 1, height: 1 }), { width: 420, height: 170 });
});

test("several materials are laid out four per row from the drop point", () => {
  const sizes = Array.from({ length: 5 }, (_, index) => ({ width: 100, height: index === 1 ? 120 : 80 }));
  const placed = materialsAtPoint(sizes, { x: 1000, y: 500 });
  assert.equal(placed.length, 5);
  assert.deepEqual(placed[0].position, { x: 1000, y: 500 });
  assert.equal(placed[3].position.x - placed[2].position.x, 124);
  assert.deepEqual(placed[4].position, { x: 1000, y: 500 + 120 + 24 });
  assert.deepEqual(materialsAtPoint([], { x: 0, y: 0 }), []);
});

test("resizing clamps to the material limits and keeps the opposite edge", () => {
  const resized = constrainMaterialResize({ position: { x: 100, y: 100 }, size: { width: 50, height: 60 } }, "nw");
  assert.deepEqual(resized.size, MATERIAL_MIN_SIZE);
  assert.deepEqual(resized.position, { x: 150 - MATERIAL_MIN_SIZE.width, y: 160 - MATERIAL_MIN_SIZE.height });
  const huge = constrainMaterialResize({ position: { x: 0, y: 0 }, size: { width: 9000, height: 9000 } }, "se");
  assert.deepEqual(huge, { position: { x: 0, y: 0 }, size: MATERIAL_MAX_SIZE });
});

test("a new card beside the browser moves below the cards already there", () => {
  const occupied = [
    { position: { x: 1000, y: 0 }, size: { width: 400, height: 300 } },
    { position: { x: 1000, y: 324 }, size: { width: 400, height: 200 } },
    { position: { x: 2000, y: 0 }, size: { width: 400, height: 900 } }
  ];
  assert.deepEqual(freeSpotBelow({ x: 1000, y: 0 }, { width: 460, height: 580 }, occupied), { x: 1000, y: 548 });
  assert.deepEqual(freeSpotBelow({ x: 1500, y: 0 }, { width: 460, height: 580 }, occupied), { x: 1500, y: 0 });
});

test("a card made beside the browser goes to the first side where it can be seen", () => {
  const browser = { position: { x: 0, y: 0 }, size: { width: 900, height: 600 } };
  const size = { width: 460, height: 580 };
  const visible = { position: { x: -800, y: -100 }, size: { width: 2400, height: 1300 } };
  assert.deepEqual(spotBeside(browser, size, [], visible), { x: 948, y: 0 });
  const crowded = [{ position: { x: 948, y: 0 }, size: { width: 460, height: 1400 } }];
  assert.deepEqual(spotBeside(browser, size, crowded, visible), { x: -508, y: 0 });
  assert.deepEqual(spotBeside(browser, size, crowded, { position: { x: 0, y: 0 }, size: { width: 1500, height: 1300 } }), { x: 0, y: 648 });
});

test("a handoff draft key ignores id order but not content", () => {
  const base = {
    id: "d-1",
    sessionId: "s-1",
    remarkIds: ["r-2", "r-1"],
    editableMaterialIds: ["m-2", "m-1"],
    note: "fix it",
    resultsFolder: "/out"
  };
  const reordered = { ...base, remarkIds: ["r-1", "r-2"], editableMaterialIds: ["m-1", "m-2"] };
  assert.equal(handoffDraftKey(base), handoffDraftKey(reordered));
  assert.notEqual(handoffDraftKey(base), handoffDraftKey({ ...base, note: "" }));
  assert.notEqual(handoffDraftKey(base), handoffDraftKey({ ...base, remarkIds: ["r-1"] }));
  assert.notEqual(handoffDraftKey(base), handoffDraftKey({ ...base, resultsFolder: null }));
});
