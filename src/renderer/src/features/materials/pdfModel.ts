import type { Size } from "../../../../shared/contracts";

export const PDF_PAGE_GAP = 12;
export const PDF_PAGE_LIMIT = 300;
export const PDF_OVERSCAN = 1;
export const PDF_PIXEL_LIMIT = 4096 * 4096;

export interface PdfLayout {
  tops: number[];
  heights: number[];
  total: number;
}

export function pdfLayout(pages: readonly Size[], width: number): PdfLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  let top = PDF_PAGE_GAP;
  for (const page of pages) {
    const height = page.width > 0 ? Math.round((width * page.height) / page.width) : width;
    tops.push(top);
    heights.push(height);
    top += height + PDF_PAGE_GAP;
  }
  return { tops, heights, total: top };
}

export function visiblePages(layout: PdfLayout, scrollTop: number, viewportHeight: number): number[] {
  const bottom = scrollTop + viewportHeight;
  const visible = layout.tops.flatMap((top, index) => top + layout.heights[index] >= scrollTop && top <= bottom ? [index] : []);
  if (visible.length === 0) return [];
  const first = Math.max(0, visible[0] - PDF_OVERSCAN);
  const last = Math.min(layout.tops.length - 1, visible.at(-1)! + PDF_OVERSCAN);
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

export function pdfScale(page: Size, scale: number, limit = PDF_PIXEL_LIMIT): number {
  const pixels = page.width * page.height * scale * scale;
  return pixels > limit ? scale * Math.sqrt(limit / pixels) : scale;
}
