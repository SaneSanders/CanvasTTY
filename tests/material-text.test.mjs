import assert from "node:assert/strict";
import fs, { chmod, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { decodeText, encodeText, TEXT_EDIT_LIMIT } from "../src/main/services/materials/materialText.ts";
import { withMaterials } from "./material-fixtures.mjs";

async function withText(run, options = {}) {
  await withMaterials(async ({ work, service, userData, create, setPersist }) => {
    const add = async (name, content) => {
      await writeFile(join(work, name), content);
      await service.addPaths([join(work, name)], { x: 0, y: 0 });
      return service.snapshot().materials.find((material) => material.name === name);
    };
    await run({ service, work, userData, add, create, setPersist });
  }, options);
}

async function duringTextSave(run, update) {
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes(".canvastty-")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await update();
        return sync();
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
}

test("staged saves preserve concurrent writes", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "original\n");
    const file = join(work, "notes.txt");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "mine\n" });
    const saved = await duringTextSave(
      () => service.saveText(notes.id, { baseHash: base.hash, text: "mine\n" }),
      () => writeFile(file, "changed elsewhere\n")
    );
    assert.equal(saved.reason, "conflict");
    assert.equal(saved.current.text, "changed elsewhere\n");
    assert.equal(await readFile(file, "utf8"), "changed elsewhere\n");
    assert.equal(service.readDraft(notes.id).text, "mine\n");
    assert.deepEqual(await readdir(work), ["notes.txt"]);
  });
});

test("staged saves detect replacement files", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "original\n");
    const file = join(work, "notes.txt");
    const base = (await service.readText(notes.id, null)).content;
    const saved = await duringTextSave(
      () => service.saveText(notes.id, { baseHash: base.hash, text: "mine\n" }),
      async () => {
        await writeFile(`${file}.next`, "original\n");
        await chmod(`${file}.next`, 0o600);
        await rename(`${file}.next`, file);
      }
    );
    assert.deepEqual(saved, { ok: false, reason: "write-failed" });
    assert.equal(await readFile(file, "utf8"), "original\n");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(work), ["notes.txt"]);
  });
});

test("text is decoded as UTF-8 with its line endings and byte order mark remembered", () => {
  const crlf = decodeText(Buffer.from("\ufeffone\r\ntwo\r\n", "utf8"));
  assert.deepEqual({ text: crlf.text, eol: crlf.eol, bom: crlf.bom, editable: crlf.editable }, { text: "one\ntwo\n", eol: "crlf", bom: true, editable: true });
  assert.deepEqual(encodeText(crlf.text, crlf.eol, crlf.bom), Buffer.from("\ufeffone\r\ntwo\r\n", "utf8"));
  assert.equal(decodeText(Buffer.from("a\r\nb\nc")).editable, false);
  assert.equal(decodeText(Buffer.from("a\rb")).editable, false);
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(decodeText(Buffer.from([0xc3, 0x28])), null);
  assert.equal(decodeText(Buffer.from("привет\n")).text, "привет\n");
  const doubled = decodeText(Buffer.from("\ufeff\ufeffone\n", "utf8"));
  assert.deepEqual({ text: doubled.text, bom: doubled.bom }, { text: "\ufeffone\n", bom: true });
  assert.deepEqual(encodeText(doubled.text, doubled.eol, doubled.bom), Buffer.from("\ufeff\ufeffone\n", "utf8"));
});

test("a live text file and its versions are read, only the live one is editable", async () => {
  await withText(async ({ service, add }) => {
    const notes = await add("notes.md", "# Title\n\nFirst\n");
    const pinned = await service.pinVersion(notes.id);
    const live = await service.readText(notes.id, null);
    assert.deepEqual({ text: live.content.text, editable: live.content.editable }, { text: "# Title\n\nFirst\n", editable: true });
    const version = await service.readText(notes.id, pinned.version.id);
    assert.deepEqual({ text: version.content.text, editable: version.content.editable }, { text: "# Title\n\nFirst\n", editable: false });
    const image = await add("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.deepEqual(await service.readText(image.id, null), { ok: false, reason: "unavailable" });
  });
});

test("saving replaces the file atomically, keeps its mode and line endings, and keeps what was there as a version", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "one\r\ntwo\r\n");
    await chmod(join(work, "notes.txt"), 0o640);
    const base = (await service.readText(notes.id, null)).content;
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "one\ntwo\nthree\n" });
    assert.equal(saved.ok, true);
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");
    assert.equal((await stat(join(work, "notes.txt"))).mode & 0o777, 0o640);
    assert.equal(saved.previous.reason, "edit");
    assert.equal((await service.readText(notes.id, saved.previous.id)).content.text, "one\ntwo\n");
    assert.deepEqual((await readdir(work)).sort(), ["notes.txt"]);
  });
});

