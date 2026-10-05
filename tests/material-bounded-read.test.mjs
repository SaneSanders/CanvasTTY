import assert from "node:assert/strict";
import fs, { appendFile, chmod, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBounded } from "../src/main/services/materials/materialText.ts";

async function withFile(bytes, options, run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-bounded-read-"));
  const path = join(root, "notes.txt");
  const originalOpen = fs.open;
  const handles = [];
  const io = { bytes: 0 };
  try {
    await writeFile(path, bytes);
    await chmod(path, 0o600);
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== path) return handle;
      handles.push(handle);
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      const originalReadFile = handle.readFile.bind(handle);
      handle.stat = async (...statArgs) => {
        if (options.fail === "stat") throw new Error("stat failed");
        const info = await originalStat(...statArgs);
        await options.afterStat?.(path);
        return info;
      };
      handle.read = async (buffer, offset, length, position) => {
        if (options.fail === "read") throw new Error("read failed");
        const result = await originalRead(buffer, offset, Math.min(length, options.chunkSize ?? length), position);
        io.bytes += result.bytesRead;
        return result;
      };
      handle.readFile = async (...readArgs) => {
        if (options.fail === "read") throw new Error("read failed");
        const bytes = await originalReadFile(...readArgs);
        io.bytes += bytes.length;
        return bytes;
      };
      return handle;
    };
    syncBuiltinESMExports();
    await run(path, io);
    for (const handle of handles) assert.equal(handle.fd, -1);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    for (const handle of handles) await handle.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test("growing files stay bounded", async () => {
  await withFile("old", { afterStat: (path) => appendFile(path, "x".repeat(64)) }, async (path, io) => {
    assert.deepEqual(await readBounded(path, 8), { ok: false, reason: "too-large" });
    assert.ok(io.bytes > 0 && io.bytes <= 9, `read ${io.bytes} bytes`);
  });
});

test("short reads preserve bytes", async () => {
  const bytes = Buffer.from("\ufeffПривет\r\n", "utf8");
  await withFile(bytes.subarray(0, 3), { chunkSize: 3, afterStat: (path) => appendFile(path, bytes.subarray(3)) }, async (path) => {
    const info = await stat(path, { bigint: true });
    const result = await readBounded(path, bytes.length);
    assert.deepEqual(result, {
      ok: true,
      bytes,
      mode: Number(info.mode & 0o7777n),
      identity: `${info.dev}:${info.ino}`
    });
  });
});

test("partial reads reach the limit", async () => {
  await withFile("0123456789abcdef", { chunkSize: 3 }, async (path, io) => {
    const result = await readBounded(path, 8, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.bytes, Buffer.from("01234567"));
    assert.equal(io.bytes, 8);
  });
});

test("shrinking files stop at EOF", async () => {
  await withFile("01234567", { chunkSize: 2, afterStat: (path) => truncate(path, 3) }, async (path, io) => {
    const result = await readBounded(path, 8);
    assert.equal(result.ok, true);
    assert.deepEqual(result.bytes, Buffer.from("012"));
    assert.equal(io.bytes, 3);
  });
});

test("full reads accept the boundary", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("01234567")]) {
    await withFile(bytes, {}, async (path, io) => {
      const result = await readBounded(path, bytes.length);
      assert.equal(result.ok, true);
      assert.deepEqual(result.bytes, bytes);
      assert.equal(io.bytes, bytes.length);
    });
  }
});

test("oversized files skip reading", async () => {
  await withFile("012345678", {}, async (path, io) => {
    assert.deepEqual(await readBounded(path, 8), { ok: false, reason: "too-large" });
    assert.equal(io.bytes, 0);
  });
});

test("I/O failures close the file", async () => {
  for (const fail of ["stat", "read"]) {
    await withFile("01234567", { fail }, async (path) => {
      assert.deepEqual(await readBounded(path, 8), { ok: false, reason: "unreadable" });
    });
  }
});
