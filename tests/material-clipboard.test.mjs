import assert from "node:assert/strict";
import test from "node:test";
import {
  captureRejection,
  CLIPBOARD_TEXT_PATH_LIMIT,
  fileUrlPaths,
  plistPaths,
  textPaths,
  windowsFileNames
} from "../src/main/services/materials/materialClipboard.ts";
import { frameRect } from "../src/main/services/materials/pageCapture.ts";

test("copied files are read from the platform's file list formats", () => {
  const plist = "<plist><array><string>/work/me/a &amp; b.png</string><string>relative.png</string><string>/tmp/c&lt;1&gt;.md</string></array></plist>";
  assert.deepEqual(plistPaths(plist), ["/work/me/a & b.png", "/tmp/c<1>.md"]);
  assert.deepEqual(fileUrlPaths("file:///work/me/My%20Shot.png\r\nhttps://example.com/x.png\n#comment\nfile:///tmp/a.txt"), ["/work/me/My Shot.png", "/tmp/a.txt"]);
  assert.deepEqual(windowsFileNames(Buffer.from("C:\\work\\a.png\0D:\\b.txt\0relative\0\0", "utf16le")), ["C:\\work\\a.png", "D:\\b.txt"]);
});

test("plain clipboard text counts as files only when every line is a local absolute path", () => {
  assert.deepEqual(textPaths("/work/me/a.png\n  /Volumes/Share/b.mov  \n", "darwin"), ["/work/me/a.png", "/Volumes/Share/b.mov"]);
  assert.deepEqual(textPaths("/work/me/a.png\nnotes.txt", "darwin"), []);
  assert.deepEqual(textPaths("/net/host/share/a.png", "darwin"), []);
  assert.deepEqual(textPaths("/Network/Servers/host/a.png", "darwin"), []);
  assert.deepEqual(textPaths("C:\\work\\a.png", "win32"), ["C:\\work\\a.png"]);
  assert.deepEqual(textPaths("\\\\host\\share\\a.png", "win32"), []);
  assert.deepEqual(textPaths("//host/share/a.png", "win32"), []);
  assert.deepEqual(textPaths(Array.from({ length: CLIPBOARD_TEXT_PATH_LIMIT + 1 }, (_, index) => `/tmp/${index}.png`).join("\n"), "linux"), []);
  assert.deepEqual(textPaths("", "linux"), []);
});

test("a clipboard image that cannot be kept is named by its reason", () => {
  assert.equal(captureRejection("material-limit"), "limit");
  assert.equal(captureRejection("quota"), "quota");
  assert.equal(captureRejection("too-large"), "too-large");
  assert.equal(captureRejection("unavailable"), "unreadable");
});

test("a frame rectangle is scaled to window pixels, clamped to the window and needs a usable size", () => {
  assert.deepEqual(frameRect({ x: 10.4, y: 20.6, width: 100, height: 50 }, { width: 1200, height: 800 }, 1), { x: 10, y: 20, width: 101, height: 51 });
  assert.deepEqual(frameRect({ x: 10, y: 20, width: 100, height: 50 }, { width: 1200, height: 800 }, 1.25), { x: 12, y: 25, width: 126, height: 63 });
  assert.deepEqual(frameRect({ x: -40, y: 780, width: 100, height: 60 }, { width: 1200, height: 800 }, 1), { x: 0, y: 780, width: 60, height: 20 });
  assert.equal(frameRect({ x: 1190, y: 10, width: 100, height: 100 }, { width: 1200, height: 800 }, 1), null);
  assert.equal(frameRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, { width: 1200, height: 800 }, 1), null);
  assert.equal(frameRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 1200, height: 800 }, 0), null);
});

test("the canvas pastes materials only on the Cmd/Ctrl chord", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  assert.match(source, /\} else if \(\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && matchesPhysicalOrLayoutKey\(event, "KeyV", "v"\)/);
});
