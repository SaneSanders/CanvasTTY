import type {
  CanvasMaterial,
  LocaleId,
  MaterialFailure,
  MaterialKind,
  MaterialRejectionReason,
  MaterialsAddResult
} from "../../../../shared/contracts";
import { formatClock } from "../../../../shared/materials.ts";
import { t } from "../../lib/i18n.ts";

export type MaterialIconName = "image" | "file-text" | "film" | "music" | "file" | "scenario";

export type MaterialCommand = "pin" | "reveal" | "copy-path" | "relink" | "accept-move";

const KIND_ICONS: Record<MaterialKind, MaterialIconName> = {
  image: "image",
  text: "file-text",
  video: "film",
  audio: "music",
  pdf: "file-text",
  file: "file",
  scenario: "scenario"
};

export function materialIcon(kind: MaterialKind): MaterialIconName {
  return KIND_ICONS[kind];
}

export function materialSubtitle(material: CanvasMaterial, locale: LocaleId): string {
  const origin = material.origin;
  if (!origin) return materialFolder(material.location) ?? "";
  switch (origin.kind) {
    case "clipboard": return t(locale, "materialFromClipboard");
    case "browser": return origin.url;
    case "pdf-page": return `${t(locale, "pdfPageOf")} ${origin.page} · ${origin.sourceName}`;
    case "frame": return `${t(locale, "mediaFrameOf")} ${formatClock(origin.time)} · ${origin.sourceName}`;
    case "result": return `${origin.handoff ? `${t(locale, "materialResultOf")} #${origin.handoff.number}` : t(locale, "materialResultUnknown")} · ${origin.folderName}`;
    default: return materialFolder(material.location) ?? "";
  }
}

export function materialFolder(location: string | null): string | null {
  if (!location) return null;
  const separator = Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"));
  return separator > 0 ? location.slice(0, separator) : location;
}

export function formatBytes(bytes: number | null, locale: LocaleId): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  const units = locale === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", locale === "ru" ? "," : ".")} ${units[unit]}`;
}

export function latestVersionNumber(material: CanvasMaterial): number | null {
  return material.versions.at(-1)?.number ?? null;
}

export type MaterialFailureKey =
  | "materialFailureUnavailable"
  | "materialFailureTooLarge"
  | "materialFailureQuota"
  | "materialFailureUnreadable"
  | "materialFailureNotAFile"
  | "materialFailureKindMismatch"
  | "materialFailureAlreadyOnCanvas"
  | "materialFailureVersionLimit"
  | "materialFailureMaterialLimit"
  | "materialFailureRemarkLimit";

export function materialFailureKey(reason: MaterialFailure): MaterialFailureKey | null {
  switch (reason) {
    case "unavailable": return "materialFailureUnavailable";
    case "too-large": return "materialFailureTooLarge";
    case "quota": return "materialFailureQuota";
    case "unreadable": return "materialFailureUnreadable";
    case "not-a-file": return "materialFailureNotAFile";
    case "kind-mismatch": return "materialFailureKindMismatch";
    case "already-on-canvas": return "materialFailureAlreadyOnCanvas";
    case "version-limit": return "materialFailureVersionLimit";
    case "material-limit": return "materialFailureMaterialLimit";
    case "remark-limit": return "materialFailureRemarkLimit";
    default: return null;
  }
}

export type MaterialRejectionKey = "materialsNotAFile" | "materialsUnreadable" | "materialsLimit" | "materialsQuota" | "materialsTooLarge"
  | "materialsEmptyClipboard";

export function materialRejectionKey(reason: MaterialRejectionReason): MaterialRejectionKey {
  switch (reason) {
    case "not-a-file": return "materialsNotAFile";
    case "limit": return "materialsLimit";
    case "quota": return "materialsQuota";
    case "too-large": return "materialsTooLarge";
    case "empty-clipboard": return "materialsEmptyClipboard";
    default: return "materialsUnreadable";
  }
}

export function remarkDrawable(material: CanvasMaterial): boolean {
  if (material.state !== "ready") return false;
  if (material.kind === "scenario") return material.scenario?.state === "done";
  return material.kind === "image" || material.kind === "text" || material.kind === "video" || material.kind === "audio" || material.kind === "pdf";
}

export function remarkPickable(material: CanvasMaterial): boolean {
  return material.kind !== "scenario" && remarkDrawable(material);
}

export function remarkAddable(material: CanvasMaterial): boolean {
  return material.scenario?.state !== "recording";
}

export function materialWidgetAttributes(material: Pick<CanvasMaterial, "id" | "kind">): Record<string, string | undefined> {
  const focusable = material.kind === "text" || material.kind === "pdf" || material.kind === "scenario";
  return {
    "data-canvas-widget-id": focusable ? `material:${material.id}` : undefined,
    "data-canvas-widget-focusable": focusable ? "true" : undefined
  };
}

export function materialRemovalLosesData(material: CanvasMaterial): boolean {
  return material.location === null || material.versions.length > 0 || material.draft != null;
}

export function addResultNeedsNotice(result: MaterialsAddResult): boolean {
  return result.rejected.length > 0 || (result.added.length === 0 && result.existing.length > 0);
}
