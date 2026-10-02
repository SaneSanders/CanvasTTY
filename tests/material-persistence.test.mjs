import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { normalizeMaterialState } from "../src/main/services/materials/materialState.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

async function withStore(run) {
  await withMaterials(async ({ userData, create, setPersist }) => {
    const capture = async (service, index) => (await service.addCapture({
      bytes: pngBytes(64, 64, index + 1),
      name: `shot-${index}.png`,
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 0, y: 0 },
      natural: { width: 64, height: 64 }
    })).materialId;
    const files = async (folder) => (await readdir(join(userData, "materials", folder)).catch(() => [])).sort();
    await run({ userData, create, capture, files, setPersist });
  });
}

test("a state file that cannot be parsed is moved aside and its versions outlive the run", async () => {
  await withStore(async ({ userData, create, capture, files }) => {
    const first = create();
    await first.load();
    await capture(first, 1);
    await first.dispose();
    const blobs = await files("versions");
    const statePath = join(userData, "materials", "state.json");
    const text = await readFile(statePath, "utf8");
    await writeFile(statePath, text.slice(0, text.length / 2));
    const second = create();
    await second.load();
    assert.deepEqual(second.snapshot().materials, []);
    assert.deepEqual(await files("versions"), blobs);
    const aside = (await readdir(join(userData, "materials"))).find((name) => name.startsWith("state.json.broken-"));
    assert.equal(await readFile(join(userData, "materials", aside), "utf8"), text.slice(0, text.length / 2));
    await capture(second, 2);
    await second.dispose();
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).materials.length, 1);
  });
});

test("a state file from a newer CanvasTTY or one that cannot be read is never overwritten or collected", async () => {
  await withStore(async ({ userData, create, capture, files }) => {
    const first = create();
    await first.load();
    await capture(first, 1);
    await first.dispose();
    const blobs = await files("versions");
    const statePath = join(userData, "materials", "state.json");
    const newer = JSON.stringify({ ...JSON.parse(await readFile(statePath, "utf8")), version: 99 });
    await writeFile(statePath, newer);
    const second = create();
    await second.load();
    await capture(second, 2);
    await second.dispose();
    assert.equal(await readFile(statePath, "utf8"), newer);
    assert.deepEqual((await files("versions")).filter((blob) => blobs.includes(blob)), blobs);
    await rm(statePath);
    await mkdir(statePath);
    const third = create();
    await third.load();
    await capture(third, 3);
    await third.dispose();
    assert.deepEqual((await files("versions")).filter((blob) => blobs.includes(blob)), blobs);
    assert.deepEqual(await readdir(statePath), []);
  });
});

test("quitting during load or during an operation keeps everything that was stored", async () => {
  await withStore(async ({ userData, create, capture }) => {
    const first = create();
    await first.load();
    for (let index = 0; index < 6; index += 1) {
      const id = await capture(first, index);
      await first.addRemark({ materialId: id, anchor: { kind: "whole" }, reference: null, text: `Remark ${index}` });
    }
    await first.dispose();
    const statePath = join(userData, "materials", "state.json");
    const stored = await readFile(statePath, "utf8");
    const second = create();
    const loading = second.load();
    await new Promise((resolve) => setImmediate(resolve));
    await second.flush();
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).remarks.length, 6);
    await second.dispose();
    await loading;
    assert.equal(await readFile(statePath, "utf8"), stored);
    const third = create();
    await third.load();
    const pending = capture(third, 7);
    await third.dispose();
    await pending;
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.materials.length, 7);
    assert.equal(saved.remarks.length, 6);
  });
});

test("with saving off nothing captured or packaged stays on disk after exit", async () => {
  await withStore(async ({ userData, create, capture, files, setPersist }) => {
    setPersist(false);
    const service = create();
    await service.load();
    await capture(service, 1);
    await mkdir(join(service.handoffsPath, "a"), { recursive: true });
    await writeFile(join(service.handoffsPath, "a", "handoff.md"), "remark text");
    await service.dispose();
    assert.deepEqual(await files("versions"), []);
    assert.deepEqual(await files("handoffs"), []);
    assert.deepEqual(JSON.parse(await readFile(join(userData, "materials", "state.json"), "utf8")).materials, []);
  });
});

test("an odd entry in the drafts folder does not stop loading", async () => {
  await withStore(async ({ userData, create }) => {
    await mkdir(join(userData, "materials", "drafts", "folder.json"), { recursive: true });
    const service = create();
    await service.load();
    assert.deepEqual(service.snapshot().materials, []);
  });
});

test("numbers past the safe integer range are dropped from stored state", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [],
    remarks: [],
    handoffs: [],
    counters: { remark: 2 ** 60, handoff: 3 }
  });
  assert.deepEqual(state.counters, { remark: 0, handoff: 3 });
});
