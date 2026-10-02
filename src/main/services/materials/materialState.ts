import { isAbsolute } from "node:path";
import type {
  HandoffDeliveryState,
  HandoffPasteNote,
  MaterialHandoff,
  MaterialKind,
  MaterialOrigin,
  MaterialRemark,
  MaterialScenario,
  MaterialVersionReason,
  PageElement,
  Point,
  ProviderId,
  RemarkAnchor,
  RemarkStatus,
  RemarkTarget,
  ScenarioStep,
  ScenarioStepKind,
  ScenarioStopReason,
  Size
} from "../../../shared/contracts";
import {
  clampSize,
  HANDOFF_NOTE_LIMIT,
  MATERIAL_LIMIT,
  MATERIAL_VERSION_LIMIT,
  PAGE_ELEMENT_LIMIT,
  REMARK_TEXT_LIMIT,
  SCENARIO_STEP_LIMIT,
  SCENARIO_TEXT_LIMIT
} from "../../../shared/materials.ts";

export const MATERIAL_STATE_VERSION = 1;
export const REMARK_LIMIT = 2_000;
export const HANDOFF_LIMIT = 200;
export const HANDOFF_REMARK_LIMIT = 50;

const KINDS: Record<MaterialKind, true> = { image: true, text: true, video: true, audio: true, pdf: true, file: true, scenario: true };
export const STEP_KINDS: ReadonlySet<ScenarioStepKind> = new Set(["start", "click", "navigate", "expectation", "tab-left", "tab-returned"]);
const STOP_REASONS: ReadonlySet<ScenarioStopReason> = new Set(["stopped", "limit", "browser-closed", "app-closed"]);
const IMAGE_MIME: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
const VERSION_REASONS: ReadonlySet<MaterialVersionReason> = new Set(["pinned", "remark", "capture", "edit"]);
const REMARK_STATUSES: ReadonlySet<RemarkStatus> = new Set(["open", "sent", "reported", "accepted", "reopened"]);
const DELIVERY_STATES: ReadonlySet<HandoffDeliveryState> = new Set(["sending", "submitted", "pasted", "failed"]);
const PASTE_NOTES: ReadonlySet<HandoffPasteNote> = new Set(["not-seen", "not-observed", "enter-failed"]);
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_ELEMENT_ROLE = 60;
export const MAX_ELEMENT_NAME = 200;
export const MAX_SESSION_ID = 120;
const MAX_NAME = 255;
const MAX_URL = 2_048;
const MAX_TITLE = 300;
const MAX_LINE = 10_000_000;
const MAX_TIME = 7 * 24 * 60 * 60;
const MAX_PAGE = 100_000;
const MAX_COUNT = 1_000_000_000;
const MIME_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/;

export interface StoredVersion {
  id: string;
  number: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  createdAt: number;
  reason: MaterialVersionReason;
  signature: string | null;
  natural: Size | null;
}

export interface StoredFileIdentity {
  dev: string;
  ino: string;
}

export interface StoredMaterial {
  id: string;
  kind: MaterialKind;
  name: string;
  mimeType: string;
  position: Point;
  size: Size;
  path: string | null;
  identity: StoredFileIdentity | null;
  origin: MaterialOrigin | null;
  createdAt: number;
  versions: StoredVersion[];
  nextVersion: number;
  scenario: StoredScenario | null;
}

export interface StoredStepImage {
  sha256: string;
  byteSize: number;
  mimeType: string;
  natural: Size;
}

export interface StoredScenarioStep extends Omit<ScenarioStep, "image"> {
  image: StoredStepImage | null;
}

export interface StoredScenario extends Omit<MaterialScenario, "steps"> {
  steps: StoredScenarioStep[];
}

export interface StoredMaterialState {
  version: typeof MATERIAL_STATE_VERSION;
  materials: StoredMaterial[];
  remarks: MaterialRemark[];
  handoffs: MaterialHandoff[];
  counters: { remark: number; handoff: number };
}