test("a save based on an older text is refused with what is on disk now", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "draft base\n");
    const base = (await service.readText(notes.id, null)).content;
    await writeFile(join(work, "notes.txt"), "changed elsewhere\n");
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "mine\n" });
    assert.equal(saved.reason, "conflict");
    assert.equal(saved.current.text, "changed elsewhere\n");
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "changed elsewhere\n");
    assert.deepEqual(service.snapshot().materials[0].versions, [], "a refused save keeps no version");
  });
});

test("files that cannot be edited safely are refused without being touched", async () => {
  await withText(async ({ service, work, add }) => {
    const mixed = await add("mixed.txt", "a\r\nb\n");
    const mixedBase = (await service.readText(mixed.id, null)).content;
    assert.deepEqual(await service.saveText(mixed.id, { baseHash: mixedBase.hash, text: "x\n" }), { ok: false, reason: "read-only" });
    const binary = await add("data.json", Buffer.from([0x7b, 0x00, 0x7d]));
    assert.deepEqual(await service.readText(binary.id, null), { ok: false, reason: "not-text" });
    const notes = await add("notes.txt", "safe\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.saveText(notes.id, { baseHash: base.hash, text: "x".repeat(TEXT_EDIT_LIMIT + 1) }), { ok: false, reason: "too-large" });
    await writeFile(join(work, "secret.txt"), "do not touch\n");
    await unlink(join(work, "notes.txt"));
    await symlink(join(work, "secret.txt"), join(work, "notes.txt"));
    assert.deepEqual(await service.saveText(notes.id, { baseHash: base.hash, text: "overwritten\n" }), { ok: false, reason: "unreadable" });
    assert.equal(await readFile(join(work, "secret.txt"), "utf8"), "do not touch\n");
  });
});

test("a save that cannot keep the text on disk as a version is refused unless the person allows it", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "on disk\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.saveText(notes.id, { baseHash: base.hash, text: "mine\n" }), { ok: false, reason: "quota" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "on disk\n");
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "mine\n", allowUnversioned: true });
    assert.equal(saved.ok, true);
    assert.equal(saved.previous, null);
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "mine\n");
  }, { storageLimitBytes: 4 });
});

test("a save is refused while remarks hold every version the file may keep", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "v\n");
    for (let round = 1; round <= 20; round += 1) {
      await writeFile(join(work, "notes.txt"), `${"v".repeat(round)}\n`);
      assert.equal((await service.addRemark({ materialId: notes.id, anchor: { kind: "whole" }, reference: null, text: `Round ${round}` })).ok, true);
    }
    await writeFile(join(work, "notes.txt"), "changed by an agent\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.saveText(notes.id, { baseHash: base.hash, text: "mine\n" }), { ok: false, reason: "version-limit" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "changed by an agent\n");
  });
});

test("an edit with a NUL character is refused as not text", async () => {
  await withText(async ({ service, work, add }) => {
    const notes = await add("notes.txt", "clean\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.saveText(notes.id, { baseHash: base.hash, text: "a\u0000b\n" }), { ok: false, reason: "not-text" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "clean\n");
  });
});

test("a draft survives a restart when materials are kept, and goes away on save", async () => {
  await withText(async ({ service, add, create }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "base\nmore\n" }), { ok: true });
    assert.deepEqual(service.snapshot().materials[0].draft, { baseHash: base.hash });
    await service.flush();
    const restarted = await create();
    assert.equal(restarted.readDraft(notes.id).text, "base\nmore\n");
    const saved = await restarted.saveText(notes.id, { baseHash: base.hash, text: "base\nmore\n" });
    assert.equal(saved.ok, true);
    assert.equal(restarted.readDraft(notes.id), null);
    assert.equal(restarted.snapshot().materials[0].draft, null);
  });
});

