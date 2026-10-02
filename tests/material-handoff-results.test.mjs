import assert from "node:assert/strict";
import { mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HandoffResults, parseReport, RESULT_FILE_LIMIT } from "../src/main/services/materials/HandoffResults.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

async function withResults(run) {
  await withMaterials(async ({ root, work, service: materials }) => {
    const results = join(work, "results");
    await mkdir(results);
    await writeFile(join(work, "hero.png"), pngBytes(640, 480, 1));
    await materials.addPaths([join(work, "hero.png")], { x: 100, y: 50 });
    const hero = materials.snapshot().materials[0];
    const remark = (await materials.addRemark({ materialId: hero.id, anchor: { kind: "whole" }, reference: null, text: "Fix" })).remark;
    const sentAt = Date.now();
    const handoff = {
      id: "11111111-1111-4111-8111-111111111111",
      number: 4,
      createdAt: sentAt,
      sessionId: "s1",
      sessionTitle: "Claude",
      provider: "claude",
      remarkIds: [remark.id],
      items: [],
      note: "",
      folder: join(root, "h"),
      resultsFolder: results,
      delivery: { state: "submitted", imagesExpected: 0, imagesAttached: 0, sentAt, turnStartedAt: null, turnEndedAt: null, error: null }
    };
    materials.recordHandoff(handoff);
    materials.markRemarksSent([remark.id], handoff.id);
    const watcher = new HandoffResults({ materials, watchFactory: () => ({ close() {} }), pollIntervalMs: 0 });
    try {
      await run({ materials, watcher, handoff, results, remark, hero, sentAt });
    } finally {
      watcher.dispose();
    }
  });
}

test("files an agent saves after the handoff appear next to the remarked material with their provenance", async () => {
  await withResults(async ({ materials, watcher, handoff, results, hero, sentAt }) => {
    await writeFile(join(results, "before.png"), pngBytes(640, 480, 2));
    await utimes(join(results, "before.png"), new Date(sentAt - 60_000), new Date(sentAt - 60_000));
    await writeFile(join(results, ".hidden.png"), pngBytes(640, 480, 3));
    await writeFile(join(results, "draft.png.part"), pngBytes(640, 480, 4));
    await writeFile(join(results, "hero-fixed.png"), pngBytes(640, 480, 5));
    watcher.arm(handoff);
    await watcher.scanNow(handoff.id);
    const added = materials.snapshot().materials.filter((material) => material.origin?.kind === "result");
    assert.deepEqual(added.map((material) => material.name), ["hero-fixed.png"]);
    assert.deepEqual(added[0].origin, { kind: "result", folderName: "results", handoff: { id: handoff.id, number: 4 } });
    assert.equal(added[0].position.x, hero.position.x + hero.size.width + 48);
    await watcher.scanNow(handoff.id);
    assert.equal(materials.snapshot().materials.length, 2);
  });
});

test("the agent's report file marks the remarks it names as reported, never as accepted", async () => {
  await withResults(async ({ materials, watcher, handoff, results, remark }) => {
    watcher.arm(handoff);
    await writeFile(join(results, "canvastty-report-4.json"), JSON.stringify({ fixed: ["#1"], note: "Spacing matches the reference now." }));
    await writeFile(join(results, "canvastty-report-9.json"), JSON.stringify({ fixed: [1] }));
    await watcher.scanNow(handoff.id);
    assert.deepEqual({ status: materials.remark(remark.id).status, note: materials.remark(remark.id).report.note },
      { status: "reported", note: "Spacing matches the reference now." });
    assert.equal(materials.snapshot().materials.length, 1, "report files are not shown as results");
  });
});

