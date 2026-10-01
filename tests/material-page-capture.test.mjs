import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SCENARIO_STEP_LIMIT } from "../src/shared/materials.ts";
import { elementsInArea, pageUrl } from "../src/main/services/materials/pageCapture.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

const shot = (extra = 0) => ({ base64: pngBytes(1648, 860, extra).toString("base64"), mimeType: "image/png" });
const buy = { role: "button", name: "Buy now", bounds: { x: 32, y: 369, width: 520, height: 48 } };
const email = { role: "textbox", name: "Email", bounds: { x: 32, y: 223, width: 520, height: 43 } };

test("a page capture keeps the page address without its query, the viewport and the visible elements", async () => {
  await withMaterials(async ({ service }) => {
    const result = await service.captureBrowser({
      url: "http://127.0.0.1:8765/index.html?token=secret#pay",
      title: "Acme store",
      viewport: { width: 893, height: 466 },
      elements: [buy, email, { role: "link", name: "x".repeat(500), bounds: { x: 1, y: 2, width: 3, height: 4 } }, { role: "bad", name: "no bounds" }],
      shot: shot(),
      point: { x: 10, y: 20 }
    });
    assert.equal(result.ok, true);
    const material = service.material(result.materialId);
    assert.deepEqual({ kind: material.kind, name: material.name, natural: material.versions[0].natural },
      { kind: "image", name: "Acme store.png", natural: { width: 1648, height: 860 } });
    assert.equal(material.origin.url, "http://127.0.0.1:8765/index.html");
    assert.deepEqual(material.origin.elements.map((element) => [element.role, element.name.length]), [["button", 7], ["textbox", 5], ["link", 200]]);
  });
});

test("captures from anything but an http page, or with bytes that are not the claimed image, are refused", async () => {
  await withMaterials(async ({ service }) => {
    const base = { url: "https://example.com/", title: "", viewport: { width: 800, height: 600 }, elements: [], shot: shot(), point: { x: 0, y: 0 } };
    assert.equal((await service.captureBrowser({ ...base, url: "file:///etc/passwd" })).ok, false);
    assert.equal((await service.captureBrowser({ ...base, shot: { base64: shot().base64, mimeType: "image/jpeg" } })).ok, false);
    assert.equal((await service.captureBrowser({ ...base, shot: { base64: "not base64!", mimeType: "image/png" } })).ok, false);
    assert.equal((await service.captureBrowser({ ...base, viewport: { width: 0, height: 600 } })).ok, false);
    assert.equal(service.snapshot().materials.length, 0);
    assert.equal(pageUrl("javascript:alert(1)"), null);
  });
});

test("a recorded scenario keeps facts and the person's expectation apart and becomes a version when stopped", async () => {
  await withMaterials(async ({ service }) => {
    const started = await service.startScenario({ url: "http://127.0.0.1:8765/index.html?ref=x", title: "Acme store", viewport: { width: 893, height: 466 }, point: { x: 0, y: 0 } });
    const id = started.materialId;
    assert.deepEqual(await service.addScenarioStep(id, { kind: "start", url: "http://127.0.0.1:8765/index.html?ref=x", title: "Acme store", point: null, element: null, text: null, shot: shot(1) }), { ok: true });
    assert.deepEqual(await service.addScenarioStep(id, { kind: "click", url: "http://127.0.0.1:8765/index.html", title: "Acme store", point: { x: 72, y: 389 }, element: { role: "button", name: "Buy now" }, text: "ignored", shot: shot(2) }), { ok: true });
    assert.equal((await service.addScenarioStep(id, { kind: "expectation", url: null, title: null, point: null, element: null, text: "   ", shot: null })).ok, false);
    assert.deepEqual(await service.addScenarioStep(id, { kind: "expectation", url: null, title: null, point: null, element: null, text: "A thank-you message appears.", shot: shot(3) }), { ok: true });
    const recording = service.material(id);
    assert.deepEqual({ kind: recording.kind, live: recording.state, state: recording.scenario.state, versions: recording.versions.length },
      { kind: "scenario", live: "ready", state: "recording", versions: 0 });
    assert.deepEqual(recording.scenario.steps.map((step) => [step.kind, step.url, step.text, step.image?.natural.width ?? null]), [
      ["start", "http://127.0.0.1:8765/index.html", null, 1648],
      ["click", "http://127.0.0.1:8765/index.html", null, 1648],
      ["expectation", null, "A thank-you message appears.", 1648]
    ]);
    assert.deepEqual(await service.stopScenario(id, "stopped"), { ok: true });
    const done = service.material(id);
    assert.deepEqual({ state: done.scenario.state, reason: done.scenario.stopReason, versions: done.versions.length }, { state: "done", reason: "stopped", versions: 1 });
    assert.equal((await service.addScenarioStep(id, { kind: "click", url: null, title: null, point: null, element: null, text: null, shot: null })).ok, false);
    const response = await service.protocolResponse(new Request(`canvastty-material://${id}/step/1`));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes(1648, 860, 2));
    const remark = await service.addRemark({ materialId: id, anchor: { kind: "whole" }, reference: null, text: "Show the thank-you message" });
    assert.equal(remark.ok, true);
    const exported = JSON.parse(await readFile(service.versionFile(id, remark.remark.target.versionId).path, "utf8"));
    assert.deepEqual(exported.steps.map((step) => step.kind), ["start", "click", "expectation"]);
  });
});

const click = (x) => ({ kind: "click", url: null, title: null, point: { x, y: 0 }, element: null, text: null, shot: null });
const start = { url: "https://example.com/", title: "", viewport: { width: 800, height: 600 }, point: { x: 0, y: 0 } };
const summary = (material) => ({ state: material.scenario.state, reason: material.scenario.stopReason, steps: material.scenario.steps.length, versions: material.versions.length });

