import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserSnapshot, MaterialFailure, PageElement, Point, ScenarioStepInput } from "../../../../shared/contracts";
import { SCENARIO_TIME_LIMIT_MS } from "../../../../shared/materials";
import {
  elementAt,
  pageElements,
  pagePoint,
  pageShot,
  pageViewport,
  sanitizePageUrl,
  snapshotPage,
  STEP_SETTLE_MS,
  viewportFrame
} from "./browserPage";
import { ScenarioStepQueue, type ScenarioStepPort } from "./ScenarioStepQueue";

export type RecorderProblem = "browser-unavailable" | MaterialFailure;
export type RecorderNotice = RecorderProblem | "captured" | "recording-started";

export interface ScenarioRecorder {
  recordingId: string | null;
  start(point: Point): Promise<boolean>;
  stop(materialId?: string): Promise<void>;
  expect(text: string): Promise<boolean>;
  capture(point: Point): Promise<boolean>;
}

interface Recording {
  steps: ScenarioStepQueue;
  tabId: string;
  url: string;
  away: boolean;
  pressed: Promise<Pressed> | null;
  seen: { url: string; elements: PageElement[] } | null;
}

interface Pressed {
  elements: PageElement[];
  page: { url: string; title: string } | null;
}

const EMPTY_STEP: Omit<ScenarioStepInput, "kind"> = { url: null, title: null, point: null, element: null, text: null, shot: null };

