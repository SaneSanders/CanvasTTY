import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { normalizeMaterialState } from "../src/main/services/materials/materialState.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

async function withService(run) {
  await withMaterials(async ({ work, service, create }) => {
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 1));
    await writeFile(join(work, "reference.png"), pngBytes(900, 600, 2));
    await service.addPaths([join(work, "hero.png"), join(work, "reference.png")], { x: 0, y: 0 });
    const [hero, reference] = service.snapshot().materials;
    await run({ service, work, hero, reference, create });
  });
}

const region = { kind: "region", x: 0.1, y: 0.2, width: 0.3, height: 0.25 };

test("a remark pins the exact version it talks about, and its reference's", async () => {
  await withService(async ({ service, hero, reference }) => {
    const result = await service.addRemark({
      materialId: hero.id,
      anchor: region,
      reference: { materialId: reference.id, anchor: { kind: "whole" } },
      text: "  Keep the text, copy the spacing.  "
    });
    assert.equal(result.ok, true);
    const { remark } = result;
    assert.equal(remark.number, 1);
    assert.equal(remark.text, "Keep the text, copy the spacing.");
    assert.equal(remark.status, "open");
    const snapshot = service.snapshot();
    const heroVersions = snapshot.materials.find((material) => material.id === hero.id).versions;
    assert.equal(heroVersions.length, 1);
    assert.deepEqual({ reason: heroVersions[0].reason, current: heroVersions[0].current, natural: heroVersions[0].natural },
      { reason: "remark", current: true, natural: { width: 1200, height: 700 } });
    assert.equal(remark.target.versionId, heroVersions[0].id);
    assert.equal(remark.reference.versionId, snapshot.materials.find((material) => material.id === reference.id).versions[0].id);
    assert.equal((await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Second" })).remark.number, 2);
  });
});

test("a pinned version stops being current once the working file changes", async () => {
  await withService(async ({ service, hero, work }) => {
    await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Fix" });
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 50));
    await service.pinVersion(hero.id);
    const versions = service.snapshot().materials.find((material) => material.id === hero.id).versions;
    assert.deepEqual(versions.map((version) => version.current), [false, true]);
  });
});

test("invalid drafts and anchors outside the picture are refused", async () => {
  await withService(async ({ service, hero }) => {
    const bad = [
      { materialId: hero.id, anchor: region, reference: null, text: "   " },
      { materialId: hero.id, anchor: { kind: "region", x: 0.8, y: 0, width: 0.5, height: 0.2 }, reference: null, text: "x" },
      { materialId: hero.id, anchor: { kind: "point", x: 2, y: 0 }, reference: null, text: "x" },
      { materialId: "missing", anchor: region, reference: null, text: "x" },
      { materialId: hero.id, anchor: region, reference: { materialId: "missing", anchor: { kind: "whole" } }, text: "x" },
      { materialId: hero.id, anchor: region, reference: null, text: "x".repeat(2_001) }
    ];
    for (const draft of bad) assert.deepEqual(await service.addRemark(draft), { ok: false, reason: "unavailable" });
    assert.equal(service.snapshot().remarks.length, 0);
  });
});

test("only a person moves a remark between accepted and reopened; text is editable until it is sent", async () => {
  await withService(async ({ service, hero }) => {
    const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Fix" });
    assert.equal((await service.updateRemark(remark.id, { text: "Fix spacing" })).remark.text, "Fix spacing");
    assert.deepEqual(await service.updateRemark(remark.id, { status: "reopened" }), { ok: false, reason: "unavailable" });
    service.markRemarksSent([remark.id], "11111111-1111-4111-8111-111111111111");
    assert.equal(service.remark(remark.id).status, "sent");
    assert.deepEqual(await service.updateRemark(remark.id, { text: "Too late" }), { ok: false, reason: "unavailable" });
    assert.equal((await service.updateRemark(remark.id, { status: "accepted" })).remark.status, "accepted");
    assert.equal((await service.updateRemark(remark.id, { status: "reopened" })).remark.status, "reopened");
    assert.equal((await service.updateRemark(remark.id, { text: "Fix spacing again" })).remark.text, "Fix spacing again");
    assert.deepEqual(await service.updateRemark(remark.id, { status: "done" }), { ok: false, reason: "unavailable" });
  });
});

