import type { BrowserObservation, PageElement, PageShot, Point, Size } from "../../../../shared/contracts";
import { PAGE_ELEMENT_LIMIT } from "../../../../shared/materials.ts";

export const STEP_SETTLE_MS = 700;
const BROWSER_VIEWPORT_SELECTOR = ".browser-card__viewport";
const SHOT_ATTEMPTS = 6;
const SHOT_RETRY_MS = 150;
const URL_UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_TOKEN_SEGMENT = /^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9]{20,}$/;

export function sanitizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").map((segment) => (URL_UUID_SEGMENT.test(segment) || URL_TOKEN_SEGMENT.test(segment)) ? "…" : segment).join("/");
    return `${parsed.protocol}//${parsed.host}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

interface ViewportFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
}

interface PageSnapshot {
  tabId: string;
  url: string;
  title: string;
  viewport: Size;
  shot: PageShot | null;
  elements: PageElement[];
}

export function pagePoint(clientX: number, clientY: number, frame: ViewportFrame): Point {
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  return { x: (clientX - frame.left) / zoom, y: (clientY - frame.top) / zoom };
}

export function pageViewport(frame: ViewportFrame): Size {
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  return { width: frame.width / zoom, height: frame.height / zoom };
}

export function elementAt(elements: readonly PageElement[], point: Point): PageElement | null {
  return elements
    .filter(({ bounds }) => point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height)
    .sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height)[0] ?? null;
}

export function observedElements(observation: BrowserObservation | undefined): PageElement[] {
  return (observation?.elements ?? []).flatMap((element) => element.bounds
    ? [{ role: element.role, name: element.name, bounds: { ...element.bounds } }]
    : []);
}

export function viewportFrame(zoom: number): ViewportFrame | null {
  const element = document.querySelector(BROWSER_VIEWPORT_SELECTOR);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, zoom } : null;
}

export async function pageShot(tabId: string, attempts = SHOT_ATTEMPTS): Promise<PageShot | null> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await window.canvasTTY.browser.execute({ type: "browser_screenshot", requestId: crypto.randomUUID(), tabId });
    const data = result.data as { base64?: unknown; mimeType?: unknown } | undefined;
    if (result.ok && typeof data?.base64 === "string" && (data.mimeType === "image/png" || data.mimeType === "image/jpeg")) {
      return { base64: data.base64, mimeType: data.mimeType };
    }
    if (result.error?.code !== "VIEWPORT_UNAVAILABLE" || attempt >= attempts) return null;
    await new Promise((resolve) => window.setTimeout(resolve, SHOT_RETRY_MS));
  }
}

export async function pageElements(tabId: string): Promise<PageElement[]> {
  const result = await window.canvasTTY.browser.execute({ type: "browser_observe", requestId: crypto.randomUUID(), tabId, limit: PAGE_ELEMENT_LIMIT });
  return result.ok ? observedElements(result.data as BrowserObservation) : [];
}

export async function snapshotPage(zoom: number): Promise<PageSnapshot | null> {
  const state = await window.canvasTTY.browser.getState();
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
  const frame = viewportFrame(zoom);
  if (!tab || !state.visible || !frame) return null;
  const shot = await pageShot(tab.id);
  if (!shot) return null;
  return { tabId: tab.id, url: tab.url, title: tab.title, viewport: pageViewport(frame), shot, elements: await pageElements(tab.id) };
}