export function useScenarioRecorder(zoom: number, onProblem: (problem: RecorderProblem) => void): ScenarioRecorder {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  const queues = useRef(new Map<string, ScenarioStepQueue>());
  const starting = useRef(false);
  const zoomRef = useRef(zoom);
  const problemRef = useRef(onProblem);
  zoomRef.current = zoom;
  problemRef.current = onProblem;

  const port = useMemo<ScenarioStepPort>(() => ({
    addStep: (materialId, step) => window.canvasTTY.materials.addScenarioStep(materialId, step),
    stop: (materialId, reason) => window.canvasTTY.materials.stopScenario(materialId, reason)
      .finally(() => queues.current.delete(materialId)),
    finishing: (materialId) => {
      if (recording.current?.steps.materialId !== materialId) return;
      recording.current = null;
      setRecordingId(null);
    },
    problem: (reason) => problemRef.current(reason)
  }), []);

  const stop = useCallback((materialId?: string): Promise<void> => {
    const steps = materialId === undefined ? recording.current?.steps : queues.current.get(materialId);
    if (steps) return steps.finish("stopped");
    return materialId === undefined ? Promise.resolve() : new ScenarioStepQueue(materialId, port).finish("stopped");
  }, [port]);

  const start = useCallback(async (point: Point): Promise<boolean> => {
    if (recording.current || starting.current) return false;
    starting.current = true;
    try {
      const state = await window.canvasTTY.browser.getState();
      const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
      const frame = viewportFrame(zoomRef.current);
      if (!tab || !state.visible || !frame) {
        problemRef.current("browser-unavailable");
        return false;
      }
      const created = await window.canvasTTY.materials.startScenario({ url: sanitizePageUrl(tab.url), title: tab.title, viewport: pageViewport(frame), point });
      if (!created.ok) {
        problemRef.current(created.reason);
        return false;
      }
      const started: Recording = { steps: new ScenarioStepQueue(created.materialId, port), tabId: tab.id, url: tab.url, away: false, pressed: null, seen: null };
      queues.current.set(created.materialId, started.steps);
      recording.current = started;
      setRecordingId(created.materialId);
      await started.steps.enqueue(async () => {
        const shot = await pageShot(tab.id);
        await remember(started);
        return { ...EMPTY_STEP, kind: "start", url: sanitizePageUrl(tab.url), title: tab.title, shot };
      });
      return true;
    } finally {
      starting.current = false;
    }
  }, [port]);

  const expect = useCallback(async (text: string): Promise<boolean> => {
    const current = recording.current;
    if (!current || !text.trim()) return false;
    return current.steps.enqueue(async () => {
      const page = await tabPage(current.tabId);
      return { ...EMPTY_STEP, kind: "expectation", text, url: page ? sanitizePageUrl(page.url) : null, title: page?.title ?? null, shot: await pageShot(current.tabId) };
    });
  }, []);

  const capture = useCallback(async (point: Point): Promise<boolean> => {
    const page = await snapshotPage(zoomRef.current);
    if (!page?.shot) {
      problemRef.current("browser-unavailable");
      return false;
    }
    const created = await window.canvasTTY.materials.captureBrowser({
      url: sanitizePageUrl(page.url),
      title: page.title,
      viewport: page.viewport,
      elements: page.elements,
      shot: page.shot,
      point
    });
    if (!created.ok) problemRef.current(created.reason);
    return created.ok;
  }, []);

  useEffect(() => {
    const current = recording.current;
    if (!recordingId || current?.steps.materialId !== recordingId) return;
    const limit = window.setTimeout(() => void current.steps.finish("limit"), SCENARIO_TIME_LIMIT_MS);
    const offPointer = window.canvasTTY.browser.onCanvasPointer((event) => {
      if (current.steps.finishing || current.away || event.tabId !== current.tabId) return;
      if (event.type === "down") {
        current.pressed = press(current.tabId);
        return;
      }
      if (event.type !== "up") return;
      const frame = viewportFrame(zoomRef.current);
      if (!frame) return;
      const point = pagePoint(event.clientX, event.clientY, frame);
      const pressed = current.pressed ?? press(current.tabId);
      const releasedAt = performance.now();
      current.pressed = null;
      void current.steps.enqueue(async () => {
        const { elements, page } = await pressed;
        const known = current.seen && current.seen.url === page?.url ? current.seen.elements : [];
        const element = elementAt(elements, point) ?? elementAt(known, point);
        await settle(releasedAt);
        const shot = await pageShot(current.tabId);
        await remember(current);
        return {
          ...EMPTY_STEP,
          kind: "click",
          url: page ? sanitizePageUrl(page.url) : null,
          title: page?.title ?? null,
          point,
          element: element ? { role: element.role, name: element.name } : null,
          shot
        };
      });
    });
    const follow = (snapshot: BrowserSnapshot): void => {
      if (current.steps.finishing) return;
      const tab = snapshot.tabs.find((candidate) => candidate.id === current.tabId);
      if (!tab) {
        void current.steps.finish("browser-closed");
        return;
      }
      const away = snapshot.activeTabId !== current.tabId;
      if (away !== current.away) {
        current.away = away;
        void current.steps.enqueue(async () => ({ ...EMPTY_STEP, kind: away ? "tab-left" : "tab-returned" }));
        return;
      }
      if (!away && !tab.loading && tab.url !== current.url) {
        current.url = tab.url;
        void current.steps.enqueue(async () => {
          const shot = await pageShot(current.tabId);
          await remember(current);
          return { ...EMPTY_STEP, kind: "navigate", url: sanitizePageUrl(tab.url), title: tab.title, shot };
        });
      }
    };
    const offState = window.canvasTTY.browser.onState(({ snapshot }) => follow(snapshot));
    return () => {
      window.clearTimeout(limit);
      offPointer();
      offState();
    };
  }, [recordingId]);

  return useMemo(() => ({ recordingId, start, stop, expect, capture }), [capture, expect, recordingId, start, stop]);
}

function settle(since: number): Promise<void> {
  const wait = since + STEP_SETTLE_MS - performance.now();
  return wait > 0 ? new Promise((resolve) => window.setTimeout(resolve, wait)) : Promise.resolve();
}

async function tabPage(tabId: string): Promise<{ url: string; title: string } | null> {
  const state = await window.canvasTTY.browser.getState();
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  return tab ? { url: tab.url, title: tab.title } : null;
}

async function remember(current: Recording): Promise<void> {
  const [page, elements] = await Promise.all([tabPage(current.tabId), pageElements(current.tabId).catch(() => [])]);
  if (page) current.seen = { url: page.url, elements };
}

async function press(tabId: string): Promise<Pressed> {
  const [page, elements] = await Promise.all([tabPage(tabId), pageElements(tabId).catch(() => [])]);
  return { page, elements };
}
