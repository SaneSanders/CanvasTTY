import type {
  BrowserCaptureInput,
  PageElement,
  Point,
  RemarkAnchor,
  ScenarioStartInput,
  ScenarioStepInput,
  ScenarioStepKind,
  Size
} from "../../../shared/contracts";
import { isAreaAnchor, SCENARIO_TEXT_LIMIT } from "../../../shared/materials.ts";
import { imageDimensions } from "./imageDimensions.ts";
import { isFiniteNumber, MAX_ELEMENT_NAME, MAX_ELEMENT_ROLE, normalizeElements, STEP_KINDS } from "./materialState.ts";

export const PAGE_SHOT_MAX_BYTES = 600 * 1024;
export const AREA_ELEMENT_LIMIT = 8;

const MAX_URL = 2_048;
const MAX_TITLE = 300;
const MAX_VIEWPORT = 20_000;

export interface ParsedShot {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  natural: Size;
}

export interface ParsedStep extends Omit<ScenarioStepInput, "shot"> {
  shot: ParsedShot | null;
}

export function pageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`;
}

export function pageTitle(value: string): string {
  const title = value.slice(0, MAX_TITLE);
  return /\s/.test(title.trim()) ? title : title.replace(/[?#][\s\S]*$/, "");
}

export function parseShot(value: unknown, maxBytes = PAGE_SHOT_MAX_BYTES): ParsedShot | null {
  if (!isRecord(value) || typeof value.base64 !== "string" || (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg")) return null;
  if (value.base64.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) return null;
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if ((value.mimeType === "image/png" && !png) || (value.mimeType === "image/jpeg" && !jpeg)) return null;
  const natural = imageDimensions(bytes);
  return natural ? { bytes, mimeType: value.mimeType, natural } : null;
}

export function parseCaptureInput(value: unknown): (Omit<BrowserCaptureInput, "shot"> & { shot: ParsedShot }) | null {
  if (!isRecord(value)) return null;
  const url = pageUrl(value.url);
  const viewport = viewportSize(value.viewport);
  const shot = parseShot(value.shot);
  if (!url || !viewport || !shot || typeof value.title !== "string") return null;
  return { url, title: pageTitle(value.title), viewport, elements: normalizeElements(value.elements), shot, point: finitePoint(value.point) };
}

export function parseStartInput(value: unknown): ScenarioStartInput | null {
  if (!isRecord(value)) return null;
  const url = pageUrl(value.url);
  const viewport = viewportSize(value.viewport);
  if (!url || !viewport || typeof value.title !== "string") return null;
  return { url, title: pageTitle(value.title), viewport, point: finitePoint(value.point) };
}

export function parseStepInput(value: unknown): ParsedStep | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !STEP_KINDS.has(value.kind as ScenarioStepKind)) return null;
  const kind = value.kind as ScenarioStepKind;
  const text = typeof value.text === "string" ? value.text.trim().slice(0, SCENARIO_TEXT_LIMIT) : "";
  if (kind === "expectation" && text.length === 0) return null;
  const element = isRecord(value.element) && typeof value.element.role === "string" && typeof value.element.name === "string"
    ? { role: value.element.role.slice(0, MAX_ELEMENT_ROLE), name: value.element.name.slice(0, MAX_ELEMENT_NAME) }
    : null;
  const shot = value.shot === null || value.shot === undefined ? null : parseShot(value.shot);
  if (value.shot && !shot) return null;
  return {
    kind,
    url: value.url === null || value.url === undefined ? null : pageUrl(value.url),
    title: typeof value.title === "string" ? pageTitle(value.title) : null,
    point: isRecord(value.point) && isFiniteNumber(value.point.x) && isFiniteNumber(value.point.y) ? { x: value.point.x as number, y: value.point.y as number } : null,
    element,
    text: kind === "expectation" ? text : null,
    shot
  };
}

export function elementsInArea(elements: readonly PageElement[], anchor: RemarkAnchor, viewport: Size): PageElement[] {
  if (!isAreaAnchor(anchor) || !(viewport.width > 0) || !(viewport.height > 0)) return [];
  if (anchor.kind === "point") {
    const x = anchor.x * viewport.width;
    const y = anchor.y * viewport.height;
    return elements
      .filter(({ bounds }) => x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height)
      .sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height)
      .slice(0, AREA_ELEMENT_LIMIT);
  }
  const area = { x: anchor.x * viewport.width, y: anchor.y * viewport.height, width: anchor.width * viewport.width, height: anchor.height * viewport.height };
  return elements
    .map((element) => {
      const shared = overlap(area, element.bounds);
      return { element, shared, covered: shared / Math.max(1, element.bounds.width * element.bounds.height) };
    })
    .filter((entry) => entry.shared > 0)
    .sort((left, right) => right.covered - left.covered || right.shared - left.shared)
    .slice(0, AREA_ELEMENT_LIMIT)
    .map((entry) => entry.element);
}

function overlap(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function viewportSize(value: unknown): Size | null {
  if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) return null;
  const width = value.width as number;
  const height = value.height as number;
  return width > 0 && height > 0 && width <= MAX_VIEWPORT && height <= MAX_VIEWPORT ? { width, height } : null;
}

export function finitePoint(value: unknown): Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) ? { x: value.x as number, y: value.y as number } : { x: 0, y: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