test("a report is applied once, even after a restart re-reads it, and may start with a byte order mark", async () => {
  await withResults(async ({ materials, watcher, handoff, results, remark }) => {
    watcher.arm(handoff);
    await writeFile(join(results, "canvastty-report-4.json"), `\ufeff${JSON.stringify({ fixed: [1], note: "Done." })}`);
    await watcher.scanNow(handoff.id);
    const first = materials.remark(remark.id);
    assert.deepEqual({ status: first.status, note: first.report.note }, { status: "reported", note: "Done." });
    const restarted = new HandoffResults({ materials, watchFactory: () => ({ close() {} }), pollIntervalMs: 0, now: () => Date.now() + 60_000 });
    try {
      restarted.restore(materials.snapshot().handoffs);
      await restarted.scanNow(handoff.id);
      assert.deepEqual(materials.remark(remark.id).report, first.report);
      assert.equal(materials.remark(remark.id).updatedAt, first.updatedAt);
    } finally {
      restarted.dispose();
    }
  });
});

test("a report for a handoff that was only pasted confirms it was sent", async () => {
  await withResults(async ({ materials, watcher, handoff, results, remark }) => {
    const pasted = { ...handoff, id: "33333333-3333-4333-8333-333333333333", number: 5, delivery: { ...handoff.delivery, state: "pasted", note: "not-observed" } };
    materials.recordHandoff(pasted);
    watcher.arm(pasted);
    await writeFile(join(results, "canvastty-report-5.json"), JSON.stringify({ fixed: [1] }));
    await watcher.scanNow(pasted.id);
    assert.deepEqual({ state: materials.handoff(pasted.id).delivery.state, note: materials.handoff(pasted.id).delivery.note }, { state: "submitted", note: null });
    assert.deepEqual({ status: materials.remark(remark.id).status, last: materials.remark(remark.id).handoffIds.at(-1) }, { status: "reported", last: pasted.id });
  });
});

test("a handoff contributes a bounded number of result cards", async () => {
  await withResults(async ({ materials, watcher, handoff, results }) => {
    for (let index = 0; index < RESULT_FILE_LIMIT + 5; index += 1) await writeFile(join(results, `shot-${String(index).padStart(2, "0")}.png`), pngBytes(640, 480, 10 + index));
    watcher.arm(handoff);
    await watcher.scanNow(handoff.id);
    assert.equal(materials.snapshot().materials.filter((material) => material.origin?.kind === "result").length, RESULT_FILE_LIMIT);
  });
});

test("handoffs that were not delivered, or have no results folder, are not watched", async () => {
  await withResults(async ({ materials, watcher, handoff, results }) => {
    await writeFile(join(results, "late.png"), pngBytes(640, 480, 9));
    watcher.arm({ ...handoff, id: "22222222-2222-4222-8222-222222222222", delivery: { ...handoff.delivery, state: "failed" } });
    watcher.arm({ ...handoff, id: "33333333-3333-4333-8333-333333333333", resultsFolder: null });
    await watcher.scanNow("22222222-2222-4222-8222-222222222222");
    await watcher.scanNow("33333333-3333-4333-8333-333333333333");
    assert.equal(materials.snapshot().materials.length, 1);
  });
});

async function touch(path, bytes, at) {
  await writeFile(path, bytes);
  await utimes(path, new Date(at), new Date(at));
}

function resultsOf(materials) {
  return materials.snapshot().materials.filter((material) => material.origin?.kind === "result")
    .map((material) => ({ name: material.name, handoff: material.origin.handoff?.number ?? null }));
}

function nextHandoff(handoff, sentAt) {
  return { ...handoff, id: "55555555-5555-4555-8555-555555555555", number: 5, delivery: { ...handoff.delivery, sentAt } };
}

test("a result file the next handoff's agent rewrites becomes that handoff's result", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 5), sentAt + 1_000);
    await watcher.scanNow(handoff.id);
    materials.updateHandoffDelivery(handoff.id, { turnStartedAt: sentAt + 100, turnEndedAt: sentAt + 5_000 });
    const next = nextHandoff(handoff, sentAt + 60_000);
    materials.recordHandoff(next);
    watcher.arm(next);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 6), sentAt + 61_000);
    await watcher.scanNow(next.id);
    assert.deepEqual(resultsOf(materials), [{ name: "hero-fixed.png", handoff: 5 }]);
  });
});