test("a page title that is really a URL loses its query, and titles with slashes keep their words", async () => {
  await withMaterials(async ({ service }) => {
    const leaked = await service.captureBrowser({
      url: "https://files.example.com/export/report.json?X-Amz-Signature=deadbeef",
      title: "files.example.com/export/report.json?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef",
      viewport: { width: 800, height: 600 },
      elements: [],
      shot: shot(3),
      point: { x: 0, y: 0 }
    });
    const material = service.material(leaked.materialId);
    assert.equal(material.name, "files.example.com export report.json.png");
    assert.equal(material.origin.title, "files.example.com/export/report.json");
    const titled = await service.captureBrowser({
      url: "https://github.com/owner/repo/pull/1",
      title: "owner/repo: Fix login? #1",
      viewport: { width: 800, height: 600 },
      elements: [],
      shot: shot(4),
      point: { x: 0, y: 0 }
    });
    assert.equal(service.material(titled.materialId).name, "owner repo: Fix login? #1.png");
  });
});

test("a recording ends itself at its step limit, and one cut short by quitting is closed and kept on the next start", async () => {
  await withMaterials(async ({ service, create }) => {
    const full = (await service.startScenario(start)).materialId;
    for (let index = 0; index < SCENARIO_STEP_LIMIT; index += 1) assert.equal((await service.addScenarioStep(full, click(index))).ok, true);
    assert.deepEqual(summary(service.material(full)), { state: "done", reason: "limit", steps: SCENARIO_STEP_LIMIT, versions: 1 });
    assert.deepEqual(await service.addScenarioStep(full, click(99)), { ok: false, reason: "unavailable" });
    assert.deepEqual(await service.stopScenario(full, "stopped"), { ok: true });
    assert.deepEqual(summary(service.material(full)), { state: "done", reason: "limit", steps: SCENARIO_STEP_LIMIT, versions: 1 });
    const cut = (await service.startScenario(start)).materialId;
    await service.addScenarioStep(cut, click(1));
    await service.flush();
    const restarted = await create();
    assert.deepEqual(summary(restarted.material(cut)), { state: "done", reason: "app-closed", steps: 1, versions: 1 });
  });
});

test("a recording past its time limit ends instead of taking more steps", async () => {
  let now = 1_000;
  await withMaterials(async ({ service }) => {
    const { materialId } = await service.startScenario(start);
    now += 16 * 60 * 1000;
    assert.deepEqual(await service.addScenarioStep(materialId, click(1)), { ok: false, reason: "unavailable" });
    assert.deepEqual(summary(service.material(materialId)), { state: "done", reason: "limit", steps: 0, versions: 1 });
  }, { now: () => now });
});

test("with version storage full a step is kept without its screenshot, and a stop that cannot seal still ends the recording", async () => {
  await withMaterials(async ({ service }) => {
    const { materialId } = await service.startScenario(start);
    assert.deepEqual(await service.addScenarioStep(materialId, { ...click(1), shot: shot(1) }), { ok: true });
    assert.equal(service.material(materialId).scenario.steps[0].image, null);
    assert.deepEqual(await service.stopScenario(materialId, "stopped"), { ok: false, reason: "quota" });
    assert.deepEqual(summary(service.material(materialId)), { state: "done", reason: "stopped", steps: 1, versions: 0 });
    assert.deepEqual(await service.stopScenario(materialId, "stopped"), { ok: false, reason: "quota" });
    assert.deepEqual(await service.addRemark({ materialId, anchor: { kind: "whole" }, reference: null, text: "Too full" }), { ok: false, reason: "quota" });
  }, { storageLimitBytes: 10 });
});

test("screenshots of steps survive clean-ups while the scenario exists and go with it", async () => {
  await withMaterials(async ({ root, service }) => {
    const { materialId } = await service.startScenario({ url: "https://example.com/", title: "", viewport: { width: 800, height: 600 }, point: { x: 0, y: 0 } });
    await service.addScenarioStep(materialId, { kind: "start", url: null, title: null, point: null, element: null, text: null, shot: shot(7) });
    await writeFile(join(root, "other.png"), pngBytes(10, 10));
    await service.addPaths([join(root, "other.png")], { x: 0, y: 0 });
    const other = service.snapshot().materials.find((material) => material.name === "other.png");
    await service.pinVersion(other.id);
    await service.remove(other.id);
    assert.equal((await service.protocolResponse(new Request(`canvastty-material://${materialId}/step/0`))).status, 200);
    assert.ok(service.snapshot().storage.usedBytes > 0);
    await service.remove(materialId);
    assert.equal(service.snapshot().storage.usedBytes, 0);
  });
});

test("the elements named for an area are the ones it covers most, and for a point the innermost", () => {
  const viewport = { width: 893, height: 466 };
  const card = { role: "group", name: "Card", bounds: { x: 0, y: 200, width: 600, height: 240 } };
  const region = { kind: "region", x: 32 / 893, y: 360 / 466, width: 300 / 893, height: 60 / 466 };
  assert.deepEqual(elementsInArea([email, buy, card], region, viewport).map((element) => element.name), ["Buy now", "Card"]);
  assert.deepEqual(elementsInArea([card, buy], { kind: "point", x: 72 / 893, y: 389 / 466 }, viewport).map((element) => element.name), ["Buy now", "Card"]);
  assert.deepEqual(elementsInArea([buy], { kind: "whole" }, viewport), []);
});