test("missing indexes preserve drafts without blobs", async () => {
  await withText(async ({ service, add, create, userData, setPersist }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "unsaved work\n" });
    await service.dispose();
    const state = join(userData, "materials", "state.json");
    const draft = join(userData, "materials", "drafts", `${notes.id}.json`);
    const saved = await readFile(draft);
    assert.deepEqual(await readdir(join(userData, "materials", "versions")).catch(() => []), []);
    await rm(state);
    for (const persist of [true, false]) {
      setPersist(persist);
      const restarted = await create();
      assert.equal(restarted.snapshot().loadError, "unreadable");
      await restarted.flush();
      await restarted.dispose();
      assert.deepEqual(await readFile(draft), saved);
      await assert.rejects(readFile(state), { code: "ENOENT" });
    }
  });
});

test("drafts stay in memory only when materials are not kept after exit", async () => {
  await withText(async ({ service, userData, add, setPersist }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "kept\n" });
    await service.flush();
    assert.deepEqual(await readdir(join(userData, "materials", "drafts")), [`${notes.id}.json`]);
    setPersist(false);
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "kept longer\n" });
    assert.equal(JSON.parse(await readFile(join(userData, "materials", "drafts", `${notes.id}.json`), "utf8")).text, "kept\n");
    await service.flush();
    assert.equal(service.readDraft(notes.id).text, "kept longer\n");
    await assert.rejects(readdir(join(userData, "materials", "drafts")), { code: "ENOENT" });
  });
});

test("removed drafts are collected; invalid drafts are preserved", async () => {
  await withText(async ({ service, userData, add, create }) => {
    const notes = await add("notes.txt", "base\n");
    const other = await add("other.txt", "other\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "gone soon\n" });
    await service.writeDraft(other.id, { baseHash: "f".repeat(64), text: "kept\n" });
    await service.remove(notes.id);
    await service.flush();
    await writeFile(join(userData, "materials", "drafts", `${other.id}.json`), "{broken");
    const restarted = await create();
    assert.equal(restarted.readDraft(notes.id), null);
    assert.equal(restarted.material(other.id).draftError, "unreadable");
    assert.throws(() => restarted.readDraft(other.id), /draft/i);
    assert.deepEqual(await restarted.writeDraft(other.id, { baseHash: "f".repeat(64), text: "replacement\n" }), { ok: false, reason: "write-failed" });
    restarted.discardDraft(other.id);
    await restarted.flush();
    assert.equal(await readFile(join(userData, "materials", "drafts", `${other.id}.json`), "utf8"), "{broken");
    assert.deepEqual(await readdir(join(userData, "materials", "drafts")), [`${other.id}.json`]);
  });
});

test("unreadable drafts survive restart", { skip: process.platform === "win32" }, async () => {
  await withText(async ({ service, add, create, userData, work, setPersist }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "unsaved work\n" });
    await service.dispose();
    const file = join(userData, "materials", "drafts", `${notes.id}.json`);
    const saved = await readFile(file, "utf8");
    await chmod(file, 0o000);
    try {
      const restarted = await create();
      assert.throws(() => restarted.readDraft(notes.id), /draft/i);
      assert.deepEqual(await restarted.writeDraft(notes.id, { baseHash: base.hash, text: "replacement\n" }), { ok: false, reason: "write-failed" });
      assert.deepEqual(await restarted.saveText(notes.id, { baseHash: base.hash, text: "replacement\n" }), { ok: false, reason: "write-failed" });
      assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "original\n");
      restarted.discardDraft(notes.id);
      setPersist(false);
      await restarted.dispose();
      assert.equal((await stat(file)).isFile(), true);
    } finally {
      await chmod(file, 0o600).catch(() => undefined);
    }
    assert.equal(await readFile(file, "utf8"), saved);
  });
});

test("unreadable draft folders block replacement", { skip: process.platform === "win32" }, async () => {
  await withText(async ({ service, add, create, userData }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "unsaved work\n" });
    await service.dispose();
    const directory = join(userData, "materials", "drafts");
    await chmod(directory, 0o000);
    let restarted;
    try {
      restarted = await create();
      assert.throws(() => restarted.readDraft(notes.id), /draft/i);
    } finally {
      await chmod(directory, 0o700);
    }
    assert.deepEqual(await restarted.writeDraft(notes.id, { baseHash: base.hash, text: "replacement\n" }), { ok: false, reason: "write-failed" });
    await restarted.flush();
    assert.equal(JSON.parse(await readFile(join(directory, `${notes.id}.json`), "utf8")).text, "unsaved work\n");
  });
});

