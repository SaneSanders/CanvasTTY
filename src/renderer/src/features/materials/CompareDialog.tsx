import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasMaterial, LocaleId, MaterialRemark, RemarkAnchor, Size } from "../../../../shared/contracts";
import { materialUrl } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { compareCandidates, type CompareCandidate } from "./materialCompare";
import { anchorPercentages, containedRect, remarkStatusClass, remarkStatusKey } from "./materialRemarksModel";
import { TextDiffView } from "./TextDiffView";

interface CompareDialogProps {
  locale: LocaleId;
  remark: MaterialRemark | null;
  materials: readonly CanvasMaterial[];
  onClose(): void;
  onAccept(remark: MaterialRemark): void;
  onReopen(remark: MaterialRemark): void;
}

export function CompareDialog({ locale, remark, materials, onClose, onAccept, onReopen }: CompareDialogProps): React.JSX.Element | null {
  const candidates = useMemo(() => remark ? compareCandidates(remark, materials, locale) : [], [locale, materials, remark]);
  const [afterKey, setAfterKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"side" | "slider">("side");

  useEffect(() => {
    setAfterKey(candidates[0]?.key ?? null);
    setMode("side");
  }, [remark?.id]);

  useEffect(() => {
    if (!candidates.some((candidate) => candidate.key === afterKey)) setAfterKey(candidates[0]?.key ?? null);
  }, [afterKey, candidates]);

  useEffect(() => {
    if (!remark) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, remark]);

  if (!remark) return null;
  const target = materials.find((material) => material.id === remark.target.materialId);
  const version = target?.versions.find((candidate) => candidate.id === remark.target.versionId);
  const after = candidates.find((candidate) => candidate.key === afterKey) ?? null;
  const beforeUrl = materialUrl(remark.target.materialId, remark.target.versionId);
  const image = target?.kind === "image";
  const textual = target?.kind === "text";

  return (
    <div className="dialog-backdrop compare-dialog__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`compare-dialog${image || textual ? " compare-dialog--viewer" : ""}`} role="dialog" aria-modal="true" aria-labelledby="compare-dialog-title">
        <header className="handoff-dialog__header">
          <span className="handoff-dialog__icon"><UiIcon name="compare" size={22} /></span>
          <h2 id="compare-dialog-title">{`#${remark.number} · ${target?.name ?? ""}`}</h2>
          <span className={`compare-dialog__status ${remarkStatusClass(remark.status)}`}>{t(locale, remarkStatusKey(remark.status))}</span>
          <button className="handoff-dialog__close" type="button" onClick={onClose} aria-label={t(locale, "close")}>
            <UiIcon name="close" size={18} />
          </button>
        </header>
        <p className="compare-dialog__text">{remark.text}</p>
        {remark.report && (
          <p className="compare-dialog__report"><strong>{t(locale, "remarkAgentSays")}</strong> {remark.report.note ?? t(locale, "remarkAgentNoNote")}</p>
        )}
        {!image && !textual ? (
          <p className="handoff-dialog__empty">{t(locale, "compareUnsupported")}</p>
        ) : (
          <>
            <div className="compare-dialog__controls">
              <label>
                <span>{t(locale, "compareAfter")}</span>
                <select value={afterKey ?? ""} onChange={(event) => setAfterKey(event.target.value)} disabled={candidates.length === 0}>
                  {candidates.length === 0 && <option value="">{t(locale, "compareNothing")}</option>}
                  {candidates.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
                </select>
              </label>
              {image && (
                <div className="compare-dialog__modes" role="group">
                  <button type="button" aria-pressed={mode === "side"} onClick={() => setMode("side")}><UiIcon name="columns" size={15} />{t(locale, "compareSideBySide")}</button>
                  <button type="button" aria-pressed={mode === "slider"} onClick={() => setMode("slider")}><UiIcon name="sliders-horizontal" size={15} />{t(locale, "compareSlider")}</button>
                </div>
              )}
            </div>
            {textual ? (
              <TextCompare remark={remark} after={after} locale={locale} beforeLabel={`${t(locale, "compareBefore")} · ${t(locale, "compareVersion")} ${version?.number ?? "?"}`} />
            ) : mode === "side" || !after ? (
              <div className="compare-dialog__side">
                <figure>
                  <figcaption>{`${t(locale, "compareBefore")} · ${t(locale, "compareVersion")} ${version?.number ?? "?"}`}</figcaption>
                  <AnchoredImage url={beforeUrl} anchor={remark.target.anchor} />
                </figure>
                <figure>
                  <figcaption>{after?.label ?? t(locale, "compareNothing")}</figcaption>
                  {after ? <AnchoredImage url={after.url} anchor={after.kind === "other" || after.kind === "result" ? null : remark.target.anchor} dashed /> : <div className="compare-dialog__blank" />}
                </figure>
              </div>
            ) : (
              <CompareSlider beforeUrl={beforeUrl} afterUrl={after.url} anchor={remark.target.anchor} locale={locale} />
            )}
          </>
        )}
        <div className="handoff-dialog__actions compare-dialog__actions">
          {remark.status !== "open" && remark.status !== "reopened" && (
            <button type="button" onClick={() => onReopen(remark)}><UiIcon name="reopen" size={17} />{t(locale, "remarkReopen")}</button>
          )}
          {remark.status !== "accepted" && remark.status !== "open" && remark.status !== "reopened" && (
            <button type="button" className="handoff-dialog__send" onClick={() => onAccept(remark)}><UiIcon name="done" size={17} />{t(locale, "remarkAccept")}</button>
          )}
          <button type="button" onClick={onClose}>{t(locale, "close")}</button>
        </div>
      </section>
    </div>
  );
}

function TextCompare({ remark, after, locale, beforeLabel }: {
  remark: MaterialRemark;
  after: CompareCandidate | null;
  locale: LocaleId;
  beforeLabel: string;
}): React.JSX.Element {
  const [texts, setTexts] = useState<{ before: string; after: string | null } | "failed" | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTexts(null);
    void Promise.all([
      window.canvasTTY.materials.readText(remark.target.materialId, remark.target.versionId),
      after ? window.canvasTTY.materials.readText(after.materialId, after.versionId) : Promise.resolve(null)
    ]).then(([before, next]) => {
      if (cancelled) return;
      if (!before.ok || (next !== null && !next.ok)) setTexts("failed");
      else setTexts({ before: before.content.text, after: next ? next.content.text : null });
    });
    return () => {
      cancelled = true;
    };
  }, [after?.materialId, after?.versionId, after?.url, remark.target.materialId, remark.target.versionId]);
  if (texts === "failed") return <p className="handoff-dialog__empty">{t(locale, "materialUnreadable")}</p>;
  if (!texts) return <p className="handoff-dialog__empty">{t(locale, "materialTextLoading")}</p>;
  if (texts.after === null) return <p className="handoff-dialog__empty">{t(locale, "compareNothing")}</p>;
  const anchor = remark.target.anchor;
  return (
    <TextDiffView before={texts.before} after={texts.after} locale={locale}
      labels={{ before: beforeLabel, after: after?.label ?? "" }} marked={anchor.kind === "lines" ? anchor : null} />
  );
}

