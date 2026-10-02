import type { MaterialFailure, MaterialRemark, MaterialText, RemarkAnchor, RemarkStatus } from "../../../../shared/contracts";

export const TEXT_ROW_HEIGHT = 18;
export const TEXT_OVERSCAN = 24;
export const TEXT_MARKER_LANES = 3;
export const DRAFT_SAVE_DELAY_MS = 500;

export interface LineMarker {
  remarkId: string;
  number: number;
  start: number;
  end: number;
  status: RemarkStatus;
  stale: boolean;
  lane: number;
}

export function lineAnchor(from: number, to: number, lineCount: number): Extract<RemarkAnchor, { kind: "lines" }> {
  const clamp = (line: number): number => Math.min(Math.max(1, Math.round(line)), Math.max(1, lineCount));
  return { kind: "lines", start: clamp(Math.min(from, to)), end: clamp(Math.max(from, to)) };
}

export function lineAt(offsetY: number, scrollTop: number, lineCount: number, rowHeight = TEXT_ROW_HEIGHT): number {
  return Math.min(Math.max(1, Math.floor((offsetY + scrollTop) / rowHeight) + 1), Math.max(1, lineCount));
}

export function visibleRows(scrollTop: number, viewportHeight: number, lineCount: number, rowHeight = TEXT_ROW_HEIGHT): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - TEXT_OVERSCAN);
  const last = Math.min(lineCount - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + TEXT_OVERSCAN);
  return { first, last };
}

export function lineMarkers(remarks: readonly MaterialRemark[], lineCount: number, staleVersionIds: ReadonlySet<string>): LineMarker[] {
  const laneEnds: number[] = [];
  return remarks
    .filter((remark): remark is MaterialRemark & { target: { anchor: Extract<RemarkAnchor, { kind: "lines" }> } } => remark.target.anchor.kind === "lines")
    .map((remark) => ({
      remark,
      start: Math.min(remark.target.anchor.start, Math.max(1, lineCount)),
      end: Math.min(remark.target.anchor.end, Math.max(1, lineCount))
    }))
    .sort((left, right) => left.start - right.start || left.remark.number - right.remark.number)
    .map(({ remark, start, end }) => {
      let lane = laneEnds.findIndex((laneEnd) => laneEnd < start);
      if (lane === -1) lane = laneEnds.length < TEXT_MARKER_LANES ? laneEnds.length : TEXT_MARKER_LANES - 1;
      laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, end);
      return {
        remarkId: remark.id,
        number: remark.number,
        start,
        end,
        status: remark.status,
        stale: staleVersionIds.has(remark.target.versionId),
        lane
      };
    });
}

export type TextEditState = "clean" | "draft" | "conflict";

export function textEditState(baseHash: string | null, text: string | null, live: MaterialText | null): TextEditState {
  if (baseHash === null || text === null || live === null) return "clean";
  if (live.hash !== baseHash) return "conflict";
  return text === live.text ? "clean" : "draft";
}

export interface TextEditBase {
  baseHash: string;
  baseText: string | null;
  text: string;
}

export function followLive(edit: TextEditBase, live: MaterialText): TextEditBase | null {
  if (live.hash === edit.baseHash) return null;
  if (edit.text !== edit.baseText && edit.text !== live.text) return null;
  return { baseHash: live.hash, baseText: live.text, text: live.text };
}

export type TextFailureKey = "materialTextTooLarge" | "materialTextNotText" | "materialTextReadOnly" | "materialTextWriteFailed" | "materialUnreadable";

export function textFailureKey(reason: MaterialFailure): TextFailureKey {
  switch (reason) {
    case "too-large": return "materialTextTooLarge";
    case "not-text": return "materialTextNotText";
    case "read-only": return "materialTextReadOnly";
    case "write-failed": return "materialTextWriteFailed";
    default: return "materialUnreadable";
  }
}
