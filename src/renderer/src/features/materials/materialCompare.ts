import type { CanvasMaterial, LocaleId, MaterialRemark } from "../../../../shared/contracts";
import { materialUrl } from "../../../../shared/materials.ts";
import { t } from "../../lib/i18n.ts";

export interface CompareCandidate {
  key: string;
  label: string;
  url: string;
  materialId: string;
  versionId: string | null;
  kind: "live" | "version" | "result" | "other";
}

export function compareCandidates(remark: MaterialRemark, materials: readonly CanvasMaterial[], locale: LocaleId): CompareCandidate[] {
  const target = materials.find((material) => material.id === remark.target.materialId);
  const kind = target?.kind ?? "image";
  const candidates: CompareCandidate[] = [];
  const handoffs = new Set(remark.handoffIds);
  const live = (material: CanvasMaterial, key: string, label: string, candidateKind: CompareCandidate["kind"]): CompareCandidate => ({
    key,
    label,
    url: materialUrl(material.id, null, material.liveRevision),
    materialId: material.id,
    versionId: null,
    kind: candidateKind
  });
  for (const material of materials) {
    if (material.kind !== kind || material.origin?.kind !== "result" || !material.origin.handoff || !handoffs.has(material.origin.handoff.id)) continue;
    candidates.push(live(material, `result:${material.id}`, `${t(locale, "compareResult")}: ${material.name}`, "result"));
  }
  if (target) {
    const pinned = target.versions.find((version) => version.id === remark.target.versionId);
    if (target.location !== null && target.state === "ready") {
      const changed = pinned ? !pinned.current : true;
      candidates.push(live(target, `live:${target.id}`, `${t(locale, "compareLive")}${changed ? ` · ${t(locale, "compareChanged")}` : ""}`, "live"));
    }
    for (const version of [...target.versions].reverse()) {
      if (version.id === remark.target.versionId || (pinned && version.number < pinned.number)) continue;
      candidates.push({
        key: `version:${version.id}`,
        label: `${t(locale, "compareVersion")} ${version.number}`,
        url: materialUrl(target.id, version.id),
        materialId: target.id,
        versionId: version.id,
        kind: "version"
      });
    }
  }
  for (const material of materials) {
    if (material.kind !== kind || material.id === remark.target.materialId || candidates.some((candidate) => candidate.key === `result:${material.id}`)) continue;
    candidates.push(live(material, `other:${material.id}`, `${t(locale, "compareOther")}: ${material.name}`, "other"));
  }
  return candidates;
}
