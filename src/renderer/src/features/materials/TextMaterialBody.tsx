import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasMaterial, LocaleId, MaterialFailure, MaterialText } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { matchesPhysicalOrLayoutKey } from "../../lib/shortcuts";
import { formatBytes } from "./materialCardModel";
import { MaterialNotice } from "./MaterialCard";
import { remarkStatusClass, remarkStatusKey, type MaterialRemarkActions, type MaterialRemarking } from "./materialRemarksModel";
import {
  DRAFT_SAVE_DELAY_MS,
  followLive,
  lineAnchor,
  lineAt,
  lineMarkers,
  TEXT_ROW_HEIGHT,
  textEditState,
  textFailureKey,
  visibleRows
} from "./materialTextModel";
import { TextDiffView } from "./TextDiffView";

type Notice =
  | { kind: "saved"; kept: boolean }
  | { kind: "failed"; reason: MaterialFailure }
  | { kind: "draft-failed"; reason: MaterialFailure }
  | { kind: "unkept"; reason: "quota" | "version-limit" }
  | null;

interface Selection {
  pointerId: number;
  from: number;
  to: number;
}

export function TextMaterialBody({
  material,
  locale,
  remarking,
  remarkActions,
  staleVersionIds,
  editing,
  onEditingChange,
  onReadable,
  onPendingText
}: {
  material: CanvasMaterial;
  locale: LocaleId;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
  staleVersionIds: ReadonlySet<string>;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onReadable(readable: boolean): void;
  onPendingText?(pending: boolean): void;
}): React.JSX.Element {
  const [live, setLive] = useState<MaterialText | null>(null);
  const [failure, setFailure] = useState<MaterialFailure | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [baseText, setBaseText] = useState<string | null>(null);
  const [showingDiff, setShowingDiff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 360 });
  const scroller = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const liveRef = useRef(live);
  const onReadableRef = useRef(onReadable);
  const onEditingChangeRef = useRef(onEditingChange);
  const onPendingTextRef = useRef(onPendingText);
  onReadableRef.current = onReadable;
  onEditingChangeRef.current = onEditingChange;
  onPendingTextRef.current = onPendingText;
  const draftTimer = useRef<number | null>(null);
  const pending = useRef<{ baseHash: string; text: string } | null>(null);
  const draftGeneration = useRef(0);
  const scrolledTo = useRef<string | null>(null);
  liveRef.current = live;

  const lines = useMemo(() => (live ? live.text.split("\n") : []), [live]);
  const markers = useMemo(() => lineMarkers(remarking.remarks, lines.length, staleVersionIds), [lines.length, remarking.remarks, staleVersionIds]);
  const state = saving ? "draft" : textEditState(baseHash, draftText, live);
  const drawing = remarking.mode === "draw" || remarking.mode === "pick";

  useEffect(() => {
    onPendingTextRef.current?.(state === "draft" || state === "conflict");
  }, [state]);

  useEffect(() => {
    if (material.state !== "ready") return;
    const id = ++request.current;
    void window.canvasTTY.materials.readText(material.id, null).then((result) => {
      if (id !== request.current) return;
      setLive(result.ok ? result.content : null);
      setFailure(result.ok ? null : result.reason);
      onReadableRef.current(result.ok && !material.draftError);
      if (!result.ok) onEditingChangeRef.current(false);
    });
  }, [material.id, material.liveRevision, material.state, material.draftError]);

  const flushDraft = (): void => {
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const current = liveRef.current;
    if (current && next.baseHash === current.hash && next.text === current.text) {
      void window.canvasTTY.materials.discardDraft(material.id);
      return;
    }
    const generation = (draftGeneration.current += 1);
    void window.canvasTTY.materials.writeDraft(material.id, next).then((result) => {
      if (draftGeneration.current !== generation) return;
      if (!result.ok) {
        pending.current = next;
        setNotice({ kind: "draft-failed", reason: result.reason });
      } else {
        setNotice((current) => current?.kind === "draft-failed" ? null : current);
      }
    }).catch(() => {
      if (draftGeneration.current !== generation) return;
      pending.current = next;
      setNotice({ kind: "draft-failed", reason: "write-failed" });
    });
  };
  const flushDraftRef = useRef(flushDraft);
  flushDraftRef.current = flushDraft;
  useEffect(() => () => flushDraftRef.current(), []);

  useEffect(() => {
    if (editing) return;
    flushDraftRef.current();
    setShowingDiff(false);
  }, [editing]);

  useEffect(() => {
    if (!editing || !live || draftText !== null) return;
    let cancelled = false;
    void window.canvasTTY.materials.readDraft(material.id).then((draft) => {
      if (cancelled) return;
      setDraftText(draft ? draft.text : live.text);
      setBaseHash(draft ? draft.baseHash : live.hash);
      setBaseText(!draft || draft.baseHash === live.hash ? live.text : null);
    }).catch(() => {
      if (!cancelled) setNotice({ kind: "failed", reason: "write-failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [draftText, editing, live, material.id]);

  useEffect(() => {
    if (!live || baseHash === null || draftText === null || saving) return;
    const next = followLive({ baseHash, baseText, text: draftText }, live);
    if (!next) return;
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    draftGeneration.current += 1;
    pending.current = null;
    void window.canvasTTY.materials.discardDraft(material.id);
    setBaseHash(next.baseHash);
    setBaseText(next.baseText);
    setDraftText(next.text);
  }, [baseHash, baseText, draftText, live, material.id, saving]);

  useEffect(() => {
    if (notice?.kind !== "saved") return;
    const timer = window.setTimeout(() => setNotice(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = (): void => setViewport({ top: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [editing, live === null]);

  useEffect(() => {
    const selectedId = remarking.selectedRemarkId;
    if (selectedId === scrolledTo.current) return;
    const anchor = remarking.remarks.find((candidate) => candidate.id === selectedId)?.target.anchor;
    const element = scroller.current;
    if (selectedId !== null && (!anchor || (anchor.kind === "lines" && !element))) return;
    scrolledTo.current = selectedId;
    if (anchor?.kind !== "lines" || !element) return;
    const top = (anchor.start - 1) * TEXT_ROW_HEIGHT;
    if (top < element.scrollTop || top > element.scrollTop + element.clientHeight - TEXT_ROW_HEIGHT) {
      element.scrollTop = Math.max(0, top - TEXT_ROW_HEIGHT * 2);
    }
  }, [editing, live, remarking.remarks, remarking.selectedRemarkId]);

  const changeText = (text: string): void => {
    if (baseHash === null) return;
    setDraftText(text);
    setNotice(null);
    draftGeneration.current += 1;
    pending.current = { baseHash, text };
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => flushDraftRef.current(), DRAFT_SAVE_DELAY_MS);
  };

  const resetToDisk = (): void => {
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    draftGeneration.current += 1;
    pending.current = null;
    void window.canvasTTY.materials.discardDraft(material.id);
    if (live) {
      setDraftText(live.text);
      setBaseHash(live.hash);
      setBaseText(live.text);
    }
    setShowingDiff(false);
    setNotice(null);
  };

  const save = async (againstHash: string | null = null, allowUnversioned = false): Promise<void> => {
    if (draftText === null || baseHash === null || saving) return;
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    draftGeneration.current += 1;
    pending.current = null;
    const expected = againstHash ?? baseHash;
    setSaving(true);
    try {
      const result = await window.canvasTTY.materials.saveText(material.id, { baseHash: expected, text: draftText, allowUnversioned });
      if (result.ok) {
        setLive(result.content);
        setDraftText(result.content.text);
        setBaseHash(result.content.hash);
        setBaseText(result.content.text);
        setShowingDiff(false);
        setNotice({ kind: "saved", kept: result.previous !== null || result.content.hash === expected });
      } else {
        pending.current = { baseHash, text: draftText };
        flushDraftRef.current();
        if (result.reason === "conflict") {
          setLive(result.current);
        } else if (result.reason === "quota" || result.reason === "version-limit") {
          setNotice({ kind: "unkept", reason: result.reason });
        } else {
          setNotice({ kind: "failed", reason: result.reason });
        }
      }
    } catch {
      pending.current = { baseHash, text: draftText };
      flushDraftRef.current();
      setNotice({ kind: "failed", reason: "write-failed" });
    } finally {
      setSaving(false);
    }
  };

  const lineFromPointer = (event: React.PointerEvent<HTMLDivElement>): number => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const scale = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    return lineAt((event.clientY - rect.top) / (scale || 1), element.scrollTop, lines.length);
  };

  if (failure) {
    return (
      <MaterialNotice
        icon="error"
        title={t(locale, textFailureKey(failure))}
        hint={material.byteSize !== null ? formatBytes(material.byteSize, locale) : ""}
      />
    );
  }
  if (!live) return <div className="material-text material-text--loading">{t(locale, "materialTextLoading")}</div>;

  const draftNotice = material.draftError && (
    <div className="material-text__banner material-text__banner--conflict" role="alert">
      {t(locale, "materialTextDraftUnavailable")}
    </div>
  );
  const failureText = notice?.kind === "draft-failed"
    ? t(locale, "materialTextDraftNotKept")
    : notice?.kind === "failed" ? t(locale, textFailureKey(notice.reason)) : null;

  if (editing) {
    return (
      <div className="material-text material-text--editing">
        {draftNotice}
        {state === "conflict" && (
          <div className="material-text__banner material-text__banner--conflict" role="alert">
            <span>{t(locale, "materialTextConflict")}</span>
            <button type="button" onClick={() => setShowingDiff((value) => !value)}>
              <UiIcon name="compare" size="1em" />{t(locale, showingDiff ? "materialTextHideChanges" : "materialTextShowChanges")}
            </button>
            <button type="button" onClick={() => void save(live.hash)}>{t(locale, "materialTextKeepMine")}</button>
            <button type="button" onClick={resetToDisk}>{t(locale, "materialTextTakeDisk")}</button>
          </div>
        )}
        {notice?.kind === "unkept" && (
          <div className="material-text__banner material-text__banner--conflict" role="alert">
            <span>{t(locale, notice.reason === "quota" ? "materialTextUnkeptQuota" : "materialTextUnkeptLimit")}</span>
            <button type="button" onClick={() => void save(null, true)}>{t(locale, "materialTextSaveUnkept")}</button>
          </div>
        )}
        {!live.editable && <div className="material-text__banner" role="status">{t(locale, "materialTextReadOnly")}</div>}
        {showingDiff && draftText !== null ? (
          <TextDiffView before={live.text} after={draftText} locale={locale}
            labels={{ before: t(locale, "materialTextOnDisk"), after: t(locale, "materialTextYours") }} />
        ) : (
          <textarea
            className="material-text__editor"
            value={draftText ?? ""}
            readOnly={draftText === null || !live.editable || saving}
            spellCheck={false}
            aria-label={material.name}
            data-canvas-wheel-priority="local"
            onChange={(event) => changeText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && !event.altKey && matchesPhysicalOrLayoutKey(event, "KeyS", "s")) {
                event.preventDefault();
                if (state === "draft" && live.editable) void save();
              }
            }}
          />
        )}
        <footer className="material-text__status">
          <span className={failureText ? "material-text__status-error" : ""}>
            {failureText
              ? failureText
              : notice?.kind === "saved"
                ? t(locale, notice.kept ? "materialTextSaved" : "materialTextSavedNoVersion")
                : state === "clean" ? t(locale, "materialTextNoChanges") : t(locale, "materialTextUnsaved")}
          </span>
          <button type="button" onClick={resetToDisk} disabled={state === "clean" || saving}>
            <UiIcon name="reopen" size="1em" />{t(locale, "materialTextDiscard")}
          </button>
          <button type="button" className="material-text__save" onClick={() => void save()} disabled={state !== "draft" || saving || !live.editable}>
            <UiIcon name="done" size="1em" />{t(locale, "materialTextSave")}
          </button>
          <button type="button" onClick={() => onEditingChange(false)}>{t(locale, "materialTextDone")}</button>
        </footer>
      </div>
    );
  }

  const { first, last } = visibleRows(viewport.top, viewport.height, lines.length);
  const draftAnchor = remarking.draftAnchor?.kind === "lines" ? remarking.draftAnchor : null;
  const referenceAnchor = remarking.referenceAnchor?.kind === "lines" ? remarking.referenceAnchor : null;
  const selected = remarking.remarks.find((remark) => remark.id === remarking.selectedRemarkId)?.target.anchor;
  const highlight = selection
    ? { start: Math.min(selection.from, selection.to), end: Math.max(selection.from, selection.to) }
    : draftAnchor ?? referenceAnchor ?? (selected?.kind === "lines" ? selected : null);
  const gutter = `${String(lines.length).length + 1}ch`;

  return (
    <div className={`material-text ${drawing ? "material-text--drawing" : ""}`}>
      {draftNotice}
      {failureText && <div className="material-text__banner material-text__banner--conflict" role="alert">{failureText}</div>}
      {(material.draft || state !== "clean") && (
        <div className="material-text__banner" role="status">
          <span>{t(locale, "materialTextDraftBanner")}</span>
          <button type="button" onClick={() => onEditingChange(true)}><UiIcon name="pencil" size="1em" />{t(locale, "materialTextContinue")}</button>
          <button type="button" onClick={resetToDisk}>{t(locale, "materialTextDiscard")}</button>
        </div>
      )}
      <div
        ref={scroller}
        className="material-text__scroller"
        data-canvas-card-control="true"
        role="document"
        aria-label={material.name}
        style={{ "--material-text-gutter": gutter, "--material-text-row": `${TEXT_ROW_HEIGHT}px` } as React.CSSProperties}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        onPointerDown={(event) => {
          if (!drawing || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          const line = lineFromPointer(event);
          setSelection({ pointerId: event.pointerId, from: line, to: line });
        }}
        onPointerMove={(event) => {
          if (selection?.pointerId !== event.pointerId) return;
          const line = lineFromPointer(event);
          if (line !== selection.to) setSelection({ ...selection, to: line });
        }}
        onPointerUp={(event) => {
          if (selection?.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const anchor = lineAnchor(selection.from, lineFromPointer(event), lines.length);
          setSelection(null);
          remarkActions.draw(material.id, anchor);
        }}
        onPointerCancel={() => setSelection(null)}
      >
        <div className="material-text__rows" style={{ height: lines.length * TEXT_ROW_HEIGHT }}>
          {Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => {
            const index = first + offset;
            const number = index + 1;
            const marked = highlight !== null && number >= highlight.start && number <= highlight.end;
            return (
              <div key={index} className={`material-text__row ${marked ? "material-text__row--marked" : ""}`} style={{ top: index * TEXT_ROW_HEIGHT }}>
                <span className="material-text__number">
                  {markers.filter((marker) => number >= marker.start && number <= marker.end).map((marker) => (
                    <button
                      key={marker.remarkId}
                      type="button"
                      className={[
                        "material-text__marker",
                        remarkStatusClass(marker.status),
                        marker.stale ? "material-text__marker--stale" : "",
                        marker.remarkId === remarking.selectedRemarkId ? "material-text__marker--selected" : ""
                      ].filter(Boolean).join(" ")}
                      style={{ "--material-text-lane": marker.lane } as React.CSSProperties}
                      title={`#${marker.number} · ${t(locale, remarkStatusKey(marker.status))}`}
                      aria-label={`#${marker.number}`}
                      aria-hidden={number !== marker.start}
                      tabIndex={number === marker.start ? 0 : -1}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => remarkActions.select(marker.remarkId)}
                    />
                  ))}
                  {number}
                </span>
                <span className="material-text__line">{lines[index] || " "}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
