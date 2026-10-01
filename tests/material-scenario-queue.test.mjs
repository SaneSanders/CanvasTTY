import assert from "node:assert/strict";
import test from "node:test";
import { ScenarioStepQueue } from "../src/renderer/src/features/materials/ScenarioStepQueue.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function recorder(results = []) {
  const events = [];
  const port = {
    addStep: async (materialId, step) => {
      events.push(`add:${step.kind}`);
      return results.shift() ?? { ok: true };
    },
    stop: async (materialId, reason) => {
      events.push(`stop:${materialId}:${reason}`);
      return { ok: true };
    },
    finishing: (materialId) => events.push(`finishing:${materialId}`),
    problem: (reason) => events.push(`problem:${reason}`)
  };
  return { events, port };
}

const step = (kind, gate) => async () => {
  await gate?.promise;
  return { kind, url: null, title: null, point: null, element: null, text: null, shot: null };
};

test("stopping a recording keeps the steps already queued", async () => {
  const { events, port } = recorder();
  const queue = new ScenarioStepQueue("m1", port);
  const click = deferred();
  const saved = [queue.enqueue(step("click", click)), queue.enqueue(step("expectation"))];
  const stopped = queue.finish("stopped");
  assert.equal(queue.finishing, true);
  assert.deepEqual(events, ["finishing:m1"]);
  click.resolve();
  await stopped;
  assert.deepEqual(await Promise.all(saved), [true, true]);
  assert.deepEqual(events, ["finishing:m1", "add:click", "add:expectation", "stop:m1:stopped"]);
  assert.equal(await queue.enqueue(step("click")), false);
  await queue.finish("limit");
  assert.equal(events.filter((event) => event.startsWith("stop:")).length, 1);
});

test("a full recording stops itself once and skips the steps behind it", async () => {
  const { events, port } = recorder([{ ok: true }, { ok: false, reason: "quota" }]);
  const queue = new ScenarioStepQueue("m2", port);
  const saved = await Promise.all([queue.enqueue(step("start")), queue.enqueue(step("click")), queue.enqueue(step("navigate"))]);
  await queue.finish("stopped");
  assert.deepEqual(saved, [true, false, false]);
  assert.deepEqual(events, ["add:start", "add:click", "finishing:m2", "stop:m2:limit"]);
});

test("a recording that ended elsewhere closes quietly", async () => {
  const { events, port } = recorder([{ ok: false, reason: "unavailable" }]);
  port.stop = async (materialId, reason) => {
    events.push(`stop:${materialId}:${reason}`);
    return { ok: false, reason: "unavailable" };
  };
  const queue = new ScenarioStepQueue("m3", port);
  assert.equal(await queue.enqueue(step("click")), false);
  await queue.finish("stopped");
  assert.deepEqual(events, ["add:click", "finishing:m3", "stop:m3:stopped"]);
});

test("a failed step is reported and the recording goes on", async () => {
  const { events, port } = recorder([{ ok: false, reason: "too-large" }]);
  const queue = new ScenarioStepQueue("m4", port);
  const saved = await Promise.all([
    queue.enqueue(async () => {
      throw new Error("screenshot failed");
    }),
    queue.enqueue(step("click")),
    queue.enqueue(step("navigate"))
  ]);
  assert.deepEqual(saved, [false, false, true]);
  assert.deepEqual(events, ["problem:unreadable", "add:click", "problem:too-large", "add:navigate"]);
});