export function emptyMaterialState(): StoredMaterialState {
  return { version: MATERIAL_STATE_VERSION, materials: [], remarks: [], handoffs: [], counters: { remark: 0, handoff: 0 } };
}

export function normalizeMaterialState(candidate: unknown): StoredMaterialState {
  const state = emptyMaterialState();
  if (!isRecord(candidate) || candidate.version !== MATERIAL_STATE_VERSION || !Array.isArray(candidate.materials)) {
    return state;
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const value of candidate.materials) {
    if (state.materials.length >= MATERIAL_LIMIT) break;
    const material = normalizeMaterial(value);
    if (!material || ids.has(material.id) || (material.path !== null && paths.has(material.path))) continue;
    ids.add(material.id);
    if (material.path !== null) paths.add(material.path);
    state.materials.push(material);
  }
  const remarkIds = new Set<string>();
  if (Array.isArray(candidate.remarks)) {
    for (const value of candidate.remarks) {
      if (state.remarks.length >= REMARK_LIMIT) break;
      const remark = normalizeRemark(value);
      if (!remark || remarkIds.has(remark.id) || !ids.has(remark.target.materialId)) continue;
      remarkIds.add(remark.id);
      state.remarks.push(remark);
    }
  }
  if (Array.isArray(candidate.handoffs)) {
    const handoffIds = new Set<string>();
    for (const value of candidate.handoffs.slice(-HANDOFF_LIMIT)) {
      const handoff = normalizeHandoff(value);
      if (!handoff || handoffIds.has(handoff.id)) continue;
      handoffIds.add(handoff.id);
      state.handoffs.push(handoff);
    }
  }
  const counters = isRecord(candidate.counters) ? candidate.counters : {};
  state.counters = {
    remark: Math.max(counterValue(counters.remark), ...state.remarks.map((remark) => remark.number)),
    handoff: Math.max(counterValue(counters.handoff), ...state.handoffs.map((handoff) => handoff.number))
  };
  return state;
}

export function normalizeAnchor(value: unknown): RemarkAnchor | null {
  if (!isRecord(value)) return null;
  if (value.kind === "whole") return { kind: "whole" };
  if (value.kind === "point" && isUnit(value.x) && isUnit(value.y)) return { kind: "point", x: value.x, y: value.y };
  if (value.kind === "region" && isUnit(value.x) && isUnit(value.y) && isUnit(value.width) && isUnit(value.height)
    && value.width > 0 && value.height > 0 && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001) {
    return { kind: "region", x: value.x, y: value.y, width: value.width, height: value.height };
  }
  if (value.kind === "page" && isPageNumber(value.page)) return { kind: "page", page: value.page };
  if (value.kind === "step" && Number.isSafeInteger(value.index) && (value.index as number) >= 0 && (value.index as number) < SCENARIO_STEP_LIMIT) {
    return { kind: "step", index: value.index as number };
  }
  if (value.kind === "time" && isMediaTime(value.start) && (value.end === null || (isMediaTime(value.end) && value.end > value.start))) {
    return { kind: "time", start: value.start, end: value.end };
  }
  if (value.kind === "lines" && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && (value.start as number) >= 1 && (value.end as number) >= (value.start as number) && (value.end as number) <= MAX_LINE) {
    return { kind: "lines", start: value.start as number, end: value.end as number };
  }
  return null;
}

function normalizeTarget(value: unknown): RemarkTarget | null {
  if (!isRecord(value) || !isId(value.materialId) || !isId(value.versionId)) return null;
  const anchor = normalizeAnchor(value.anchor);
  return anchor ? { materialId: value.materialId, versionId: value.versionId, anchor } : null;
}