test("an agent's report marks only the remarks of that handoff it names, and never accepts them", async () => {
  await withService(async ({ service, hero }) => {
    const first = (await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "One" })).remark;
    const second = (await service.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: "Two" })).remark;
    const handoffId = "22222222-2222-4222-8222-222222222222";
    service.recordHandoff({
      id: handoffId,
      number: 1,
      createdAt: 1,
      sessionId: "s1",
      sessionTitle: "Claude",
      provider: "claude",
      remarkIds: [first.id, second.id],
      items: [],
      note: "",
      folder: "/data/h",
      resultsFolder: null,
      delivery: { state: "submitted", imagesExpected: 0, imagesAttached: 0, sentAt: 1, turnStartedAt: null, turnEndedAt: null, error: null }
    });
    service.markRemarksSent([first.id, second.id], handoffId);
    assert.equal(service.applyReport(handoffId, [first.number, 99], "spacing fixed"), 1);
    assert.deepEqual({ status: service.remark(first.id).status, note: service.remark(first.id).report.note },
      { status: "reported", note: "spacing fixed" });
    assert.equal(service.remark(second.id).status, "sent");
    assert.equal(service.applyReport("33333333-3333-4333-8333-333333333333", [second.number], null), 0);
  });
});

test("removing a material removes its remarks and forgets it as a reference", async () => {
  await withService(async ({ service, hero, reference }) => {
    const own = (await service.addRemark({ materialId: reference.id, anchor: region, reference: null, text: "Own" })).remark;
    const pointing = (await service.addRemark({
      materialId: hero.id,
      anchor: region,
      reference: { materialId: reference.id, anchor: region },
      text: "Like the reference"
    })).remark;
    await service.remove(reference.id);
    assert.equal(service.remark(own.id), null);
    assert.equal(service.remark(pointing.id).reference, null);
  });
});

test("versions a remark depends on are never pruned; a full history refuses new versions instead", async () => {
  await withService(async ({ service, hero, work }) => {
    const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Keep" });
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 100 + index));
      await service.pinVersion(hero.id);
    }
    const versions = service.snapshot().materials.find((material) => material.id === hero.id).versions;
    assert.equal(versions.length, 20);
    assert.ok(versions.some((version) => version.id === remark.target.versionId));
  });
});

function handoffRecord(id, remark, hero, state) {
  return {
    id,
    number: 1,
    createdAt: 1,
    sessionId: "s1",
    sessionTitle: "Claude",
    provider: "claude",
    remarkIds: [remark.id],
    items: [{ materialId: hero.id, versionId: remark.target.versionId, editable: false }],
    note: "",
    folder: "/data/h",
    resultsFolder: null,
    delivery: { state, imagesExpected: 0, imagesAttached: 0, sentAt: 1, turnStartedAt: null, turnEndedAt: null, error: null }
  };
}

test("a version the person pinned outlives the version cap, and versions nothing needs go first", async () => {
  await withService(async ({ service, hero, work }) => {
    const pinned = await service.pinVersion(hero.id);
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 200 + index));
      const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: `Round ${index}` });
      await service.deleteRemark(remark.id);
    }
    const versions = service.material(hero.id).versions;
    assert.equal(versions.length, 20);
    assert.equal(versions[0].id, pinned.version.id);
  });
});

