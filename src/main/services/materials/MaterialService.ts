import { randomUUID } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  CanvasMaterial,
  HandoffDelivery,
  MaterialCreateResult,
  MaterialDraft,
  MaterialFailure,
  MaterialHandoff,
  MaterialKind,
  MaterialOrigin,
  MaterialRemark,
  MaterialResult,
  MaterialsAddResult,
  MaterialsSnapshot,
  MaterialSaveResult,
  MaterialScenario,
  MaterialState,
  MaterialText,
  MaterialTextEdit,
  MaterialTextResult,
  MaterialVersion,
  MaterialVersionReason,
  MaterialVersionResult,
  Point,
  RemarkAnchor,
  RemarkDraft,
  RemarkPatch,
  RemarkResult,
  RemarkTarget,
  ScenarioStep,
  ScenarioStopReason,
  SessionBounds,
  Size
} from "../../../shared/contracts";
import {
  clampSize,
  formatClock,
  freeSpotBelow,
  MATERIAL_LIMIT,
  MATERIAL_SCHEME,
  MATERIAL_STORAGE_LIMIT,
  MATERIAL_VERSION_LIMIT,
  MATERIAL_VERSION_MAX_BYTES,
  materialCardSize,
  materialsAtPoint,
  materialType,
  REMARK_TEXT_LIMIT,
  SCENARIO_STEP_LIMIT,
  SCENARIO_TIME_LIMIT_MS
} from "../../../shared/materials.ts";
import { streamFile, textResponse } from "../fileResponse.ts";
import { IMAGE_HEADER_BYTES, imageDimensions } from "./imageDimensions.ts";
import { fileDigest, MaterialBlobError, MaterialBlobs } from "./MaterialBlobs.ts";
import { decodeText, encodeText, parseTextEdit, readBounded, replaceFile, TEXT_EDIT_LIMIT } from "./materialText.ts";
import { PAGE_SHOT_MAX_BYTES, parseCaptureInput, parseStartInput, parseStepInput } from "./pageCapture.ts";
import {
  emptyMaterialState,
  HANDOFF_LIMIT,
  isId,
  MATERIAL_STATE_VERSION,
  normalizeAnchor,
  normalizeMaterialState,
  REMARK_LIMIT,
  type StoredFileIdentity,
  type StoredMaterial,
  type StoredMaterialState,
  type StoredScenario,
  type StoredVersion
} from "./materialState.ts";
import { DirectoryWatchSet, nodeWatchFactory, type WatchFactory } from "./materialWatch.ts";

const MAX_NAME = 255;
const CAPTURE_NAME_STEM_LIMIT = 120;
const MATERIAL_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const PERSIST_DELAY_MS = 250;
const REFRESH_DELAY_MS = 150;
const POLL_INTERVAL_MS = 10_000;
const RENAME_SCAN_LIMIT = 5_000;
const DRAFT_FILE_LIMIT = TEXT_EDIT_LIMIT * 7;
const RESPONSE_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff"
};

interface MaterialServiceOptions {
  userDataPath: string;
  persist(): boolean;
  emit(snapshot: MaterialsSnapshot): void;
  watchFactory?: WatchFactory;
  now?(): number;
  pollIntervalMs?: number;
  scenarioLimitMs?: number;
  storageLimitBytes?: number;
}

export interface MaterialVersionFile {
  materialId: string;
  versionId: string;
  number: number;
  name: string;
  kind: CanvasMaterial["kind"];
  mimeType: string;
  path: string;
  byteSize: number;
  natural: Size | null;
  location: string | null;
  origin: MaterialOrigin | null;
  steps: Array<ScenarioStep & { imagePath: string | null; imageMimeType: string | null; imageByteSize: number | null }> | null;
}

interface MaterialCaptureInput {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  origin: MaterialOrigin;
  point: Point;
  natural?: Size | null;
}

interface StateRead {
  state: StoredMaterialState;
  writable: boolean;
  collecting: boolean;
}

interface LiveState {
  state: MaterialState;
  signature: string | null;
  byteSize: number | null;
  modifiedAt: number | null;
  revision: number;
  movedTo: string | null;
}

export class MaterialService {
  private readonly options: MaterialServiceOptions;
  readonly handoffsPath: string;
  private readonly root: string;
  private readonly statePath: string;
  private readonly draftsPath: string;
  private readonly blobs: MaterialBlobs;
  private readonly materials = new Map<string, StoredMaterial>();
  private readonly drafts = new Map<string, MaterialDraft>();
  private draftQueue: Promise<void> = Promise.resolve();
  private remarks: MaterialRemark[] = [];
  private handoffs: MaterialHandoff[] = [];
  private counters = { remark: 0, handoff: 0 };
  private readonly live = new Map<string, LiveState>();
  private readonly watchers: DirectoryWatchSet;
  private readonly pendingRefresh = new Set<string>();
  private readonly storageLimit: number;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scenarioTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private writable = false;
  private collecting = false;
  private disposed = false;

  constructor(options: MaterialServiceOptions) {
    this.options = options;
    this.root = join(options.userDataPath, "materials");
    this.statePath = join(this.root, "state.json");
    this.draftsPath = join(this.root, "drafts");
    this.handoffsPath = join(this.root, "handoffs");
    this.blobs = new MaterialBlobs(join(this.root, "versions"));
    this.storageLimit = options.storageLimitBytes ?? MATERIAL_STORAGE_LIMIT;
    this.watchers = new DirectoryWatchSet(options.watchFactory ?? nodeWatchFactory, (ids) => this.scheduleRefresh(ids));
  }