function normalizeRemark(value: unknown): MaterialRemark | null {
  if (!isRecord(value) || !isId(value.id) || !isCount(value.number)) return null;
  const target = normalizeTarget(value.target);
  const reference = value.reference === null ? null : normalizeTarget(value.reference);
  if (!target || (value.reference !== null && !reference)) return null;
  if (typeof value.text !== "string" || value.text.length > REMARK_TEXT_LIMIT) return null;
  if (typeof value.status !== "string" || !REMARK_STATUSES.has(value.status as RemarkStatus)) return null;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return null;
  const handoffIds = Array.isArray(value.handoffIds) ? value.handoffIds.filter(isId).slice(-HANDOFF_LIMIT) : [];
  const report = isRecord(value.report) && isId(value.report.handoffId) && isFiniteNumber(value.report.at)
    ? {
        handoffId: value.report.handoffId,
        at: value.report.at,
        note: typeof value.report.note === "string" ? value.report.note.slice(0, REMARK_TEXT_LIMIT) : null
      }
    : null;
  return {
    id: value.id,
    number: value.number,
    target,
    reference,
    text: value.text,
    status: value.status as RemarkStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    handoffIds,
    report
  };
}

function normalizeHandoff(value: unknown): MaterialHandoff | null {
  if (!isRecord(value) || !isId(value.id) || !isCount(value.number)) return null;
  if (!isFiniteNumber(value.createdAt) || typeof value.sessionId !== "string" || value.sessionId.length > MAX_SESSION_ID) return null;
  if (typeof value.sessionTitle !== "string" || typeof value.provider !== "string" || !PROVIDER_PATTERN.test(value.provider)) return null;
  if (!Array.isArray(value.remarkIds) || typeof value.note !== "string" || typeof value.folder !== "string" || !isAbsolute(value.folder)) return null;
  if (value.resultsFolder !== null && (typeof value.resultsFolder !== "string" || !isAbsolute(value.resultsFolder))) return null;
  const delivery = isRecord(value.delivery) ? value.delivery : null;
  if (!delivery || typeof delivery.state !== "string" || !DELIVERY_STATES.has(delivery.state as HandoffDeliveryState)) return null;
  const items = Array.isArray(value.items) ? value.items.flatMap((item) => (
    isRecord(item) && isId(item.materialId) && (item.versionId === null || isId(item.versionId)) && typeof item.editable === "boolean"
      ? [{ materialId: item.materialId, versionId: item.versionId as string | null, editable: item.editable }]
      : []
  )).slice(0, HANDOFF_REMARK_LIMIT * 2) : [];
  const state = delivery.state === "sending" ? "failed" : delivery.state as HandoffDeliveryState;
  return {
    id: value.id,
    number: value.number,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    sessionTitle: value.sessionTitle.slice(0, MAX_TITLE),
    provider: value.provider as ProviderId,
    remarkIds: value.remarkIds.filter(isId).slice(0, HANDOFF_REMARK_LIMIT),
    items,
    note: value.note.slice(0, HANDOFF_NOTE_LIMIT),
    folder: value.folder,
    resultsFolder: value.resultsFolder as string | null,
    sessionStartedAt: isFiniteNumber(value.sessionStartedAt) ? value.sessionStartedAt : null,
    delivery: {
      state,
      imagesExpected: counterValue(delivery.imagesExpected),
      imagesAttached: counterValue(delivery.imagesAttached),
      sentAt: isFiniteNumber(delivery.sentAt) ? delivery.sentAt : null,
      turnStartedAt: isFiniteNumber(delivery.turnStartedAt) ? delivery.turnStartedAt : null,
      turnEndedAt: isFiniteNumber(delivery.turnEndedAt) ? delivery.turnEndedAt : null,
      note: state === "pasted" && typeof delivery.note === "string" && PASTE_NOTES.has(delivery.note as HandoffPasteNote)
        ? delivery.note as HandoffPasteNote
        : null,
      error: delivery.state === "sending"
        ? "CanvasTTY closed while sending."
        : typeof delivery.error === "string" ? delivery.error.slice(0, 500) : null,
      stateSaved: delivery.stateSaved !== false
    }
  };
}