test("delivered handoffs stop holding versions, while one being sent still does", async () => {
  await withService(async ({ service, hero, work }) => {
    const sending = (await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "In flight" })).remark;
    service.recordHandoff(handoffRecord("88888888-8888-4888-8888-888888888888", sending, hero, "sending"));
    await service.deleteRemark(sending.id);
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 300 + index));
      const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: `Round ${index}` });
      service.recordHandoff(handoffRecord(`99999999-9999-4999-8999-${String(index).padStart(12, "0")}`, remark, hero, "submitted"));
      await service.deleteRemark(remark.id);
    }
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 400));
    assert.equal((await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Next round" })).ok, true);
    assert.ok(service.material(hero.id).versions.some((version) => version.id === sending.target.versionId));
  });
});

test("a remark is refused before any version is kept when its reference cannot be versioned", async () => {
  await withService(async ({ service, hero, reference, work }) => {
    await rm(join(work, "reference.png"));
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 500));
    assert.deepEqual(await service.addRemark({ materialId: hero.id, anchor: region, reference: { materialId: reference.id, anchor: region }, text: "Like that" }),
      { ok: false, reason: "unavailable" });
    assert.deepEqual(service.material(hero.id).versions, []);
  });
});

test("a refused status change leaves the remark text as it was", async () => {
  await withService(async ({ service, hero }) => {
    const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Fix" });
    assert.deepEqual(await service.updateRemark(remark.id, { text: "Changed", status: "reopened" }), { ok: false, reason: "unavailable" });
    assert.equal(service.remark(remark.id).text, "Fix");
  });
});

test("remarks, handoffs and counters survive a restart; an interrupted send is reported as failed", async () => {
  await withService(async ({ service, hero, create }) => {
    const { remark } = await service.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Persist me" });
    service.recordHandoff({
      id: "44444444-4444-4444-8444-444444444444",
      number: 1,
      createdAt: 1,
      sessionId: "s1",
      sessionTitle: "Codex",
      provider: "codex",
      remarkIds: [remark.id],
      items: [{ materialId: hero.id, versionId: remark.target.versionId, editable: false }],
      note: "",
      folder: "/data/h",
      resultsFolder: null,
      delivery: { state: "sending", imagesExpected: 1, imagesAttached: 0, sentAt: null, turnStartedAt: null, turnEndedAt: null, error: null }
    });
    await service.flush();
    const restored = await create();
    const snapshot = restored.snapshot();
    assert.equal(snapshot.remarks[0].text, "Persist me");
    assert.equal(snapshot.handoffs[0].delivery.state, "failed");
    assert.match(snapshot.handoffs[0].delivery.error, /closed while sending/);
    assert.equal(restored.nextHandoffNumber(), 2);
    assert.equal((await restored.addRemark({ materialId: hero.id, anchor: region, reference: null, text: "Next" })).remark.number, 2);
  });
});

test("the loader drops remarks whose material is gone and malformed handoffs", () => {
  const state = normalizeMaterialState({
    version: 1,
    materials: [],
    remarks: [{
      id: "55555555-5555-4555-8555-555555555555",
      number: 1,
      target: { materialId: "66666666-6666-4666-8666-666666666666", versionId: "77777777-7777-4777-8777-777777777777", anchor: { kind: "whole" } },
      reference: null,
      text: "orphan",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      handoffIds: [],
      report: null
    }],
    handoffs: [{ id: "bad" }],
    counters: { remark: 7, handoff: 3 }
  });
  assert.deepEqual({ remarks: state.remarks.length, handoffs: state.handoffs.length, counters: state.counters },
    { remarks: 0, handoffs: 0, counters: { remark: 7, handoff: 3 } });
});

test("a full version history still takes remarks on the unchanged file, and says so when it changed", async () => {
  await withService(async ({ service, work, hero }) => {
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 10 + index));
      assert.equal((await service.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: `v${index}` })).ok, true);
    }
    assert.equal(service.material(hero.id).versions.length, 20);
    const again = await service.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: "same file" });
    assert.equal(again.ok, true);
    assert.equal(again.remark.target.versionId, service.material(hero.id).versions.at(-1).id);
    await writeFile(join(work, "hero.png"), pngBytes(1200, 700, 99));
    assert.deepEqual(await service.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: "changed" }),
      { ok: false, reason: "version-limit" });
  });
});
