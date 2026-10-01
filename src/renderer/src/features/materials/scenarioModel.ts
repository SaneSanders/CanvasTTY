import type { LocaleId, ScenarioStep, ScenarioStepKind, ScenarioStopReason } from "../../../../shared/contracts";
import { t } from "../../lib/i18n.ts";

export type ScenarioStepIcon = "browser" | "scenario" | "arrow" | "flag";

export function scenarioStepIcon(kind: ScenarioStepKind): ScenarioStepIcon {
  switch (kind) {
    case "click": return "scenario";
    case "navigate": return "arrow";
    case "expectation": return "flag";
    default: return "browser";
  }
}

export function scenarioStepSummary(step: ScenarioStep, locale: LocaleId): string {
  const page = step.url ? shortUrl(step.url) : "";
  switch (step.kind) {
    case "start": return `${t(locale, "scenarioStepStart")} ${step.title || page}`;
    case "navigate": return `${t(locale, "scenarioStepNavigate")} ${step.title || page}`;
    case "expectation": return `${t(locale, "scenarioStepExpectation")}: ${step.text ?? ""}`;
    case "tab-left": return t(locale, "scenarioStepTabLeft");
    case "tab-returned": return t(locale, "scenarioStepTabReturned");
    default: return step.element
      ? `${t(locale, "scenarioStepClick")} ${step.element.role} ${quote(step.element.name, locale)}`
      : `${t(locale, "scenarioStepClick")} (${Math.round(step.point?.x ?? 0)}, ${Math.round(step.point?.y ?? 0)})`;
  }
}

export function quote(text: string, locale: LocaleId): string {
  return locale === "ru" ? `«${text}»` : `“${text}”`;
}

export function scenarioStopKey(reason: ScenarioStopReason | null): "scenarioStoppedLimit" | "scenarioStoppedBrowser" | "scenarioStoppedApp" | null {
  if (reason === "limit") return "scenarioStoppedLimit";
  if (reason === "browser-closed") return "scenarioStoppedBrowser";
  if (reason === "app-closed") return "scenarioStoppedApp";
  return null;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}
