import type { MaterialRemark, RemarkStatus } from "../../../../shared/contracts";
import { formatClock } from "../../../../shared/materials.ts";

export const MIN_SPAN_PERCENT = 0.8;

export interface TimeMarker {
  remarkId: string;
  number: number;
  status: RemarkStatus;
  stale: boolean;
  start: number;
  left: number;
  width: number | null;
  label: string;
}

export function timeMarkers(remarks: readonly MaterialRemark[], duration: number | null, staleVersionIds: ReadonlySet<string>): TimeMarker[] {
  if (duration === null || !(duration > 0)) return [];
  return remarks.flatMap((remark) => {
    const anchor = remark.target.anchor;
    if (anchor.kind !== "time") return [];
    const start = Math.min(anchor.start, duration);
    const end = anchor.end === null ? null : Math.min(anchor.end, duration);
    return [{
      remarkId: remark.id,
      number: remark.number,
      status: remark.status,
      stale: staleVersionIds.has(remark.target.versionId),
      start,
      left: (start / duration) * 100,
      width: end === null ? null : Math.max(MIN_SPAN_PERCENT, ((end - start) / duration) * 100),
      label: end === null ? formatClock(start) : `${formatClock(start)}–${formatClock(end)}`
    }];
  });
}
