import assert from "node:assert/strict";
import { rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { describeAnchor } from "../src/main/services/materials/handoffText.ts";
import { formatClock } from "../src/shared/materials.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

async function withMedia(run) {
  await withMaterials(async ({ work, service }) => {
    await writeFile(join(work, "intro.mp4"), Buffer.from("not really a movie"));
    await writeFile(join(work, "voice.m4a"), Buffer.from("not really audio"));
    await writeFile(join(work, "shot.png"), pngBytes(10, 10));
    await writeFile(join(work, "brief.pdf"), Buffer.from("%PDF-1.4 not really a pdf"));
    await service.addPaths(["intro.mp4", "voice.m4a", "shot.png", "brief.pdf"].map((name) => join(work, name)), { x: 0, y: 0 });
    const byName = (name) => service.snapshot().materials.find((material) => material.name === name);
    await run({ service, work, video: byName("intro.mp4"), audio: byName("voice.m4a"), image: byName("shot.png"), pdf: byName("brief.pdf") });
  });
}

test("moments and spans belong to video and audio and must run forward", async () => {
  await withMedia(async ({ service, video, audio, image }) => {
    const moment = await service.addRemark({ materialId: video.id, anchor: { kind: "time", start: 12.3, end: null }, reference: null, text: "Logo is blurry here" });
    assert.deepEqual(moment.remark.target.anchor, { kind: "time", start: 12.3, end: null });
    assert.equal((await service.addRemark({ materialId: audio.id, anchor: { kind: "time", start: 3, end: 7.5 }, reference: null, text: "Too quiet" })).ok, true);
    assert.deepEqual(await service.addRemark({ materialId: image.id, anchor: { kind: "time", start: 1, end: null }, reference: null, text: "x" }),
      { ok: false, reason: "kind-mismatch" });
    assert.equal((await service.addRemark({ materialId: video.id, anchor: { kind: "time", start: 5, end: 5 }, reference: null, text: "x" })).ok, false);
    assert.equal((await service.addRemark({ materialId: video.id, anchor: { kind: "time", start: -1, end: null }, reference: null, text: "x" })).ok, false);
  });
});

test("a captured frame becomes an image that remembers its video and moment", async () => {
  await withMedia(async ({ service, video, image }) => {
    const frame = await service.captureFrame(video.id, 72.4, pngBytes(640, 360), { width: 640, height: 360 }, { x: 10, y: 10 });
    assert.equal(frame.ok, true);
    const material = service.material(frame.materialId);
    assert.deepEqual({ kind: material.kind, name: material.name, origin: material.origin, natural: material.versions[0].natural }, {
      kind: "image",
      name: "intro 1-12.4.png",
      origin: { kind: "frame", sourceId: video.id, sourceName: "intro.mp4", time: 72.4 },
      natural: { width: 640, height: 360 }
    });
    const again = await service.captureFrame(video.id, 80, pngBytes(640, 360), { width: 640, height: 360 }, { x: 10, y: 10 });
    const first = service.material(frame.materialId);
    const second = service.material(again.materialId);
    assert.ok(second.position.y >= first.position.y + first.size.height, "the next frame goes below the previous one");
    assert.deepEqual(await service.captureFrame(image.id, 1, pngBytes(10, 10), { width: 10, height: 10 }, { x: 0, y: 0 }), { ok: false, reason: "unavailable" });
    assert.deepEqual(await service.captureFrame(video.id, Number.NaN, pngBytes(10, 10), { width: 10, height: 10 }, { x: 0, y: 0 }), { ok: false, reason: "unavailable" });
    assert.deepEqual(await service.captureFrame(video.id, 7 * 24 * 3600 + 1, pngBytes(10, 10), { width: 10, height: 10 }, { x: 0, y: 0 }), { ok: false, reason: "unavailable" });
  });
});

test("times read as a clock in handoffs", () => {
  assert.equal(describeAnchor({ kind: "time", start: 12, end: null }, null, "en"), "at 0:12");
  assert.equal(describeAnchor({ kind: "time", start: 62, end: 75.55 }, null, "en"), "1:02–1:15.6");
  assert.equal(describeAnchor({ kind: "time", start: 3725, end: null }, null, "ru"), "момент 1:02:05");
  assert.deepEqual([0, 9.96, 59.95, 600].map(formatClock), ["0:00", "0:10", "1:00", "10:00"]);
});

test("a PDF takes page remarks, and a rendered page becomes an image that remembers its page", async () => {
  await withMedia(async ({ service, pdf, image }) => {
    const remark = await service.addRemark({ materialId: pdf.id, anchor: { kind: "page", page: 3 }, reference: null, text: "Typo in the heading" });
    assert.deepEqual(remark.remark.target.anchor, { kind: "page", page: 3 });
    assert.deepEqual(await service.addRemark({ materialId: image.id, anchor: { kind: "page", page: 1 }, reference: null, text: "x" }), { ok: false, reason: "kind-mismatch" });
    assert.equal((await service.addRemark({ materialId: pdf.id, anchor: { kind: "page", page: 0 }, reference: null, text: "x" })).ok, false);
    const shot = { base64: pngBytes(1190, 1684).toString("base64"), mimeType: "image/png" };
    const page = await service.capturePdfPage({ materialId: pdf.id, page: 3, shot, point: { x: 0, y: 0 } });
    assert.deepEqual(service.material(page.materialId).origin, { kind: "pdf-page", sourceId: pdf.id, sourceName: "brief.pdf", page: 3 });
    assert.equal(service.material(page.materialId).name, "brief p3.png");
    assert.deepEqual(await service.capturePdfPage({ materialId: image.id, page: 1, shot, point: { x: 0, y: 0 } }), { ok: false, reason: "unavailable" });
    assert.deepEqual(await service.capturePdfPage({ materialId: pdf.id, page: 100_001, shot, point: { x: 0, y: 0 } }), { ok: false, reason: "unavailable" });
    assert.equal(describeAnchor({ kind: "page", page: 3 }, null, "en"), "page 3");
  });
});

test("PDF bytes reach the viewer only for the granted file itself", async () => {
  await withMedia(async ({ service, work, pdf, image }) => {
    const read = await service.readPdf(pdf.id);
    assert.equal(Buffer.from(read.bytes).toString(), "%PDF-1.4 not really a pdf");
    assert.deepEqual(await service.readPdf(image.id), { ok: false, reason: "unavailable" });
    await writeFile(join(work, "other.pdf"), Buffer.from("%PDF-1.4 someone else"));
    await unlink(join(work, "brief.pdf"));
    await symlink(join(work, "other.pdf"), join(work, "brief.pdf"));
    assert.deepEqual(await service.readPdf(pdf.id), { ok: false, reason: "unreadable" });
  });
});