function AnchoredImage({ url, anchor, dashed = false }: { url: string; anchor: RemarkAnchor | null; dashed?: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = (): void => setBox({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rect = containedRect(box, natural);
  const position = anchor ? anchorPercentages(anchor) : null;
  return (
    <div className="compare-dialog__frame" ref={host}>
      <img src={url} alt="" draggable={false} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      {position && (
        <span className="compare-dialog__overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
          <span className={["material-remark", remarkStatusClass("open"), dashed ? "material-remark--stale" : "", anchor?.kind === "point" ? "material-remark--point" : ""].filter(Boolean).join(" ")} style={position} />
        </span>
      )}
    </div>
  );
}

function CompareSlider({ beforeUrl, afterUrl, anchor, locale }: { beforeUrl: string; afterUrl: string; anchor: RemarkAnchor; locale: LocaleId }): React.JSX.Element {
  const [split, setSplit] = useState(0.5);
  const dragging = useRef(false);
  const update = (event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width))));
  };
  return (
    <div
      className="compare-dialog__slider"
      role="slider"
      tabIndex={0}
      aria-label={t(locale, "compareSlider")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split * 100)}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) update(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onLostPointerCapture={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") setSplit((value) => Math.max(0, value - 0.05));
        if (event.key === "ArrowRight") setSplit((value) => Math.min(1, value + 0.05));
      }}
    >
      <AnchoredImage url={afterUrl} anchor={null} />
      <div className="compare-dialog__slider-before" style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }}>
        <AnchoredImage url={beforeUrl} anchor={anchor} />
      </div>
      <span className="compare-dialog__divider" style={{ left: `${split * 100}%` }} />
    </div>
  );
}