  load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }

  private async restore(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const read = await this.readState();
    const state = this.options.persist() ? read.state : emptyMaterialState();
    for (const material of state.materials) {
      const versions: StoredVersion[] = [];
      for (const version of material.versions) if (await this.blobs.has(version.sha256)) versions.push(version);
      material.versions = versions;
      for (const step of material.scenario?.steps ?? []) {
        if (step.image && !await this.blobs.has(step.image.sha256)) step.image = null;
      }
      if (this.disposed) return;
      if (material.path === null && versions.length === 0 && !material.scenario) continue;
      this.materials.set(material.id, material);
    }
    this.remarks = state.remarks
      .filter((remark) => this.materials.has(remark.target.materialId))
      .map((remark) => remark.reference && !this.hasVersion(remark.reference.materialId, remark.reference.versionId) ? { ...remark, reference: null } : remark);
    this.handoffs = state.handoffs;
    this.counters = state.counters;
    this.writable = read.writable;
    this.collecting = read.collecting;
    for (const material of this.materials.values()) {
      if (material.scenario && material.versions.length === 0) await this.sealScenario(material).catch(() => undefined);
    }
    await this.collect();
    if (this.collecting) await this.loadDrafts();
    if (this.writable && !this.options.persist()) await rm(this.handoffsPath, { recursive: true, force: true }).catch(() => undefined);
    for (const material of this.materials.values()) {
      if (this.disposed) return;
      await this.refreshLive(material);
      this.watchers.track(material.id, material.path);
    }
    if (this.disposed) return;
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        this.watchers.retry();
        this.scheduleRefresh([...this.materials.keys()]);
      }, interval);
      this.pollTimer.unref?.();
    }
    this.scheduleScenarioLimit();
    this.changed(false);
  }

  snapshot(): MaterialsSnapshot {
    return {
      revision: this.revision,
      materials: [...this.materials.values()].map((material) => this.publicMaterial(material)),
      remarks: structuredClone(this.remarks),
      handoffs: structuredClone(this.handoffs),
      storage: { usedBytes: this.usedBytes(), limitBytes: this.storageLimit }
    };
  }

  location(id: string): string | null {
    return this.materials.get(id)?.path ?? null;
  }

  addPaths(paths: readonly unknown[], point: unknown, origin: MaterialOrigin | null = null, folder: string | null = null): Promise<MaterialsAddResult> {
    return this.serial(async () => {
      const result: MaterialsAddResult = { added: [], existing: [], rejected: [] };
      const fresh: StoredMaterial[] = [];
      const infos = new Map<string, BigIntStats>();
      if (paths.length > MATERIAL_LIMIT) result.rejected.push({ name: `+${paths.length - MATERIAL_LIMIT}`, reason: "limit" });
      for (const candidate of paths.slice(0, MATERIAL_LIMIT)) {
        const name = typeof candidate === "string" ? displayName(candidate) : "file";
        if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        let resolved: string;
        let info: BigIntStats;
        try {
          resolved = await realpath(candidate);
          info = await stat(resolved, { bigint: true });
        } catch {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        if (folder !== null && (resolved !== candidate || dirname(candidate) !== folder)) {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        if (!info.isFile()) {
          result.rejected.push({ name, reason: "not-a-file" });
          continue;
        }
        const existing = this.findByPath(resolved) ?? fresh.find((material) => material.path === resolved);
        if (existing) {
          if (!result.existing.includes(existing.id)) result.existing.push(existing.id);
          continue;
        }
        if (this.materials.size + fresh.length >= MATERIAL_LIMIT) {
          result.rejected.push({ name, reason: "limit" });
          continue;
        }
        const type = materialType(basename(resolved));
        const natural = type.kind === "image" ? await readImageDimensions(resolved) : null;
        const material: StoredMaterial = {
          id: randomUUID(),
          kind: type.kind,
          name,
          mimeType: type.mimeType,
          position: { x: 0, y: 0 },
          size: materialCardSize(type.kind, natural),
          path: resolved,
          identity: fileIdentity(info),
          origin: origin ? structuredClone(origin) : null,
          createdAt: this.now(),
          versions: [],
          nextVersion: 1,
          scenario: null
        };
        fresh.push(material);
        infos.set(material.id, info);
      }
      const placed = materialsAtPoint(fresh.map((material) => material.size), finitePoint(point));
      fresh.forEach((material, index) => {
        material.position = placed[index].position;
        this.materials.set(material.id, material);
        const info = infos.get(material.id)!;
        this.live.set(material.id, {
          state: "ready",
          signature: signatureOf(info),
          byteSize: Number(info.size),
          modifiedAt: Number(info.mtimeMs),
          revision: 1,
          movedTo: null
        });
        this.watchers.track(material.id, material.path);
        result.added.push(material.id);
      });
      if (fresh.length > 0) this.changed();
      return result;
    });
  }

  addCapture(input: MaterialCaptureInput): Promise<MaterialCreateResult> {
    return this.serial(async () => {
      if (this.materials.size >= MATERIAL_LIMIT) return failure("material-limit");
      let blob;
      try {
        blob = await this.blobs.writeFromBytes(input.bytes, MATERIAL_CAPTURE_MAX_BYTES, this.available());
      } catch (error) {
        return failure(blobFailure(error));
      }
      const type = materialType(input.name);
      const createdAt = this.now();
      const size = materialCardSize(type.kind, input.natural ?? null);
      const [placed] = materialsAtPoint([size], finitePoint(input.point));
      const material: StoredMaterial = {
        id: randomUUID(),
        kind: type.kind,
        name: displayName(input.name),
        mimeType: input.mimeType,
        position: placed.position,
        size,
        path: null,
        identity: null,
        origin: input.origin,
        createdAt,
        versions: [{
          id: randomUUID(),
          number: 1,
          sha256: blob.sha256,
          byteSize: blob.byteSize,
          mimeType: input.mimeType,
          createdAt,
          reason: "capture",
          signature: blob.sha256,
          natural: type.kind === "image" ? input.natural ?? null : null
        }],
        nextVersion: 2,
        scenario: null
      };
      this.materials.set(material.id, material);
      await this.refreshLive(material);
      this.changed();
      return { ok: true, materialId: material.id };
    });
  }

  captureBrowser(input: unknown): Promise<MaterialCreateResult> {
    const parsed = parseCaptureInput(input);
    if (!parsed) return Promise.resolve(failure("unreadable"));
    const host = new URL(parsed.url).host;
    return this.addCapture({
      bytes: parsed.shot.bytes,
      name: captureName(parsed.title, host, parsed.shot.mimeType === "image/png" ? "png" : "jpg"),
      mimeType: parsed.shot.mimeType,
      origin: { kind: "browser", url: parsed.url, title: parsed.title, viewport: parsed.viewport, elements: parsed.elements },
      point: parsed.point,
      natural: parsed.shot.natural
    });
  }

  startScenario(input: unknown): Promise<MaterialCreateResult> {
    return this.serial(async () => {
      const parsed = parseStartInput(input);
      if (!parsed) return failure("unreadable");
      if (this.materials.size >= MATERIAL_LIMIT) return failure("material-limit");
      const size = materialCardSize("scenario", null);
      const [placed] = materialsAtPoint([size], finitePoint(parsed.point));
      const material: StoredMaterial = {
        id: randomUUID(),
        kind: "scenario",
        name: captureName(parsed.title, new URL(parsed.url).host, "scenario.json"),
        mimeType: "application/json",
        position: placed.position,
        size,
        path: null,
        identity: null,
        origin: { kind: "browser", url: parsed.url, title: parsed.title, viewport: parsed.viewport, elements: [] },
        createdAt: this.now(),
        versions: [],
        nextVersion: 1,
        scenario: { state: "recording", startedAt: this.now(), endedAt: null, viewport: parsed.viewport, stopReason: null, steps: [] }
      };
      this.materials.set(material.id, material);
      await this.refreshLive(material);
      this.scheduleScenarioLimit();
      this.changed();
      return { ok: true, materialId: material.id };
    });
  }

  addScenarioStep(id: string, input: unknown): Promise<MaterialResult> {
    return this.serial(async () => {
      const material = this.materials.get(id);
      const scenario = material?.scenario;
      if (!material || !scenario || scenario.state !== "recording") return failure("unavailable");
      if (this.now() - scenario.startedAt > this.scenarioLimit()) {
        await this.finishScenario(material, "limit");
        return failure("unavailable");
      }
      const step = parseStepInput(input);
      if (!step) return failure("unreadable");
      let image = null;
      if (step.shot) {
        try {
          const blob = await this.blobs.writeFromBytes(step.shot.bytes, PAGE_SHOT_MAX_BYTES, this.available());
          image = { sha256: blob.sha256, byteSize: blob.byteSize, mimeType: step.shot.mimeType, natural: step.shot.natural };
        } catch (error) {
          if (!(error instanceof MaterialBlobError) || error.code === "unreadable") return failure("unreadable");
        }
      }
      scenario.steps.push({
        index: scenario.steps.length,
        kind: step.kind,
        at: this.now(),
        url: step.url,
        title: step.title,
        point: step.point,
        element: step.element,
        text: step.text,
        image
      });
      if (scenario.steps.length >= SCENARIO_STEP_LIMIT) await this.finishScenario(material, "limit");
      this.changed();
      return { ok: true };
    });
  }

  stopScenario(id: string, reason: unknown): Promise<MaterialResult> {
    return this.serial(async () => {
      const material = this.materials.get(id);
      if (!material?.scenario) return failure("unavailable");
      const result = await this.finishScenario(material, reason === "limit" || reason === "browser-closed" ? reason : "stopped");
      this.changed();
      return result;
    });
  }

  async readText(id: string, versionId: string | null): Promise<MaterialTextResult> {
    const material = this.materials.get(id);
    if (!material || material.kind !== "text") return failure("unavailable");
    if (versionId === null && material.path !== null) {
      const live = await this.readLiveText(material.path);
      return live.ok ? { ok: true, content: live.content } : live;
    }
    const version = versionId === null
      ? material.versions.at(-1)
      : material.versions.find((candidate) => candidate.id === versionId);
    if (!version) return failure("unavailable");
    const read = await readBounded(this.blobs.pathOf(version.sha256), TEXT_EDIT_LIMIT);
    if (!read.ok) return read;
    const content = decodeText(read.bytes);
    return content ? { ok: true, content: { ...content, editable: false } } : failure("not-text");
  }

  saveText(id: string, edit: unknown): Promise<MaterialSaveResult> {
    return this.serial(async () => {
      const material = this.materials.get(id);
      if (!material || material.kind !== "text" || material.path === null) return failure("unavailable");
      const parsed = parseTextEdit(edit);
      if (!parsed) return failure(tooLargeEdit(edit) ? "too-large" : "unavailable");
      const current = await this.readLiveText(material.path);
      if (!current.ok) return current;
      if (current.content.hash !== parsed.baseHash) return { ok: false, reason: "conflict", current: current.content };
      if (!current.content.editable) return failure("read-only");
      const bytes = encodeText(parsed.text, current.content.eol, current.content.bom);
      if (bytes.length > TEXT_EDIT_LIMIT) return failure("too-large");
      const next = decodeText(bytes);
      if (!next) return failure("not-text");
      if (next.hash === current.content.hash) {
        let existed: boolean;
        try {
          existed = await this.dropDraftStrict(id);
        } catch {
          return failure("write-failed");
        }
        if (existed) this.changed(false);
        return { ok: true, content: current.content, previous: null };
      }
      const kept = await this.createVersion(id, "edit");
      if (!kept.ok && !allowsUnversioned(edit)) return kept;
      if (kept.ok) {
        try {
          await this.writeState(true);
        } catch {
          return failure("write-failed");
        }
      }
      const latest = await this.readLiveText(material.path);
      if (!latest.ok) return latest;
      if (latest.content.hash !== parsed.baseHash) return { ok: false, reason: "conflict", current: latest.content };
      try {
        await replaceFile(material.path, bytes, latest.mode);
      } catch {
        return failure("write-failed");
      }
      try {
        await this.dropDraftStrict(id);
      } catch {
        return failure("write-failed");
      }
      await this.refreshLive(material, true);
      this.changed();
      return { ok: true, content: next, previous: kept.ok ? kept.version : null };
    });
  }

  readDraft(id: string): MaterialDraft | null {
    const draft = this.drafts.get(id);
    return draft ? { ...draft } : null;
  }

  writeDraft(id: string, edit: unknown): Promise<MaterialResult> {
    const material = this.materials.get(id);
    if (!material || material.kind !== "text" || material.path === null) return Promise.resolve(failure("unavailable"));
    const parsed = parseTextEdit(edit, DRAFT_FILE_LIMIT);
    if (!parsed) return Promise.resolve(failure(tooLargeEdit(edit, DRAFT_FILE_LIMIT) ? "too-large" : "unavailable"));
    const candidate = { ...parsed, updatedAt: this.now() };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > DRAFT_FILE_LIMIT) return Promise.resolve(failure("too-large"));
    const previous = this.drafts.get(id);
    this.drafts.set(id, candidate);
    if (previous?.baseHash !== parsed.baseHash) this.changed(false);
    return this.persistDraft(id);
  }

  discardDraft(id: string): void {
    if (!this.materials.has(id)) return;
    if (this.dropDraft(id)) this.changed(false);
  }

  setBounds(id: string, bounds: unknown): void {
    const material = this.materials.get(id);
    if (!material || !isBounds(bounds)) return;
    material.position = { x: bounds.position.x, y: bounds.position.y };
    material.size = clampSize(bounds.size);
    this.changed();
  }

  setBoundsBatch(entries: ReadonlyArray<{ id: unknown; bounds: unknown }>): void {
    let touched = false;
    for (const entry of entries) {
      const material = typeof entry?.id === "string" ? this.materials.get(entry.id) : undefined;
      if (!material || !isBounds(entry.bounds)) continue;
      material.position = { x: entry.bounds.position.x, y: entry.bounds.position.y };
      material.size = clampSize(entry.bounds.size);
      touched = true;
    }
    if (touched) this.changed();
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.materials.delete(id)) return;
      this.remarks = this.remarks
        .filter((remark) => remark.target.materialId !== id)
        .map((remark) => remark.reference?.materialId === id ? { ...remark, reference: null } : remark);
      this.live.delete(id);
      this.pendingRefresh.delete(id);
      this.watchers.untrack(id);
      this.dropDraft(id);
      await this.collect();
      this.changed();
    });
  }

  pinVersion(id: string, reason: MaterialVersionReason = "pinned"): Promise<MaterialVersionResult> {
    return this.serial(() => this.createVersion(id, reason));
  }

  addRemark(draft: unknown): Promise<RemarkResult> {
    return this.serial(async () => {
      const parsed = parseRemarkDraft(draft);
      if (!parsed || !this.materials.has(parsed.materialId)) return failure("unavailable");
      if (parsed.reference && !this.materials.has(parsed.reference.materialId)) return failure("unavailable");
      if (!anchorFits(this.materials.get(parsed.materialId)!, parsed.anchor)) return failure("kind-mismatch");
      if (parsed.reference && !anchorFits(this.materials.get(parsed.reference.materialId)!, parsed.reference.anchor)) {
        return failure("kind-mismatch");
      }
      if (this.remarks.length >= REMARK_LIMIT) return failure("remark-limit");
      if (!await this.versionable(parsed.materialId) || (parsed.reference && !await this.versionable(parsed.reference.materialId))) {
        return failure("unavailable");
      }
      const target = await this.createVersion(parsed.materialId, "remark");
      if (!target.ok) return target;
      let reference: RemarkTarget | null = null;
      if (parsed.reference) {
        const referenceVersion = await this.createVersion(parsed.reference.materialId, "remark");
        if (!referenceVersion.ok) return referenceVersion;
        reference = {
          materialId: parsed.reference.materialId,
          versionId: referenceVersion.version.id,
          anchor: parsed.reference.anchor
        };
      }
      const now = this.now();
      this.counters.remark += 1;
      const remark: MaterialRemark = {
        id: randomUUID(),
        number: this.counters.remark,
        target: { materialId: parsed.materialId, versionId: target.version.id, anchor: parsed.anchor },
        reference,
        text: parsed.text,
        status: "open",
        createdAt: now,
        updatedAt: now,
        handoffIds: [],
        report: null
      };
      this.remarks.push(remark);
      this.changed();
      return { ok: true, remark: structuredClone(remark) };
    });
  }

  updateRemark(id: string, patch: unknown): Promise<RemarkResult> {
    return this.serial(async () => {
      const remark = this.remarks.find((candidate) => candidate.id === id);
      const parsed = parseRemarkPatch(patch);
      if (!remark || !parsed) return failure("unavailable");
      if (parsed.text !== undefined && remark.status !== "open" && remark.status !== "reopened") return failure("unavailable");
      if (parsed.status !== undefined && !remarkTransitionAllowed(remark.status, parsed.status)) return failure("unavailable");
      if (parsed.text !== undefined) remark.text = parsed.text;
      if (parsed.status !== undefined) remark.status = parsed.status;
      remark.updatedAt = this.now();
      this.changed();
      return { ok: true, remark: structuredClone(remark) };
    });
  }

  deleteRemark(id: string): Promise<void> {
    return this.serial(async () => {
      const before = this.remarks.length;
      this.remarks = this.remarks.filter((remark) => remark.id !== id);
      if (this.remarks.length !== before) this.changed();
    });
  }

  remark(id: string): MaterialRemark | null {
    const remark = this.remarks.find((candidate) => candidate.id === id);
    return remark ? structuredClone(remark) : null;
  }

  material(id: string): CanvasMaterial | null {
    const material = this.materials.get(id);
    return material ? this.publicMaterial(material) : null;
  }

  versionFile(materialId: string, versionId: string): MaterialVersionFile | null {
    const material = this.materials.get(materialId);
    const version = material?.versions.find((candidate) => candidate.id === versionId);
    if (!material || !version) return null;
    return {
      materialId,
      versionId,
      number: version.number,
      name: material.name,
      kind: material.kind,
      mimeType: version.mimeType,
      path: this.blobs.pathOf(version.sha256),
      byteSize: version.byteSize,
      natural: version.natural,
      location: material.path,
      origin: material.origin ? structuredClone(material.origin) : null,
      steps: material.scenario ? material.scenario.steps.map((step) => ({
        ...publicScenario({ ...material.scenario!, steps: [step] }).steps[0],
        imagePath: step.image ? this.blobs.pathOf(step.image.sha256) : null,
        imageMimeType: step.image?.mimeType ?? null,
        imageByteSize: step.image?.byteSize ?? null
      })) : null
    };
  }

  nextHandoffNumber(): number {
    return this.counters.handoff + 1;
  }

  recordHandoff(handoff: MaterialHandoff): void {
    this.counters.handoff = Math.max(this.counters.handoff, handoff.number);
    this.handoffs = [...this.handoffs, structuredClone(handoff)].slice(-HANDOFF_LIMIT);
    this.changed();
  }

  updateHandoffDelivery(id: string, delivery: Partial<HandoffDelivery>): void {
    const handoff = this.handoffs.find((candidate) => candidate.id === id);
    if (!handoff) return;
    handoff.delivery = { ...handoff.delivery, ...delivery };
    this.changed();
  }

  latestHandoff(sessionId: string): MaterialHandoff | null {
    for (let index = this.handoffs.length - 1; index >= 0; index -= 1) {
      const handoff = this.handoffs[index];
      if (handoff.sessionId !== sessionId) continue;
      return handoff.delivery.state === "submitted" || handoff.delivery.state === "pasted" ? structuredClone(handoff) : null;
    }
    return null;
  }

  confirmDelivery(handoffId: string): void {
    const handoff = this.handoffs.find((candidate) => candidate.id === handoffId);
    if (!handoff || handoff.delivery.state !== "pasted") return;
    handoff.delivery = { ...handoff.delivery, state: "submitted", note: null };
    const newer = new Set(this.handoffs.filter((candidate) => candidate.number > handoff.number).map((candidate) => candidate.id));
    const current = handoff.remarkIds.filter((id) => !newer.has(this.remarks.find((remark) => remark.id === id)?.handoffIds.at(-1) ?? ""));
    this.markRemarksSent(current, handoff.id);
  }

  handoff(id: string): MaterialHandoff | null {
    const handoff = this.handoffs.find((candidate) => candidate.id === id);
    return handoff ? structuredClone(handoff) : null;
  }

  markRemarksSent(remarkIds: readonly string[], handoffId: string): void {
    const now = this.now();
    for (const remark of this.remarks) {
      if (!remarkIds.includes(remark.id)) continue;
      if (remark.status === "accepted" || remark.status === "reported") continue;
      remark.status = "sent";
      remark.report = null;
      remark.handoffIds = [...remark.handoffIds, handoffId].slice(-HANDOFF_LIMIT);
      remark.updatedAt = now;
    }
    this.changed();
  }

  applyReport(handoffId: string, numbers: readonly number[], note: string | null): number {
    const handoff = this.handoffs.find((candidate) => candidate.id === handoffId);
    if (!handoff) return 0;
    const now = this.now();
    let applied = 0;
    const reportNote = note ? note.slice(0, REMARK_TEXT_LIMIT) : null;
    for (const remark of this.remarks) {
      if (!handoff.remarkIds.includes(remark.id) || !numbers.includes(remark.number)) continue;
      if (remark.status !== "sent" && remark.status !== "reported") continue;
      if (remark.handoffIds.at(-1) !== handoffId) continue;
      if (remark.status === "reported" && remark.report?.handoffId === handoffId && remark.report.note === reportNote) continue;
      remark.status = "reported";
      remark.report = { handoffId, at: now, note: reportNote };
      remark.updatedAt = now;
      applied += 1;
    }
    if (applied > 0) this.changed();
    return applied;
  }

  relink(id: string, candidate: unknown): Promise<MaterialResult> {
    return this.serial(() => this.relinkTo(id, candidate, false));
  }

  acceptMove(id: string): Promise<MaterialResult> {
    return this.serial(async () => {
      const movedTo = this.live.get(id)?.movedTo;
      return movedTo ? this.relinkTo(id, movedTo, true) : failure("unavailable");
    });
  }

  async protocolResponse(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${MATERIAL_SCHEME}:`) return textResponse("Unsupported protocol.", 400);
      const material = this.materials.get(decodeURIComponent(url.hostname));
      if (!material) return textResponse("Material is unavailable.", 404);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "live" && parts.length === 1) {
        if (material.path === null) {
          const latest = material.versions.at(-1);
          return latest ? await this.streamVersion(request, latest) : textResponse("Material is unavailable.", 404);
        }
        const resolved = await realpath(material.path);
        const info = await stat(resolved);
        if (resolved !== material.path || !info.isFile()) return textResponse("Material is unavailable.", 404);
        return await streamFile(request, resolved, material.mimeType, RESPONSE_HEADERS);
      }
      if (parts[0] === "step" && parts.length === 2 && material.scenario) {
        const image = material.scenario.steps[Number(parts[1])]?.image;
        return image
          ? await streamFile(request, this.blobs.pathOf(image.sha256), image.mimeType, RESPONSE_HEADERS)
          : textResponse("Step is unavailable.", 404);
      }
      if (parts[0] === "v" && parts.length === 2) {
        const version = material.versions.find((candidate) => candidate.id === parts[1]);
        return version ? await this.streamVersion(request, version) : textResponse("Version is unavailable.", 404);
      }
      return textResponse("Material is unavailable.", 404);
    } catch {
      return textResponse("Material is unavailable.", 404);
    }
  }

  async flush(strict = false): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeState(strict);
    if (this.options.persist()) for (const id of this.drafts.keys()) await this.persistDraft(id);
    await this.draftQueue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    if (this.scenarioTimer !== null) clearTimeout(this.scenarioTimer);
    this.watchers.close();
    await this.loading?.catch(() => undefined);
    await this.queue;
    await this.flush();
    if (this.writable && !this.options.persist()) {
      await this.blobs.collect(new Set());
      await rm(this.handoffsPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async createVersion(id: string, reason: MaterialVersionReason): Promise<MaterialVersionResult> {
    const material = this.materials.get(id);
    if (!material) return failure("unavailable");
    const latest = material.versions.at(-1);
    if (material.path === null) {
      if (!latest && material.scenario?.state === "done") {
        const sealed = await this.finishScenario(material, material.scenario.stopReason ?? "stopped");
        if (!sealed.ok) return sealed;
        this.changed();
      }
      const kept = material.versions.at(-1);
      return kept ? { ok: true, version: this.publicVersion(material, kept) } : failure("unavailable");
    }
    await this.refreshLive(material);
    const live = this.live.get(id);
    if (live?.state !== "ready") return failure("unavailable");
    if (latest && latest.signature !== null && latest.signature === live.signature) {
      if (reason === "pinned" && latest.reason !== "pinned") {
        latest.reason = "pinned";
        this.changed();
      }
      return { ok: true, version: this.publicVersion(material, latest) };
    }
    let blob;
    try {
      blob = await this.blobs.writeFromFile(material.path, MATERIAL_VERSION_MAX_BYTES, this.available());
    } catch (error) {
      return failure(blobFailure(error));
    }
    if (latest && latest.sha256 === blob.sha256) {
      latest.signature = live.signature;
      if (reason === "pinned" && latest.reason !== "pinned") {
        latest.reason = "pinned";
        this.changed();
      }
      return { ok: true, version: this.publicVersion(material, latest) };
    }
    if (material.versions.length >= MATERIAL_VERSION_LIMIT && !this.prunableVersion(material)) {
      await this.collect();
      return failure("version-limit");
    }
    const version: StoredVersion = {
      id: randomUUID(),
      number: material.nextVersion,
      sha256: blob.sha256,
      byteSize: blob.byteSize,
      mimeType: material.mimeType,
      createdAt: this.now(),
      reason,
      signature: live.signature,
      natural: material.kind === "image" ? await readImageDimensions(this.blobs.pathOf(blob.sha256)) : null
    };
    material.nextVersion += 1;
    material.versions.push(version);
    while (material.versions.length > MATERIAL_VERSION_LIMIT) {
      const prunable = this.prunableVersion(material);
      if (!prunable) break;
      material.versions = material.versions.filter((candidate) => candidate !== prunable);
    }
    await this.collect();
    this.changed();
    return { ok: true, version: this.publicVersion(material, version) };
  }

  private prunableVersion(material: StoredMaterial): StoredVersion | null {
    const kept = new Set<string>();
    for (const remark of this.remarks) {
      kept.add(remark.target.versionId);
      if (remark.reference) kept.add(remark.reference.versionId);
    }
    for (const handoff of this.handoffs) {
      if (handoff.delivery.state !== "sending") continue;
      for (const item of handoff.items) if (item.versionId) kept.add(item.versionId);
    }
    return material.versions.find((version) => version.reason !== "pinned" && !kept.has(version.id)) ?? null;
  }

  private async relinkTo(id: string, candidate: unknown, sameFileOnly: boolean): Promise<MaterialResult> {
    const material = this.materials.get(id);
    if (!material || material.path === null) return failure("unavailable");
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) return failure("unreadable");
    let resolved: string;
    let info: BigIntStats;
    try {
      resolved = await realpath(candidate);
      info = await stat(resolved, { bigint: true });
    } catch {
      return failure("unreadable");
    }
    if (!info.isFile()) return failure("not-a-file");
    if (sameFileOnly && (resolved !== candidate || !sameFile(info, material.identity))) return failure("unreadable");
    const other = this.findByPath(resolved);
    if (other && other.id !== id) return failure("already-on-canvas");
    const type = materialType(basename(resolved));
    if (type.kind !== material.kind) return failure("kind-mismatch");
    material.path = resolved;
    material.name = displayName(candidate);
    material.mimeType = type.mimeType;
    material.identity = fileIdentity(info);
    this.watchers.track(id, resolved);
    await this.refreshLive(material, true);
    this.changed();
    return { ok: true };
  }

  private async versionable(id: string): Promise<boolean> {
    const material = this.materials.get(id);
    if (!material) return false;
    if (material.path === null) return material.versions.length > 0 || material.scenario?.state === "done";
    await this.refreshLive(material);
    return this.live.get(id)?.state === "ready";
  }

  private streamVersion(request: Request, version: StoredVersion): Promise<Response> {
    return streamFile(request, this.blobs.pathOf(version.sha256), version.mimeType, RESPONSE_HEADERS);
  }

  private scheduleRefresh(ids: readonly string[]): void {
    if (this.disposed) return;
    for (const id of ids) this.pendingRefresh.add(id);
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const pending = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      void this.serial(async () => {
        let any = false;
        for (const id of pending) {
          const material = this.materials.get(id);
          if (material && await this.refreshLive(material)) any = true;
        }
        if (any) this.changed(false);
      });
    }, REFRESH_DELAY_MS);
    this.refreshTimer.unref?.();
  }

  private async refreshLive(material: StoredMaterial, forceRevision = false): Promise<boolean> {
    const previous = this.live.get(material.id);
    const next = material.path === null
      ? captureLive(material)
      : await inspectWorkingFile(material, previous);
    const changedContent = next.signature !== (previous?.signature ?? null);
    const latest = material.versions.at(-1);
    if (changedContent && material.path !== null && next.state === "ready" && latest && latest.signature !== next.signature
      && latest.byteSize === next.byteSize && await fileDigest(material.path, latest.byteSize) === latest.sha256) {
      latest.signature = next.signature;
    }
    const revision = previous
      ? previous.revision + (changedContent || forceRevision ? 1 : 0)
      : Math.max(1, next.revision);
    const updated: LiveState = { ...next, revision };
    if (next.state === "ready" && material.path !== null && next.identity) material.identity = next.identity;
    this.live.set(material.id, updated);
    return !previous
      || previous.state !== updated.state
      || previous.revision !== updated.revision
      || previous.movedTo !== updated.movedTo;
  }

  private publicMaterial(material: StoredMaterial): CanvasMaterial {
    const live = this.live.get(material.id);
    return {
      id: material.id,
      kind: material.kind,
      name: material.name,
      mimeType: material.mimeType,
      position: { ...material.position },
      size: { ...material.size },
      location: material.path,
      state: live?.state ?? "unreadable",
      movedTo: live?.movedTo ?? null,
      liveRevision: live?.revision ?? 1,
      byteSize: live?.byteSize ?? null,
      modifiedAt: live?.modifiedAt ?? null,
      origin: material.origin ? structuredClone(material.origin) : null,
      versions: material.versions.map((version) => this.publicVersion(material, version)),
      draft: this.drafts.has(material.id) ? { baseHash: this.drafts.get(material.id)!.baseHash } : null,
      scenario: material.scenario ? publicScenario(material.scenario) : null,
      createdAt: material.createdAt
    };
  }

  private publicVersion(material: StoredMaterial, version: StoredVersion): MaterialVersion {
    const live = this.live.get(material.id);
    const current = material.path === null
      ? material.versions.at(-1)?.id === version.id
      : live?.state === "ready" && version.signature !== null && live.signature === version.signature;
    return {
      id: version.id,
      number: version.number,
      createdAt: version.createdAt,
      byteSize: version.byteSize,
      reason: version.reason,
      current,
      natural: version.natural ? { ...version.natural } : null
    };
  }

  private hasVersion(materialId: string, versionId: string): boolean {
    return this.materials.get(materialId)?.versions.some((version) => version.id === versionId) ?? false;
  }

  private findByPath(path: string): StoredMaterial | undefined {
    for (const material of this.materials.values()) if (material.path === path) return material;
    return undefined;
  }

  private async readState(): Promise<StateRead> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return { state: emptyMaterialState(), writable: true, collecting: true };
      console.warn("CanvasTTY materials could not be read and are left on disk as they are.", error);
      return { state: emptyMaterialState(), writable: false, collecting: false };
    }
    const stored = parseJson(text) as { version?: unknown } | null;
    const version = stored && typeof stored === "object" ? stored.version : undefined;
    if (typeof version === "number" && version > MATERIAL_STATE_VERSION) {
      console.warn("CanvasTTY materials were saved by a newer CanvasTTY and are left on disk as they are.");
      return { state: emptyMaterialState(), writable: false, collecting: false };
    }
    if (version === MATERIAL_STATE_VERSION) return { state: normalizeMaterialState(stored), writable: true, collecting: true };
    const aside = `${this.statePath}.broken-${this.now()}`;
    try {
      await rename(this.statePath, aside);
    } catch (error) {
      console.warn("CanvasTTY materials could not be parsed and are left on disk as they are.", error);
      return { state: emptyMaterialState(), writable: false, collecting: false };
    }
    console.warn(`CanvasTTY materials could not be parsed and were moved to ${aside}.`);
    return { state: emptyMaterialState(), writable: true, collecting: false };
  }

  private async collect(): Promise<void> {
    try {
      await this.writeState(true);
    } catch {
      return;
    }
    if (this.collecting) await this.blobs.collect(this.referencedHashes());
  }

  private referencedHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const material of this.materials.values()) {
      for (const version of material.versions) hashes.add(version.sha256);
      for (const step of material.scenario?.steps ?? []) if (step.image) hashes.add(step.image.sha256);
    }
    return hashes;
  }

  private usedBytes(): number {
    const sizes = new Map<string, number>();
    for (const material of this.materials.values()) {
      for (const version of material.versions) sizes.set(version.sha256, version.byteSize);
      for (const step of material.scenario?.steps ?? []) if (step.image) sizes.set(step.image.sha256, step.image.byteSize);
    }
    let total = 0;
    for (const size of sizes.values()) total += size;
    return total;
  }

  private available(): number {
    return Math.max(0, this.storageLimit - this.usedBytes());
  }

  private scheduleScenarioLimit(): void {
    if (this.scenarioTimer !== null) {
      clearTimeout(this.scenarioTimer);
      this.scenarioTimer = null;
    }
    if (this.disposed) return;
    let soonest = Infinity;
    for (const material of this.materials.values()) {
      if (material.scenario?.state === "recording") soonest = Math.min(soonest, material.scenario.startedAt + this.scenarioLimit());
    }
    if (!Number.isFinite(soonest)) return;
    this.scenarioTimer = setTimeout(() => {
      this.scenarioTimer = null;
      void this.serial(async () => {
        let finished = false;
        for (const material of this.materials.values()) {
          if (material.scenario?.state === "recording" && this.now() - material.scenario.startedAt >= this.scenarioLimit()) {
            await this.finishScenario(material, "limit");
            finished = true;
          }
        }
        if (finished) this.changed();
        this.scheduleScenarioLimit();
      });
    }, Math.max(0, soonest - this.now()));
    this.scenarioTimer.unref?.();
  }

  private scenarioLimit(): number {
    return this.options.scenarioLimitMs ?? SCENARIO_TIME_LIMIT_MS;
  }

  private async finishScenario(material: StoredMaterial, reason: ScenarioStopReason): Promise<MaterialResult> {
    const scenario = material.scenario!;
    if (scenario.state === "recording") {
      scenario.state = "done";
      scenario.endedAt = this.now();
      scenario.stopReason = reason;
      this.scheduleScenarioLimit();
    }
    if (material.versions.length > 0) return { ok: true };
    try {
      await this.sealScenario(material);
      return { ok: true };
    } catch (error) {
      return failure(blobFailure(error));
    }
  }

  private async sealScenario(material: StoredMaterial): Promise<void> {
    const scenario = material.scenario!;
    const document = {
      kind: "canvastty-scenario",
      url: material.origin?.kind === "browser" ? material.origin.url : null,
      startedAt: scenario.startedAt,
      endedAt: scenario.endedAt,
      viewport: scenario.viewport,
      stopReason: scenario.stopReason,
      steps: scenario.steps.map((step) => ({ ...step, image: step.image ? { sha256: step.image.sha256, natural: step.image.natural } : null }))
    };
    const blob = await this.blobs.writeFromBytes(Buffer.from(JSON.stringify(document, null, 2), "utf8"), MATERIAL_CAPTURE_MAX_BYTES, this.available());
    const createdAt = this.now();
    material.versions.push({
      id: randomUUID(),
      number: material.nextVersion,
      sha256: blob.sha256,
      byteSize: blob.byteSize,
      mimeType: "application/json",
      createdAt,
      reason: "capture",
      signature: blob.sha256,
      natural: null
    });
    material.nextVersion += 1;
    await this.refreshLive(material, true);
  }

  private changed(persist = true): void {
    this.revision += 1;
    if (persist) this.schedulePersist();
    this.options.emit(this.snapshot());
  }

  private schedulePersist(): void {
    if (this.disposed) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeState();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref?.();
  }

  private writeState(strict = false): Promise<void> {
    if (!this.writable) return strict ? Promise.reject(new Error("CanvasTTY materials state is not writable.")) : this.writeQueue;
    const temporary = `${this.statePath}.tmp`;
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      const persist = this.options.persist();
      const snapshot = JSON.stringify(persist
        ? {
            version: MATERIAL_STATE_VERSION,
            materials: [...this.materials.values()],
            remarks: this.remarks,
            handoffs: this.handoffs,
            counters: this.counters
          }
        : emptyMaterialState());
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, this.statePath);
      if (!persist) {
        const cleanup = this.draftQueue.catch(() => undefined).then(() => rm(this.draftsPath, { recursive: true, force: true }));
        this.draftQueue = cleanup.catch(() => undefined);
        await cleanup;
      }
    });
    this.writeQueue = write.catch((error) => {
      console.warn("CanvasTTY materials could not be saved.", error);
    });
    return strict ? write : this.writeQueue;
  }

  private async readLiveText(path: string): Promise<{ ok: true; content: MaterialText; mode: number } | { ok: false; reason: MaterialFailure }> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch {
      return failure("unavailable");
    }
    if (resolved !== path) return failure("unreadable");
    const read = await readBounded(resolved, TEXT_EDIT_LIMIT);
    if (!read.ok) return read;
    const content = decodeText(read.bytes);
    return content ? { ok: true, content, mode: read.mode } : failure("not-text");
  }

  private async loadDrafts(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.draftsPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const id = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
      const material = this.materials.get(id);
      const file = join(this.draftsPath, entry);
      const read = material?.kind === "text" && material.path !== null ? await readBounded(file, DRAFT_FILE_LIMIT) : null;
      const value = read?.ok ? parseJson(read.bytes.toString("utf8")) : null;
      const edit = parseTextEdit(value, DRAFT_FILE_LIMIT);
      const updatedAt = (value as { updatedAt?: unknown } | null)?.updatedAt;
      if (!edit || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      this.drafts.set(id, { ...edit, updatedAt });
    }
  }

  private persistDraft(id: string): Promise<MaterialResult> {
    const draft = this.drafts.get(id);
    if (!draft || !this.writable || !this.options.persist()) return Promise.resolve({ ok: true });
    const file = join(this.draftsPath, `${id}.json`);
    const snapshot = JSON.stringify(draft);
    const write = this.draftQueue.catch(() => undefined).then(async (): Promise<MaterialResult> => {
      if (this.drafts.get(id) !== draft || !this.options.persist()) return { ok: true };
      await mkdir(this.draftsPath, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, file);
      return { ok: true };
    }).catch((error): MaterialResult => {
      console.warn("CanvasTTY could not save a text draft.", error);
      return failure("write-failed");
    });
    this.draftQueue = write.then(() => undefined);
    return write;
  }

  private dropDraft(id: string): boolean {
    const existed = this.drafts.delete(id);
    if (!isId(id) || !this.writable) return existed;
    const file = join(this.draftsPath, `${id}.json`);
    this.draftQueue = this.draftQueue.catch(() => undefined).then(() => rm(file, { force: true })).catch(() => undefined);
    return existed;
  }

  private async dropDraftStrict(id: string): Promise<boolean> {
    const existed = this.drafts.delete(id);
    if (!isId(id) || !this.writable) return existed;
    const file = join(this.draftsPath, `${id}.json`);
    const removal = this.draftQueue.catch(() => undefined).then(() => rm(file, { force: true }));
    this.draftQueue = removal.catch(() => undefined);
    await removal;
    return existed;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

type InspectedLive = LiveState & { identity?: StoredFileIdentity };

function captureLive(material: StoredMaterial): InspectedLive {
  const latest = material.versions.at(-1);
  return {
    state: latest || material.scenario ? "ready" : "unreadable",
    signature: latest?.sha256 ?? null,
    byteSize: latest?.byteSize ?? null,
    modifiedAt: latest?.createdAt ?? null,
    revision: latest?.number ?? 1,
    movedTo: null
  };
}

function finitePoint(point: unknown): Point {
  if (!point || typeof point !== "object") return { x: 0, y: 0 };
  const { x, y } = point as Partial<Point>;
  return {
    x: typeof x === "number" && Number.isFinite(x) ? x : 0,
    y: typeof y === "number" && Number.isFinite(y) ? y : 0
  };
}

async function inspectWorkingFile(material: StoredMaterial, previous: LiveState | undefined): Promise<InspectedLive> {
  const path = material.path!;
  try {
    const resolved = await realpath(path);
    const info = await stat(resolved, { bigint: true });
    if (!info.isFile()) return unavailable("unreadable", previous);
    if (resolved !== path) {
      const entry = await lstat(path).catch(() => null);
      return entry?.isFile() && sameFile(info, material.identity)
        ? { ...unavailable("moved", previous), movedTo: resolved }
        : unavailable("unreadable", previous);
    }
    return {
      state: "ready",
      signature: signatureOf(info),
      byteSize: Number(info.size),
      modifiedAt: Number(info.mtimeMs),
      revision: 1,
      movedTo: null,
      identity: fileIdentity(info)
    };
  } catch (error) {
    if (!isMissing(error)) return unavailable("unreadable", previous);
    const movedTo = await renamedTo(material, previous);
    return { ...unavailable(movedTo ? "moved" : "missing", previous), movedTo };
  }
}

async function renamedTo(material: StoredMaterial, previous: LiveState | undefined): Promise<string | null> {
  if (!material.identity) return null;
  if (previous?.state === "moved" && previous.movedTo) {
    const info = await stat(previous.movedTo, { bigint: true }).catch(() => null);
    return info?.isFile() && sameFile(info, material.identity) ? previous.movedTo : null;
  }
  if (previous && previous.state !== "ready") return null;
  return findRenamed(dirname(material.path!), material.identity);
}

function unavailable(state: MaterialState, previous: LiveState | undefined): InspectedLive {
  return {
    state,
    signature: null,
    byteSize: null,
    modifiedAt: previous?.modifiedAt ?? null,
    revision: 1,
    movedTo: null
  };
}

async function findRenamed(directory: string, identity: StoredFileIdentity): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, RENAME_SCAN_LIMIT)) {
    const candidate = join(directory, entry);
    try {
      const info = await stat(candidate, { bigint: true });
      if (info.isFile() && sameFile(info, identity)) return await realpath(candidate) === candidate ? candidate : null;
    } catch {
      continue;
    }
  }
  return null;
}

async function readImageDimensions(path: string): Promise<Size | null> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_HEADER_BYTES, 0);
    return imageDimensions(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function parseRemarkDraft(value: unknown): RemarkDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<RemarkDraft>;
  if (typeof draft.materialId !== "string" || typeof draft.text !== "string") return null;
  const anchor = normalizeAnchor(draft.anchor);
  const text = draft.text.trim();
  if (!anchor || text.length === 0 || text.length > REMARK_TEXT_LIMIT) return null;
  if (draft.reference === null || draft.reference === undefined) {
    return { materialId: draft.materialId, anchor, reference: null, text };
  }
  const referenceAnchor = normalizeAnchor(draft.reference.anchor);
  if (typeof draft.reference.materialId !== "string" || !referenceAnchor) return null;
  return { materialId: draft.materialId, anchor, reference: { materialId: draft.reference.materialId, anchor: referenceAnchor }, text };
}

function parseRemarkPatch(value: unknown): RemarkPatch | null {
  if (!value || typeof value !== "object") return null;
  const patch = value as RemarkPatch;
  const result: RemarkPatch = {};
  if (patch.text !== undefined) {
    if (typeof patch.text !== "string") return null;
    const text = patch.text.trim();
    if (text.length === 0 || text.length > REMARK_TEXT_LIMIT) return null;
    result.text = text;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "open" && patch.status !== "accepted" && patch.status !== "reopened") return null;
    result.status = patch.status;
  }
  return result.text === undefined && result.status === undefined ? null : result;
}

function remarkTransitionAllowed(from: MaterialRemark["status"], to: NonNullable<RemarkPatch["status"]>): boolean {
  if (to === "accepted") return from !== "accepted";
  if (to === "reopened") return from === "sent" || from === "reported" || from === "accepted";
  return from === "reopened";
}

function tooLargeEdit(edit: unknown, limit = TEXT_EDIT_LIMIT): boolean {
  const text = (edit as { text?: unknown } | null)?.text;
  return typeof text === "string" && Buffer.byteLength(text, "utf8") > limit;
}

function allowsUnversioned(edit: unknown): boolean {
  return (edit as { allowUnversioned?: unknown } | null)?.allowUnversioned === true;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function anchorFits(material: StoredMaterial, anchor: RemarkAnchor): boolean {
  switch (anchor.kind) {
    case "whole": return true;
    case "lines": return material.kind === "text";
    case "time": return material.kind === "video" || material.kind === "audio";
    case "page": return material.kind === "pdf";
    case "step": return material.scenario !== null && anchor.index < material.scenario.steps.length;
    case "region":
    case "point": return material.kind === "image";
  }
}

function signatureOf(info: BigIntStats): string {
  return `${info.size}:${info.mtimeNs}:${info.ino}`;
}

function fileIdentity(info: BigIntStats): StoredFileIdentity {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function sameFile(info: BigIntStats, identity: StoredFileIdentity | null): boolean {
  return identity !== null && String(info.dev) === identity.dev && String(info.ino) === identity.ino;
}

function displayName(path: string): string {
  return (basename(path) || "file").slice(0, MAX_NAME);
}

function captureName(title: string, fallback: string, extension: string): string {
  const stem = title.replace(/[\\/\u0000-\u001f\u007f]+/g, " ").trim() || fallback;
  return `${stem.slice(0, CAPTURE_NAME_STEM_LIMIT)}.${extension}`;
}

function publicScenario(scenario: StoredScenario): MaterialScenario {
  return {
    state: scenario.state,
    startedAt: scenario.startedAt,
    endedAt: scenario.endedAt,
    viewport: scenario.viewport ? { ...scenario.viewport } : null,
    stopReason: scenario.stopReason,
    steps: scenario.steps.map((step) => ({
      ...step,
      point: step.point ? { ...step.point } : null,
      element: step.element ? { ...step.element } : null,
      image: step.image ? { natural: { ...step.image.natural } } : null
    }))
  };
}

function isBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object") return false;
  const { position, size } = value as Partial<SessionBounds>;
  return Boolean(position && size)
    && [position!.x, position!.y, size!.width, size!.height].every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function blobFailure(error: unknown): MaterialFailure {
  return error instanceof MaterialBlobError ? error.code : "unreadable";
}

function failure(reason: MaterialFailure): { ok: false; reason: MaterialFailure } {
  return { ok: false, reason };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