test("missing sources keep drafts; only orphan files are collected", async () => {
  await withText(async ({ service, add, create, userData, work }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "unsaved work\n" });
    await service.dispose();
    await unlink(join(work, "notes.txt"));
    const directory = join(userData, "materials", "drafts");
    await writeFile(join(directory, "11111111-1111-4111-8111-111111111111.json"), "orphan");
    await writeFile(join(directory, `${notes.id}.json.tmp`), "interrupted write");
    const restarted = await create();
    assert.equal(restarted.readDraft(notes.id).text, "unsaved work\n");
    assert.deepEqual((await readdir(directory)).sort(), [`${notes.id}.json`, `${notes.id}.json.tmp`].sort());
  });
});

test("discarding a draft never reaches past the drafts of materials on the canvas", async () => {
  await withText(async ({ service, userData, add }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.writeDraft(notes.id, { baseHash: base.hash, text: "mine\n" });
    await writeFile(join(userData, "outside.json"), "{}");
    service.discardDraft("../../outside");
    service.discardDraft(`../drafts/${notes.id}`);
    await service.flush();
    assert.equal(await readFile(join(userData, "outside.json"), "utf8"), "{}");
    assert.equal(service.readDraft(notes.id).text, "mine\n");
  });
});

test("line remarks belong to text, areas to images", async () => {
  await withText(async ({ service, add }) => {
    const notes = await add("notes.txt", "a\nb\nc\n");
    const image = await add("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const lines = await service.addRemark({ materialId: notes.id, anchor: { kind: "lines", start: 2, end: 3 }, reference: null, text: "Reword" });
    assert.deepEqual(lines.remark.target.anchor, { kind: "lines", start: 2, end: 3 });
    assert.deepEqual(await service.addRemark({ materialId: image.id, anchor: { kind: "lines", start: 1, end: 1 }, reference: null, text: "x" }),
      { ok: false, reason: "kind-mismatch" });
    assert.deepEqual(await service.addRemark({ materialId: notes.id, anchor: { kind: "region", x: 0, y: 0, width: 0.5, height: 0.5 }, reference: null, text: "x" }),
      { ok: false, reason: "kind-mismatch" });
    assert.equal((await service.addRemark({ materialId: notes.id, anchor: { kind: "lines", start: 3, end: 2 }, reference: null, text: "x" })).ok, false);
  });
});

test("the text editor saves on the physical Cmd/Ctrl+S chord in any layout", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextMaterialBody.tsx", import.meta.url), "utf8");
  assert.match(source, /\(event\.metaKey \|\| event\.ctrlKey\) && !event\.altKey && matchesPhysicalOrLayoutKey\(event, "KeyS", "s"\)/);
});

test("a failed save keeps the typed text as a draft", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextMaterialBody.tsx", import.meta.url), "utf8");
  const saveBody = source.slice(source.indexOf("const save = async"), source.indexOf("const lineFromPointer"));
  const restores = saveBody.match(/pending\.current = \{ baseHash, text: draftText \};\s*\n\s*flushDraftRef\.current\(\);/g);
  assert.equal(restores?.length, 2, "the failure branch and the IPC exception path both restore the pending draft");
  assert.equal((saveBody.match(/setNotice\(\{ kind: "unkept"/g) ?? []).length, 1);
});

test("a draft keeps text beyond the display limit while save still refuses it", async () => {
  await withText(async ({ service, add }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    const big = "x".repeat(TEXT_EDIT_LIMIT + 1);
    assert.equal((await service.saveText(notes.id, { baseHash: base.hash, text: big })).reason, "too-large");
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: big }), { ok: true });
    assert.equal(service.readDraft(notes.id).text.length, big.length);
    const beyondDraftLimit = "x".repeat(TEXT_EDIT_LIMIT * 7 + 1);
    assert.equal((await service.writeDraft(notes.id, { baseHash: base.hash, text: beyondDraftLimit })).reason, "too-large");
  });
});

test("a draft beyond the display limit survives a restart, and a draft too large for its file is refused at write", async () => {
  await withText(async ({ service, add, create }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    const big = "x".repeat(TEXT_EDIT_LIMIT + 1);
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: big }), { ok: true });
    await service.flush();
    const restarted = await create();
    assert.equal(restarted.readDraft(notes.id).text.length, big.length);
    const bomb = "\n".repeat(TEXT_EDIT_LIMIT * 4);
    const refused = await restarted.writeDraft(notes.id, { baseHash: base.hash, text: bomb });
    assert.deepEqual({ ok: refused.ok, reason: refused.reason }, { ok: false, reason: "too-large" });
    await restarted.flush();
    const again = await create();
    assert.equal(again.readDraft(notes.id).text.length, big.length, "the refused draft never replaced the stored one");
  });
});

