import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { CanvasMaterial, LocaleId, PageShot, Size } from "../../../../shared/contracts";
import { MATERIAL_PLACEMENT_GAP, PDF_BYTES_LIMIT, PDF_PAGE_SHOT_MAX_BYTES } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { formatBytes } from "./materialCardModel";
import { MaterialNotice } from "./MaterialCard";
import type { MaterialRemarkActions, MaterialRemarking } from "./materialRemarksModel";
import { PDF_PAGE_GAP, PDF_PAGE_LIMIT, PDF_PIXEL_LIMIT, pdfLayout, pdfScale, visiblePages } from "./pdfModel";
import { RemarkChip } from "./RemarkChips";

interface LoadedPdf {
  document: PDFDocumentProxy;
  pages: Size[];
  count: number;
}

const CAPTURE_SCALE = 2;
const SEEN_MARGIN = "400px";

export function PdfMaterialBody({
  material,
  locale,
  remarking,
  remarkActions
}: {
  material: CanvasMaterial;
  locale: LocaleId;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [failure, setFailure] = useState<"too-large" | "failed" | null>(null);
  const [view, setView] = useState({ top: 0, height: 400, width: 400 });
  const [capturing, setCapturing] = useState<number | null>(null);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [seen, setSeen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);
  const drawing = remarking.mode === "draw" || remarking.mode === "pick";
  const tooLarge = material.byteSize !== null && material.byteSize > PDF_BYTES_LIMIT;

  useEffect(() => {
    const element = root.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    }, { rootMargin: SEEN_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, tooLarge]);

  useEffect(() => {
    if (tooLarge || !seen) return;
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    setFailure(null);
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      const read = await window.canvasTTY.materials.readPdf(material.id);
      if (cancelled) return;
      if (!read.ok) throw new Error(read.reason);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      loading = pdfjs.getDocument({ data: read.bytes, enableXfa: false, useWasm: false, maxImageSize: PDF_PIXEL_LIMIT });
      const opened = await loading.promise;
      const pages: Size[] = [];
      for (let number = 1; number <= Math.min(opened.numPages, PDF_PAGE_LIMIT); number += 1) {
        if (cancelled) return;
        const viewport = (await opened.getPage(number)).getViewport({ scale: 1 });
        pages.push({ width: viewport.width, height: viewport.height });
      }
      if (!cancelled) setLoaded({ document: opened, pages, count: opened.numPages });
    })().catch(() => {
      if (!cancelled) setFailure("failed");
    });
    return () => {
      cancelled = true;
      setLoaded(null);
      void loading?.destroy();
    };
  }, [material.id, material.liveRevision, seen, tooLarge]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = (): void => setView({ top: element.scrollTop, height: element.clientHeight, width: element.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  const width = Math.max(120, Math.round(view.width - 24));
  const deferredWidth = useDeferredValue(width);
  const layout = useMemo(() => pdfLayout(loaded?.pages ?? [], deferredWidth), [loaded, deferredWidth]);
  const pageRemarks = useMemo(() => {
    const byPage = new Map<number, MaterialRemarking["remarks"]>();
    for (const remark of remarking.remarks) {
      if (remark.target.anchor.kind !== "page") continue;
      byPage.set(remark.target.anchor.page, [...(byPage.get(remark.target.anchor.page) ?? []), remark]);
    }
    return byPage;
  }, [remarking.remarks]);
  const selectedAnchor = remarking.remarks.find((remark) => remark.id === remarking.selectedRemarkId)?.target.anchor;
  const highlightedPage = remarking.draftAnchor?.kind === "page"
    ? remarking.draftAnchor.page
    : selectedAnchor?.kind === "page" ? selectedAnchor.page : null;

  useEffect(() => {
    const selectedId = remarking.selectedRemarkId;
    if (selectedId === scrolledTo.current) return;
    const anchor = remarking.remarks.find((candidate) => candidate.id === selectedId)?.target.anchor;
    const element = scroller.current;
    if (selectedId !== null && (!anchor || (anchor.kind === "page" && (!element || layout.tops.length === 0)))) return;
    scrolledTo.current = selectedId;
    const top = anchor?.kind === "page" ? layout.tops[anchor.page - 1] : undefined;
    if (element && top !== undefined) element.scrollTop = Math.max(0, top - PDF_PAGE_GAP);
  }, [layout, remarking.remarks, remarking.selectedRemarkId]);

  const capturePage = async (number: number): Promise<void> => {
    if (!loaded || capturing !== null) return;
    setCapturing(number);
    setCaptureFailed(false);
    try {
      const shot = await pageShot(await loaded.document.getPage(number));
      const result = shot
        ? await window.canvasTTY.materials.capturePdfPage({
            materialId: material.id,
            page: number,
            shot,
            point: { x: material.position.x + material.size.width + MATERIAL_PLACEMENT_GAP, y: material.position.y }
          })
        : null;
      setCaptureFailed(!result?.ok);
    } catch {
      setCaptureFailed(true);
    } finally {
      setCapturing(null);
    }
  };

  if (tooLarge || failure) {
    return (
      <MaterialNotice
        icon="error"
        title={t(locale, tooLarge ? "pdfTooLarge" : "pdfFailed")}
        hint={material.byteSize !== null ? formatBytes(material.byteSize, locale) : ""}
      />
    );
  }

  return (
    <div ref={root} className={`material-pdf ${drawing ? "material-pdf--drawing" : ""}`}>
      <div className="material-pdf__status">
        <span>{loaded ? `${t(locale, "pdfPages")} ${loaded.count}${loaded.count > PDF_PAGE_LIMIT ? ` · ${t(locale, "pdfShownFirst")} ${PDF_PAGE_LIMIT}` : ""}` : t(locale, "materialTextLoading")}</span>
        {captureFailed && <span className="material-pdf__error" role="alert">{t(locale, "pdfCaptureFailed")}</span>}
      </div>
      <div
        ref={scroller}
        className="material-pdf__scroller"
        data-canvas-card-control="true"
        onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight, width: event.currentTarget.clientWidth })}
      >
        <div className="material-pdf__pages" style={{ height: layout.total }}>
          {loaded && visiblePages(layout, view.top, view.height).map((index) => {
            const number = index + 1;
            const remarks = pageRemarks.get(number) ?? [];
            return (
              <div
                key={number}
                className={`material-pdf__page ${highlightedPage === number ? "material-pdf__page--marked" : ""}`}
                style={{ top: layout.tops[index], height: layout.heights[index], width: deferredWidth }}
                onClick={() => {
                  if (drawing) remarkActions.draw(material.id, { kind: "page", page: number });
                }}
              >
                <PdfPageCanvas document={loaded.document} number={number} width={deferredWidth} />
                <span className="material-pdf__number">{number}</span>
                <span className="material-pdf__tools">
                  {remarks.map((remark) => <RemarkChip key={remark.id} locale={locale} remark={remark} onSelect={remarkActions.select} />)}
                  {!drawing && (
                    <button type="button" className="material-pdf__capture" disabled={capturing !== null}
                      title={t(locale, "pdfCapturePage")} aria-label={`${t(locale, "pdfCapturePage")} ${number}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void capturePage(number);
                      }}>
                      <UiIcon name="camera" size="1em" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PdfPageCanvas({ document: pdf, number, width }: { document: PDFDocumentProxy; number: number; width: number }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    void pdf.getPage(number).then((page) => {
      const element = canvas.current;
      if (cancelled || !element) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pdfScale(base, (width / base.width) * Math.min(2, window.devicePixelRatio || 1)) });
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      task = page.render({ canvas: element, viewport });
      task.promise.catch(() => undefined);
    }, () => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [number, pdf, width]);
  return <canvas ref={canvas} className="material-pdf__canvas" />;
}

async function pageShot(page: PDFPageProxy): Promise<PageShot | null> {
  const viewport = page.getViewport({ scale: pdfScale(page.getViewport({ scale: 1 }), CAPTURE_SCALE) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  for (const mimeType of ["image/png", "image/jpeg"] as const) {
    const base64 = canvas.toDataURL(mimeType, 0.9).split(",")[1] ?? "";
    if ((base64.length * 3) / 4 <= PDF_PAGE_SHOT_MAX_BYTES) return { base64, mimeType };
  }
  return null;
}