test("a change no single handoff turn explains leaves the card without a handoff", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 5), sentAt + 1_000);
    await watcher.scanNow(handoff.id);
    materials.updateHandoffDelivery(handoff.id, { turnStartedAt: sentAt + 100, turnEndedAt: sentAt + 5_000 });
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 6), sentAt + 30_000);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(resultsOf(materials), [{ name: "hero-fixed.png", handoff: null }]);

    const next = nextHandoff(handoff, sentAt + 60_000);
    const third = { ...nextHandoff(handoff, sentAt + 61_000), id: "66666666-6666-4666-8666-666666666666", number: 6 };
    materials.recordHandoff(next);
    materials.recordHandoff(third);
    watcher.arm(next);
    watcher.arm(third);
    await touch(join(results, "both.png"), pngBytes(640, 480, 7), sentAt + 62_000);
    await watcher.scanNow(next.id);
    assert.deepEqual(resultsOf(materials).find((result) => result.name === "both.png"), { name: "both.png", handoff: null });
  });
});

test("a removed result card comes back only when its file changes again", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 5), sentAt + 1_000);
    await watcher.scanNow(handoff.id);
    await materials.remove(materials.snapshot().materials.find((material) => material.origin?.kind === "result").id);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(resultsOf(materials), []);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 6), sentAt + 2_000);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(resultsOf(materials), [{ name: "hero-fixed.png", handoff: 4 }]);
  });
});

test("after a restart removed result cards stay removed and provenance still follows the files", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "kept.png"), pngBytes(640, 480, 5), sentAt + 1_000);
    await touch(join(results, "removed.png"), pngBytes(640, 480, 6), sentAt + 1_000);
    await watcher.scanNow(handoff.id);
    await materials.remove(materials.snapshot().materials.find((material) => material.name === "removed.png").id);
    materials.updateHandoffDelivery(handoff.id, { turnStartedAt: sentAt + 100, turnEndedAt: sentAt + 5_000 });
    watcher.dispose();
    await touch(join(results, "kept.png"), pngBytes(640, 480, 7), sentAt + 20_000);
    const restarted = new HandoffResults({ materials, watchFactory: () => ({ close() {} }), pollIntervalMs: 0 });
    try {
      restarted.restore(materials.snapshot().handoffs);
      await restarted.scanNow(handoff.id);
      assert.deepEqual(resultsOf(materials), [{ name: "kept.png", handoff: null }]);
    } finally {
      restarted.dispose();
    }
  });
});

test("a turn cut short by quitting does not claim files changed after the restart", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 5), sentAt + 1_000);
    await watcher.scanNow(handoff.id);
    watcher.dispose();
    await touch(join(results, "hero-fixed.png"), pngBytes(640, 480, 6), sentAt + 20_000);
    const restarted = new HandoffResults({ materials, watchFactory: () => ({ close() {} }), pollIntervalMs: 0, now: () => sentAt + 10_000 });
    try {
      restarted.restore(materials.snapshot().handoffs);
      await restarted.scanNow(handoff.id);
      assert.deepEqual(resultsOf(materials), [{ name: "hero-fixed.png", handoff: null }]);
    } finally {
      restarted.dispose();
    }
  });
});

test("a turn that is never seen ends when the same session gets the next handoff, or after two hours", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    const next = nextHandoff(handoff, sentAt + 60_000);
    materials.recordHandoff(next);
    watcher.arm(next);
    await touch(join(results, "later.png"), pngBytes(640, 480, 5), sentAt + 90_000);
    await watcher.scanNow(next.id);
    assert.deepEqual(resultsOf(materials), [{ name: "later.png", handoff: 5 }]);
  });
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    watcher.arm(handoff);
    await touch(join(results, "much-later.png"), pngBytes(640, 480, 6), sentAt + 3 * 60 * 60 * 1000);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(resultsOf(materials), [{ name: "much-later.png", handoff: null }]);
  });
});

test("links in the results folder are not followed", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    const outside = join(results, "..", "private.png");
    await touch(outside, pngBytes(640, 480, 7), sentAt + 1_000);
    await symlink(outside, join(results, "link.png"));
    watcher.arm(handoff);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(resultsOf(materials), []);
  });
});