test("a refused draft never displaces a confirmed earlier draft", async () => {
  await withText(async ({ service, add, create }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "A0\n" }), { ok: true });
    const good = service.writeDraft(notes.id, { baseHash: base.hash, text: "A1\n" });
    const bad = service.writeDraft(notes.id, { baseHash: base.hash, text: "\n".repeat(TEXT_EDIT_LIMIT * 4) });
    const [goodResult, badResult] = await Promise.all([good, bad]);
    assert.equal(goodResult.ok, true);
    assert.deepEqual({ ok: badResult.ok, reason: badResult.reason }, { ok: false, reason: "too-large" });
    await service.flush();
    const restarted = await create();
    assert.equal(restarted.readDraft(notes.id).text, "A1\n");
  });
});

test("dispose with persistence off leaves no drafts on disk", async () => {
  await withText(async ({ service, add, userData, setPersist }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    const writes = [];
    for (let index = 0; index < 8; index += 1) writes.push(service.writeDraft(notes.id, { baseHash: base.hash, text: `${index}\n` }));
    setPersist(false);
    await Promise.all(writes);
    await service.dispose();
    assert.equal(await readdir(join(userData, "materials", "drafts")).catch(() => null), null);
  });
});

test("dispose waits out in-flight draft writes before the persistence-off cleanup", async () => {
  await withText(async ({ service, add, userData, setPersist }) => {
    const notes = await add("notes.txt", "base\n");
    const base = (await service.readText(notes.id, null)).content;
    const writes = [];
    for (let index = 0; index < 8; index += 1) writes.push(service.writeDraft(notes.id, { baseHash: base.hash, text: `${index}\n` }));
    setPersist(false);
    const disposal = service.dispose();
    await Promise.all([disposal, ...writes]);
    assert.equal(await readdir(join(userData, "materials", "drafts")).catch(() => null), null);
  });
});

test("the persistence-off cleanup is serialized behind draft writes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/main/services/materials/MaterialService.ts", import.meta.url), "utf8");
  const cleanup = source.slice(source.indexOf("const cleanup = this.draftQueue"));
  assert.match(cleanup, /^const cleanup = this\.draftQueue\.catch\(\(\) => undefined\)\.then\(\(\) => rm\(this\.draftsPath/);
  assert.match(cleanup, /this\.draftQueue = cleanup\.catch\(\(\) => undefined\);\s*await cleanup;/);
});

test("a successful save persists the previous version's metadata before replacing the file", async () => {
  await withText(async ({ service, add, create }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "saved\n" });
    assert.equal(saved.ok, true);
    const restarted = await create();
    assert.equal(restarted.snapshot().materials[0].versions.length, 1);
  });
});

test("a failed metadata write refuses the save instead of replacing the source", async () => {
  await withText(async ({ service, add, create, userData, work }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await mkdir(join(userData, "materials", "state.json.tmp"));
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "saved\n" });
    assert.deepEqual({ ok: saved.ok, reason: saved.ok ? null : saved.reason }, { ok: false, reason: "write-failed" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "original\n");
    await rm(join(userData, "materials", "state.json.tmp"), { recursive: true });
    const restarted = await create();
    assert.equal(restarted.snapshot().materials[0]?.versions.length ?? 0, 0);
  });
});

test("a conflict state counts as pending text for removal confirmation", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextMaterialBody.tsx", import.meta.url), "utf8");
  assert.match(source, /onPendingTextRef\.current\?\.\(state === "draft" \|\| state === "conflict"\)/);
});

test("eviction keeps blobs until persistence succeeds", async () => {
  await withText(async ({ service, add, userData, work }) => {
    const notes = await add("notes.txt", "original\n");
    for (let index = 0; index < 20; index += 1) {
      const base = (await service.readText(notes.id, null)).content;
      assert.equal((await service.saveText(notes.id, { baseHash: base.hash, text: `version ${index}\n` })).ok, true);
    }
    await service.flush();
    const oldest = service.material(notes.id).versions[0];
    const blob = service.versionFile(notes.id, oldest.id).path;
    const state = join(userData, "materials", "state.json");
    const saved = await readFile(state);
    await mkdir(`${state}.tmp`);
    const base = (await service.readText(notes.id, null)).content;
    const refused = await service.saveText(notes.id, { baseHash: base.hash, text: "not yet\n" });
    assert.deepEqual(refused, { ok: false, reason: "write-failed" });
    assert.equal(await readFile(blob, "utf8"), "original\n");
    assert.deepEqual(await readFile(state), saved);
    await rm(`${state}.tmp`, { recursive: true });
    await writeFile(join(work, "notes.txt"), "changed elsewhere\n");
    assert.equal((await service.pinVersion(notes.id, "edit")).ok, true);
    await service.flush();
    const kept = JSON.parse(await readFile(state, "utf8")).materials[0].versions;
    assert.equal(kept.some((version) => version.id === oldest.id), false);
    await assert.rejects(readFile(blob), { code: "ENOENT" });
  });
});

