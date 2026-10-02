import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MaterialHandoff, MaterialOrigin, Point } from "../../../shared/contracts";
import type { MaterialService } from "./MaterialService.ts";
import { readBounded } from "./materialText.ts";
import { nodeWatchFactory, type WatchFactory, type WatchHandle } from "./materialWatch.ts";

export const RESULT_FILE_LIMIT = 24;
const REPORT_BYTES_LIMIT = 64 * 1024;
const RESULTS_SCAN_LIMIT = 2_000;
const REARM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MTIME_TOLERANCE_MS = 2_000;
const REPORT_FIXED_LIMIT = 50;
const REPORT_NOTE_LIMIT = 2_000;
const WINDOW_CAP_MS = 2 * 60 * 60 * 1000;
const DISARM_AFTER_MS = 10 * 60 * 1000;
const SCAN_DELAY_MS = 400;
const POLL_INTERVAL_MS = 15_000;
const IGNORED = /^(?:\.|~\$)|(?:~|\.tmp|\.part|\.crdownload|\.swp|\.lock)$/i;
const REPORT_NAME = /^canvastty-report-(\d+)\.json$/;

interface HandoffResultsOptions {
  materials: MaterialService;
  watchFactory?: WatchFactory;
  pollIntervalMs?: number;
  now?(): number;
}

interface ArmedHandoff {
  handoffId: string;
  number: number;
  sessionId: string;
  folder: string;
  since: number;
  closedAt: number | null;
  report: string | null;
  added: number;
}

interface WatchedFolder {
  path: string;
  handle: WatchHandle | null;
  timer: ReturnType<typeof setTimeout> | null;
  seen: Map<string, string>;
  addsCards: boolean;
}

interface ResultReport {
  fixed: number[];
  note: string | null;
}