test("results never reach outside the granted folder, even when the agent swaps it or a file for a link", async () => {
  await withResults(async ({ materials, watcher, handoff, results, sentAt }) => {
    const outside = join(results, "..", "outside");
    await mkdir(outside);
    await writeFile(join(outside, "credentials.txt"), "secret\n");
    await utimes(join(outside, "credentials.txt"), new Date(sentAt + 1_000), new Date(sentAt + 1_000));
    watcher.arm(handoff);
    await rename(results, `${results}-gone`);
    await symlink(outside, results);
    await watcher.scanNow(handoff.id);
    assert.deepEqual(materials.snapshot().materials.filter((material) => material.origin?.kind === "result"), []);
    await rm(results);
    await rename(`${results}-gone`, results);
    await writeFile(join(results, "after.png"), pngBytes(640, 480, 8));
    await watcher.scanNow(handoff.id);
    assert.deepEqual(materials.snapshot().materials.filter((material) => material.origin?.kind === "result"), []);
  });
  await withResults(async ({ materials, handoff, results, sentAt }) => {
    const outside = join(results, "..", "id_rsa.txt");
    await writeFile(outside, "key\n");
    await writeFile(join(results, "fixed.txt"), "result\n");
    await utimes(join(results, "fixed.txt"), new Date(sentAt + 1_000), new Date(sentAt + 1_000));
    const racing = new Proxy(materials, {
      get(target, key) {
        if (key === "retagResults") {
          return async (paths, origin, folder) => {
            for (const path of paths) {
              await rm(path, { force: true });
              await symlink(outside, path);
            }
            return target.retagResults(paths, origin, folder);
          };
        }
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const watcher = new HandoffResults({ materials: racing, watchFactory: () => ({ close() {} }), pollIntervalMs: 0 });
    try {
      watcher.arm(handoff);
      await watcher.scanNow(handoff.id);
      assert.deepEqual(materials.snapshot().materials.filter((material) => material.origin?.kind === "result"), []);
    } finally {
      watcher.dispose();
    }
  });
});

test("a results folder that disappears stops being watched once its window closes", async () => {
  let now = Date.now();
  await withResults(async ({ materials, handoff, results }) => {
    const watcher = new HandoffResults({ materials, watchFactory: () => ({ close() {} }), pollIntervalMs: 0, now: () => now });
    try {
      watcher.arm(handoff);
      await rm(results, { recursive: true });
      now += 3 * 60 * 60 * 1000;
      await watcher.scanNow(handoff.id);
      await mkdir(results);
      await writeFile(join(results, "late.png"), pngBytes(640, 480, 9));
      await watcher.scanNow(handoff.id);
      assert.deepEqual(materials.snapshot().materials.filter((material) => material.origin?.kind === "result"), []);
    } finally {
      watcher.dispose();
    }
  });
});

test("a handoff stops being watched a while after its turn ends", async () => {
  await withResults(async ({ materials, handoff, results, sentAt }) => {
    let closed = 0;
    let now = sentAt + 1_000;
    const watcher = new HandoffResults({ materials, watchFactory: () => ({ close: () => { closed += 1; } }), pollIntervalMs: 0, now: () => now });
    try {
      watcher.arm(handoff);
      materials.updateHandoffDelivery(handoff.id, { turnStartedAt: sentAt + 100, turnEndedAt: sentAt + 5_000 });
      now = sentAt + 5_000 + 11 * 60 * 1000;
      await watcher.scanNow(handoff.id);
      assert.equal(closed, 1);
      await touch(join(results, "too-late.png"), pngBytes(640, 480, 8), now);
      await watcher.scanNow(handoff.id);
      assert.deepEqual(resultsOf(materials), []);
    } finally {
      watcher.dispose();
    }
  });
});

test("reports are parsed defensively", () => {
  assert.deepEqual(parseReport('{"fixed":[1,"#2",2,-1,"x"],"note":"  ok  "}'), { fixed: [1, 2], note: "ok" });
  assert.equal(parseReport("not json"), null);
  assert.equal(parseReport('{"fixed":"1"}'), null);
  assert.deepEqual(parseReport('{"fixed":[]}'), { fixed: [], note: null });
});
