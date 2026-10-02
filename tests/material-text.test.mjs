import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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

test("a removed material takes its draft with it, and broken draft files are dropped on load", async () => {
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
    assert.equal(restarted.readDraft(other.id), null);
    assert.deepEqual(await readdir(join(userData, "materials", "drafts")), []);
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

test("a failed draft write keeps the pending text for the next attempt", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextMaterialBody.tsx", import.meta.url), "utf8");
  const flush = source.slice(source.indexOf("const flushDraft"), source.indexOf("const flushDraftRef"));
  assert.match(flush, /const generation = \(draftGeneration\.current \+= 1\);/);
  assert.match(flush, /if \(draftGeneration\.current === generation\) pending\.current = next;/);
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

test("evicted version blobs are collected only after the state is durable", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/main/services/materials/MaterialService.ts", import.meta.url), "utf8");
  assert.match(source, /private async collect\(\): Promise<void> \{\s*try \{\s*await this\.writeState\(true\);\s*\} catch \{\s*return;\s*\}/);
  const create = source.slice(source.indexOf("material.nextVersion += 1;"));
  assert.match(create, /await this\.collect\(\);\s*this\.changed\(\);/);
});

test("every draft reset invalidates older draft generations", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/materials/TextMaterialBody.tsx", import.meta.url), "utf8");
  const bumps = source.match(/draftGeneration\.current \+= 1[);]/g);
  assert.equal(bumps?.length, 6);
});

test("a save is refused when the state is not writable at all", async () => {
  await withText(async ({ create, userData, work }) => {
    await rm(join(userData, "materials", "state.json"), { force: true });
    await mkdir(join(userData, "materials", "state.json"));
    const blocked = await create();
    await writeFile(join(work, "notes.txt"), "original\n");
    await blocked.addPaths([join(work, "notes.txt")], { x: 0, y: 0 });
    const notes = blocked.snapshot().materials[0];
    const base = (await blocked.readText(notes.id, null)).content;
    const saved = await blocked.saveText(notes.id, { baseHash: base.hash, text: "saved\n" });
    assert.deepEqual({ ok: saved.ok, reason: saved.ok ? null : saved.reason }, { ok: false, reason: "write-failed" });
    assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "original\n");
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
