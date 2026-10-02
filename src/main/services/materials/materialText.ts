import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MaterialFailure, MaterialText, MaterialTextEdit } from "../../../shared/contracts";
import { SHA256_PATTERN } from "./materialState.ts";

export const TEXT_EDIT_LIMIT = 2 * 1024 * 1024;

export const READ_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function decodeText(bytes: Uint8Array): MaterialText | null {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  if (body.includes(0)) return null;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return null;
  }
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf;
  const loneCarriageReturn = /\r(?!\n)/.test(raw);
  return {
    text: raw.replace(/\r\n?/g, "\n"),
    hash,
    eol: crlf > 0 && lf === 0 ? "crlf" : "lf",
    bom,
    editable: !loneCarriageReturn && !(crlf > 0 && lf > 0),
    byteSize: bytes.length
  };
}

export function encodeText(text: string, eol: MaterialText["eol"], bom: boolean): Buffer {
  const normalized = text.replace(/\r\n?/g, "\n");
  const body = Buffer.from(eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized, "utf8");
  return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

export function parseTextEdit(value: unknown, limit = TEXT_EDIT_LIMIT): MaterialTextEdit | null {
  if (!value || typeof value !== "object") return null;
  const { baseHash, text } = value as Partial<MaterialTextEdit>;
  if (typeof baseHash !== "string" || !SHA256_PATTERN.test(baseHash) || typeof text !== "string") return null;
  if (Buffer.byteLength(text, "utf8") > limit) return null;
  return { baseHash, text };
}

export type BoundedRead = { ok: true; bytes: Buffer; mode: number } | { ok: false; reason: MaterialFailure };

export async function readBounded(path: string, limit: number, partial = false): Promise<BoundedRead> {
  const flags = READ_FILE_FLAGS;
  let handle;
  try {
    handle = await open(path, flags);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (!partial && info.size > limit) return { ok: false, reason: "too-large" };
    if (partial) {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      return { ok: true, bytes: buffer.subarray(0, bytesRead), mode: info.mode & 0o7777 };
    }
    const bytes = await handle.readFile();
    if (bytes.length > limit) return { ok: false, reason: "too-large" };
    return { ok: true, bytes, mode: info.mode & 0o7777 };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function replaceFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.canvastty-${randomUUID().slice(0, 8)}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