function counterValue(value: unknown): number {
  return isCount(value) ? value : 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_COUNT;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isUnit(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function normalizeMaterial(value: unknown): StoredMaterial | null {
  if (!isRecord(value)) return null;
  const { id, kind, name, mimeType, position, size, path, identity, origin, createdAt, versions, nextVersion, scenario } = value;
  if (!isId(id)) return null;
  if (typeof kind !== "string" || !(kind in KINDS)) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return null;
  if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) return null;
  if (!isPoint(position) || !isSize(size)) return null;
  if (path !== null && (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) return null;
  if (!isFiniteNumber(createdAt)) return null;
  const storedVersions = normalizeVersions(versions);
  const storedScenario = kind === "scenario" ? normalizeScenario(scenario) : null;
  if (kind === "scenario" && (path !== null || !storedScenario)) return null;
  if (path === null && storedVersions.length === 0 && !storedScenario) return null;
  const highest = storedVersions.reduce((max, version) => Math.max(max, version.number), 0);
  return {
    id,
    kind: kind as MaterialKind,
    name,
    mimeType,
    position: { x: position.x, y: position.y },
    size: clampSize(size),
    path,
    identity: normalizeIdentity(identity),
    origin: normalizeOrigin(origin),
    createdAt,
    versions: storedVersions,
    nextVersion: Math.max(highest + 1, isCount(nextVersion) ? nextVersion : 1),
    scenario: storedScenario
  };
}

function normalizeScenario(value: unknown): StoredScenario | null {
  if (!isRecord(value) || (value.state !== "recording" && value.state !== "done") || !isFiniteNumber(value.startedAt)) return null;
  if (!Array.isArray(value.steps)) return null;
  const steps: StoredScenarioStep[] = [];
  for (const candidate of value.steps.slice(0, SCENARIO_STEP_LIMIT)) {
    const step = normalizeStep(candidate, steps.length);
    if (step) steps.push(step);
  }
  const interrupted = value.state === "recording";
  return {
    state: "done",
    startedAt: value.startedAt,
    endedAt: interrupted ? steps.at(-1)?.at ?? value.startedAt : isFiniteNumber(value.endedAt) ? value.endedAt : null,
    viewport: isSize(value.viewport) ? { width: value.viewport.width, height: value.viewport.height } : null,
    stopReason: interrupted ? "app-closed" : typeof value.stopReason === "string" && STOP_REASONS.has(value.stopReason as ScenarioStopReason)
      ? value.stopReason as ScenarioStopReason
      : null,
    steps
  };
}

function normalizeStep(value: unknown, index: number): StoredScenarioStep | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !STEP_KINDS.has(value.kind as ScenarioStepKind) || !isFiniteNumber(value.at)) return null;
  return {
    index,
    kind: value.kind as ScenarioStepKind,
    at: value.at,
    url: typeof value.url === "string" && value.url.length <= MAX_URL ? value.url : null,
    title: typeof value.title === "string" ? value.title.slice(0, MAX_TITLE) : null,
    point: isPoint(value.point) ? { x: value.point.x, y: value.point.y } : null,
    element: normalizeStepElement(value.element),
    text: typeof value.text === "string" ? value.text.slice(0, SCENARIO_TEXT_LIMIT) : null,
    image: normalizeStepImage(value.image)
  };
}

function normalizeStepElement(value: unknown): { role: string; name: string } | null {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.name !== "string") return null;
  return { role: value.role.slice(0, MAX_ELEMENT_ROLE), name: value.name.slice(0, MAX_ELEMENT_NAME) };
}

function normalizeStepImage(value: unknown): StoredStepImage | null {
  if (!isRecord(value) || typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) return null;
  if (typeof value.mimeType !== "string" || !IMAGE_MIME.has(value.mimeType) || !isSize(value.natural)) return null;
  if (!Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 0) return null;
  return { sha256: value.sha256, byteSize: value.byteSize as number, mimeType: value.mimeType, natural: { width: value.natural.width, height: value.natural.height } };
}