test("unreadable stores refuse text additions and saves", async () => {
  await withText(async ({ service, add, create, userData, work }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    await service.dispose();
    await rm(join(userData, "materials", "state.json"), { force: true });
    await mkdir(join(userData, "materials", "state.json"));
    const blocked = await create();
    assert.equal(blocked.snapshot().loadError, "unreadable");
    assert.deepEqual(await blocked.addPaths([join(work, "notes.txt")], { x: 0, y: 0 }), {
      added: [], existing: [], rejected: [{ name: "notes.txt", reason: "unreadable" }]
    });
    const saved = await blocked.saveText(notes.id, { baseHash: base.hash, text: "saved\n" });
    assert.deepEqual(saved, { ok: false, reason: "unavailable" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "original\n");
    assert.equal((await stat(join(userData, "materials", "state.json"))).isDirectory(), true);
    await rm(join(userData, "materials", "state.json"), { recursive: true });
  });
});

test("a save reports write-failed when the stale draft cannot be deleted", async () => {
  await withText(async ({ service, add, userData, work }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "older draft\n" }), { ok: true });
    await service.flush();
    const draftsDir = join(userData, "materials", "drafts");
    await chmod(draftsDir, 0o500);
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "newer saved text\n" });
    await chmod(draftsDir, 0o700);
    assert.deepEqual({ ok: saved.ok, reason: saved.ok ? null : saved.reason }, { ok: false, reason: "write-failed" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "newer saved text\n");
  });
});

test("an unchanged save also refuses when the draft cannot be deleted", async () => {
  await withText(async ({ service, add, userData }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "older draft\n" }), { ok: true });
    await service.flush();
    const draftsDir = join(userData, "materials", "drafts");
    await chmod(draftsDir, 0o500);
    const saved = await service.saveText(notes.id, { baseHash: base.hash, text: "original\n" });
    await chmod(draftsDir, 0o700);
    assert.deepEqual({ ok: saved.ok, reason: saved.ok ? null : saved.reason }, { ok: false, reason: "write-failed" });
  });
});

test("discardDraft stays best-effort when the file cannot be deleted", async () => {
  await withText(async ({ service, add, userData }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "older draft\n" }), { ok: true });
    await service.flush();
    const draftsDir = join(userData, "materials", "drafts");
    await chmod(draftsDir, 0o500);
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    service.discardDraft(notes.id);
    await service.flush().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.removeListener("unhandledRejection", onRejection);
    await chmod(draftsDir, 0o700);
    assert.deepEqual(rejections, []);
  });
});

test("the strict draft removal is serialized through the draft queue", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/main/services/materials/MaterialService.ts", import.meta.url), "utf8");
  const strict = source.slice(source.indexOf("private async dropDraftStrict"));
  assert.match(strict, /const removal = this\.draftQueue\.catch\(\(\) => undefined\)\.then\(\(\) => rm\(file, \{ force: true \}\)\);\s*this\.draftQueue = removal\.catch\(\(\) => undefined\);\s*await removal;/);
});

test("the persistence-off cleanup never rejects the draft queue", async () => {
  await withText(async ({ service, add, userData, setPersist }) => {
    const notes = await add("notes.txt", "original\n");
    const base = (await service.readText(notes.id, null)).content;
    assert.deepEqual(await service.writeDraft(notes.id, { baseHash: base.hash, text: "older draft\n" }), { ok: true });
    await service.flush();
    const draftsDir = join(userData, "materials", "drafts");
    await chmod(draftsDir, 0o500);
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    setPersist(false);
    await service.dispose().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.removeListener("unhandledRejection", onRejection);
    await chmod(draftsDir, 0o700);
    assert.deepEqual(rejections, []);
  });
});