export class HandoffResults {
  private readonly options: HandoffResultsOptions;
  private readonly armed = new Map<string, ArmedHandoff>();
  private readonly folders = new Map<string, WatchedFolder>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HandoffResultsOptions) {
    this.options = options;
    const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        for (const folder of this.folders.values()) this.schedule(folder);
      }, interval);
      this.pollTimer.unref?.();
    }
  }

  restore(handoffs: readonly MaterialHandoff[]): void {
    const now = this.now();
    for (const handoff of handoffs) {
      if (handoff.delivery.sentAt !== null && now - handoff.delivery.sentAt <= REARM_WINDOW_MS) this.watch(handoff, now);
    }
  }

  arm(handoff: MaterialHandoff): void {
    this.watch(handoff, null);
  }

  scanNow(handoffId: string): Promise<void> {
    const armed = this.armed.get(handoffId);
    const folder = armed ? this.folders.get(armed.folder) : undefined;
    return folder ? this.enqueue(() => this.scan(folder)) : Promise.resolve();
  }

  dispose(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    for (const folder of this.folders.values()) {
      folder.handle?.close();
      if (folder.timer !== null) clearTimeout(folder.timer);
    }
    this.folders.clear();
    this.armed.clear();
  }

  private watch(handoff: MaterialHandoff, restoredAt: number | null): void {
    if (!handoff.resultsFolder || handoff.delivery.sentAt === null || this.armed.has(handoff.id)) return;
    if (handoff.delivery.state !== "submitted" && handoff.delivery.state !== "pasted") return;
    this.armed.set(handoff.id, {
      handoffId: handoff.id,
      number: handoff.number,
      sessionId: handoff.sessionId,
      folder: handoff.resultsFolder,
      since: handoff.delivery.sentAt - MTIME_TOLERANCE_MS,
      closedAt: restoredAt !== null && handoff.delivery.turnEndedAt === null ? restoredAt : null,
      report: null,
      added: 0
    });
    const folder = this.folders.get(handoff.resultsFolder) ?? this.watchFolder(handoff.resultsFolder, restoredAt === null);
    this.schedule(folder);
  }

  private watchFolder(path: string, addsCards: boolean): WatchedFolder {
    const folder: WatchedFolder = { path, handle: null, timer: null, seen: new Map(), addsCards };
    this.folders.set(path, folder);
    try {
      folder.handle = (this.options.watchFactory ?? nodeWatchFactory)(path, () => this.schedule(folder), () => {
        folder.handle = null;
      });
    } catch {
      folder.handle = null;
    }
    return folder;
  }

  private schedule(folder: WatchedFolder): void {
    if (folder.timer !== null || !this.folders.has(folder.path)) return;
    folder.timer = setTimeout(() => {
      folder.timer = null;
      void this.enqueue(() => this.scan(folder));
    }, SCAN_DELAY_MS);
    folder.timer.unref?.();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async scan(folder: WatchedFolder): Promise<void> {
    const armed = [...this.armed.values()].filter((candidate) => candidate.folder === folder.path);
    if (armed.length === 0) return;
    if (await realpath(folder.path).catch(() => folder.path) !== folder.path) {
      for (const candidate of armed) this.armed.delete(candidate.handoffId);
      this.closeFolder(folder);
      return;
    }
    const entries = (await readdir(folder.path).catch(() => [])).sort().slice(0, RESULTS_SCAN_LIMIT);
    const addsCards = folder.addsCards;
    folder.addsCards = true;
    const handoffs = this.options.materials.snapshot().handoffs;
    const ends = new Map(armed.map((candidate) => [candidate, this.windowEnd(candidate, handoffs)]));
    const earliest = Math.min(...armed.map((candidate) => candidate.since));
    const changed = new Map<ArmedHandoff | null, string[]>();
    for (const entry of entries) {
      if (IGNORED.test(entry)) continue;
      const path = join(folder.path, entry);
      let info;
      try {
        info = await lstat(path);
      } catch {
        continue;
      }
      if (!info.isFile() || info.mtimeMs < earliest) continue;
      const signature = `${info.size}:${info.mtimeMs}`;
      const report = REPORT_NAME.exec(entry);
      if (report) {
        const owner = armed.find((candidate) => candidate.number === Number(report[1]));
        if (!owner || info.mtimeMs < owner.since || owner.report === signature) continue;
        owner.report = signature;
        const parsed = await readReport(path);
        if (!parsed) continue;
        this.options.materials.confirmDelivery(owner.handoffId);
        this.options.materials.applyReport(owner.handoffId, parsed.fixed, parsed.note);
        continue;
      }
      if (folder.seen.get(entry) === signature) continue;
      folder.seen.set(entry, signature);
      const owner = this.owner(armed, ends, info.mtimeMs);
      changed.set(owner, [...(changed.get(owner) ?? []), path]);
    }
    for (const [owner, paths] of changed) {
      const origin: MaterialOrigin = {
        kind: "result",
        folderName: basename(folder.path),
        handoff: owner ? { id: owner.handoffId, number: owner.number } : null
      };
      const known = new Set(await this.options.materials.retagResults(paths, origin, folder.path));
      if (!addsCards) continue;
      const charged = owner ?? armed.reduce((latest, candidate) => candidate.number > latest.number ? candidate : latest);
      const fresh = paths.filter((path) => !known.has(path)).slice(0, Math.max(0, RESULT_FILE_LIMIT - charged.added));
      if (fresh.length === 0) continue;
      const outcome = await this.options.materials.addPaths(fresh, this.placement(charged), origin, folder.path);
      charged.added += outcome.added.length;
    }
    this.disarmClosed(folder, armed, ends);
  }

  private windowEnd(armed: ArmedHandoff, handoffs: readonly MaterialHandoff[]): number {
    const handoff = handoffs.find((candidate) => candidate.id === armed.handoffId);
    const next = handoffs
      .filter((candidate) => candidate.sessionId === armed.sessionId && candidate.number > armed.number && candidate.delivery.sentAt !== null)
      .sort((left, right) => left.number - right.number)[0];
    return handoff?.delivery.turnEndedAt
      ?? armed.closedAt
      ?? next?.delivery.sentAt
      ?? armed.since + MTIME_TOLERANCE_MS + WINDOW_CAP_MS;
  }

  private owner(armed: readonly ArmedHandoff[], ends: ReadonlyMap<ArmedHandoff, number>, modifiedAt: number): ArmedHandoff | null {
    const candidates = armed.filter((candidate) => modifiedAt >= candidate.since && modifiedAt <= ends.get(candidate)! + MTIME_TOLERANCE_MS);
    return candidates.length === 1 ? candidates[0] : null;
  }

  private disarmClosed(folder: WatchedFolder, armed: readonly ArmedHandoff[], ends: ReadonlyMap<ArmedHandoff, number>): void {
    const now = this.now();
    for (const candidate of armed) {
      if (now > ends.get(candidate)! + DISARM_AFTER_MS) this.armed.delete(candidate.handoffId);
    }
    if (![...this.armed.values()].some((candidate) => candidate.folder === folder.path)) this.closeFolder(folder);
  }

  private closeFolder(folder: WatchedFolder): void {
    folder.handle?.close();
    if (folder.timer !== null) clearTimeout(folder.timer);
    this.folders.delete(folder.path);
  }

  private placement(armed: ArmedHandoff): Point {
    const snapshot = this.options.materials.snapshot();
    const handoff = snapshot.handoffs.find((candidate) => candidate.id === armed.handoffId);
    const firstRemark = snapshot.remarks.find((remark) => handoff?.remarkIds.includes(remark.id));
    const anchor = snapshot.materials.find((material) => material.id === firstRemark?.target.materialId);
    const results = snapshot.materials.filter((material) => material.origin?.kind === "result"
      && material.origin.handoff?.id === armed.handoffId);
    if (!anchor) return { x: 0, y: 0 };
    const lowest = results.reduce((bottom, material) => Math.max(bottom, material.position.y + material.size.height + 24), anchor.position.y);
    return { x: anchor.position.x + anchor.size.width + 48, y: results.length > 0 ? lowest : anchor.position.y };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

async function readReport(path: string): Promise<ResultReport | null> {
  const read = await readBounded(path, REPORT_BYTES_LIMIT);
  return read.ok ? parseReport(read.bytes.toString("utf8")) : null;
}

export function parseReport(text: string): ResultReport | null {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { fixed, note } = value as { fixed?: unknown; note?: unknown };
  if (!Array.isArray(fixed)) return null;
  const numbers = fixed
    .map((entry) => typeof entry === "string" ? Number(entry.replace(/^#/, "")) : entry)
    .filter((entry): entry is number => Number.isInteger(entry) && (entry as number) > 0);
  return {
    fixed: [...new Set(numbers)].slice(0, REPORT_FIXED_LIMIT),
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, REPORT_NOTE_LIMIT) : null
  };
}