export function normalizeElements(value: unknown): PageElement[] {
  if (!Array.isArray(value)) return [];
  const elements: PageElement[] = [];
  for (const candidate of value.slice(0, PAGE_ELEMENT_LIMIT)) {
    if (!isRecord(candidate) || typeof candidate.role !== "string" || typeof candidate.name !== "string" || !isRecord(candidate.bounds)) continue;
    const { x, y, width, height } = candidate.bounds;
    if (![x, y, width, height].every(isFiniteNumber) || (width as number) < 0 || (height as number) < 0) continue;
    elements.push({
      role: candidate.role.slice(0, MAX_ELEMENT_ROLE),
      name: candidate.name.slice(0, MAX_ELEMENT_NAME),
      bounds: { x: x as number, y: y as number, width: width as number, height: height as number }
    });
  }
  return elements;
}

function normalizeVersions(value: unknown): StoredVersion[] {
  if (!Array.isArray(value)) return [];
  const versions: StoredVersion[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const candidate of value) {
    if (versions.length >= MATERIAL_VERSION_LIMIT) break;
    if (!isRecord(candidate)) continue;
    const { id, number, sha256, byteSize, mimeType, createdAt, reason, signature, natural } = candidate;
    if (!isId(id) || ids.has(id)) continue;
    if (!isCount(number) || numbers.has(number)) continue;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) continue;
    if (!Number.isSafeInteger(byteSize) || (byteSize as number) < 0) continue;
    if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) continue;
    if (!isFiniteNumber(createdAt)) continue;
    if (typeof reason !== "string" || !VERSION_REASONS.has(reason as MaterialVersionReason)) continue;
    ids.add(id);
    numbers.add(number);
    versions.push({
      id,
      number,
      sha256,
      byteSize: byteSize as number,
      mimeType,
      createdAt,
      reason: reason as MaterialVersionReason,
      signature: typeof signature === "string" && signature.length <= 200 ? signature : null,
      natural: isSize(natural) ? { width: natural.width, height: natural.height } : null
    });
  }
  return versions.sort((left, right) => left.number - right.number);
}

function normalizeIdentity(value: unknown): StoredFileIdentity | null {
  if (!isRecord(value) || !isFileNumber(value.dev) || !isFileNumber(value.ino)) return null;
  return { dev: value.dev, ino: value.ino };
}

function isFileNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

export function normalizeOrigin(value: unknown): MaterialOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === "clipboard") return { kind: "clipboard" };
  if (value.kind === "pdf-page" && isId(value.sourceId) && typeof value.sourceName === "string" && value.sourceName.length <= MAX_NAME
    && isPageNumber(value.page)) {
    return { kind: "pdf-page", sourceId: value.sourceId, sourceName: value.sourceName, page: value.page };
  }
  if (value.kind === "frame" && isId(value.sourceId) && typeof value.sourceName === "string" && value.sourceName.length <= MAX_NAME
    && isMediaTime(value.time)) {
    return { kind: "frame", sourceId: value.sourceId, sourceName: value.sourceName, time: value.time };
  }
  if (value.kind === "result" && typeof value.folderName === "string" && value.folderName.length <= MAX_NAME) {
    const handoff = value.handoff;
    if (handoff === null) return { kind: "result", folderName: value.folderName, handoff: null };
    if (isRecord(handoff) && isId(handoff.id) && isCount(handoff.number)) {
      return { kind: "result", folderName: value.folderName, handoff: { id: handoff.id, number: handoff.number } };
    }
  }
  if (value.kind === "browser" && typeof value.url === "string" && value.url.length <= MAX_URL
    && typeof value.title === "string" && isSize(value.viewport)) {
    return {
      kind: "browser",
      url: value.url,
      title: value.title.slice(0, MAX_TITLE),
      viewport: { width: value.viewport.width, height: value.viewport.height },
      elements: normalizeElements(value.elements)
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMediaTime(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_TIME;
}

export function isPageNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PAGE;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isSize(value: unknown): value is Size {
  return isRecord(value) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
    && value.width > 0 && value.height > 0;
}
