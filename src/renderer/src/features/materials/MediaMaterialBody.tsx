import { useEffect, useRef, useState } from "react";
import type { CanvasMaterial, LocaleId } from "../../../../shared/contracts";
import { formatClock, MATERIAL_PLACEMENT_GAP, materialUrl } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { containedRect, remarkStatusClass, remarkStatusKey, type MaterialRemarkActions, type MaterialRemarking } from "./materialRemarksModel";
import { timeMarkers } from "./mediaModel";
import { RemarkChips } from "./RemarkChips";

const FRAME_PROBES: ReadonlyArray<readonly [number, number]> = [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]];

export function MediaMaterialBody({
  material,
  locale,
  remarking,
  remarkActions,
  staleVersionIds,
  onFailed
}: {
  material: CanvasMaterial;
  locale: LocaleId;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
  staleVersionIds: ReadonlySet<string>;
  onFailed(): void;
}): React.JSX.Element {
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [spanStart, setSpanStart] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const video = material.kind === "video";
  const drawing = remarking.mode === "draw" || remarking.mode === "pick";
  const source = materialUrl(material.id, null, material.liveRevision);
  const markers = timeMarkers(remarking.remarks, duration, staleVersionIds);
  const unplaced = duration === null ? remarking.remarks.filter((remark) => remark.target.anchor.kind === "time") : [];

  useEffect(() => {
    if (!drawing) setSpanStart(null);
  }, [drawing]);

  const moment = (): number => {
    const element = player.current;
    element?.pause();
    return Math.round((element?.currentTime ?? 0) * 10) / 10;
  };

  const seek = (time: number): void => {
    const element = player.current;
    if (!element) return;
    element.pause();
    element.currentTime = time;
  };

  const captureFrame = async (): Promise<void> => {
    const element = player.current;
    if (!element || capturing) return;
    element.pause();
    setCapturing(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const box = element.getBoundingClientRect();
      const shown = containedRect({ width: box.width, height: box.height }, element.videoWidth > 0 ? { width: element.videoWidth, height: element.videoHeight } : null);
      const rect = { x: box.left + shown.left, y: box.top + shown.top, width: shown.width, height: shown.height };
      const result = uncovered(element, rect)
        ? await window.canvasTTY.materials.captureFrame({
            materialId: material.id,
            time: element.currentTime,
            rect,
            point: { x: material.position.x + material.size.width + MATERIAL_PLACEMENT_GAP, y: material.position.y }
          })
        : null;
      setCaptureFailed(!result?.ok);
    } catch {
      setCaptureFailed(true);
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className={`material-media ${video ? "material-media--video" : "material-media--audio"}`}>
      {video ? (
        <video
          ref={player}
          className="material-card__video"
          src={source}
          controls={!capturing}
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null)}
          onTimeUpdate={(event) => setNow(event.currentTarget.currentTime)}
          onError={onFailed}
        />
      ) : (
        <div className="material-card__audio">
          <UiIcon name="music" size="2.2em" />
          <audio
            ref={player}
            src={source}
            controls
            preload="metadata"
            onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null)}
            onTimeUpdate={(event) => setNow(event.currentTarget.currentTime)}
            onError={onFailed}
          />
        </div>
      )}
      {unplaced.length > 0 && (
        <RemarkChips locale={locale} label={t(locale, "materialRemarks")} remarks={unplaced} onSelect={remarkActions.select} />
      )}
      {(markers.length > 0 || drawing) && (
        <div className="material-media__timeline" aria-label={t(locale, "mediaTimeline")}>
          {duration !== null && drawing && spanStart !== null && (
            <span className="material-media__pending" style={{ left: `${(spanStart / duration) * 100}%`, width: `${(Math.max(0, now - spanStart) / duration) * 100}%` }} />
          )}
          {markers.map((marker) => (
            <button
              key={marker.remarkId}
              type="button"
              className={[
                "material-media__marker",
                remarkStatusClass(marker.status),
                marker.stale ? "material-media__marker--stale" : "",
                marker.width === null ? "material-media__marker--moment" : "",
                marker.remarkId === remarking.selectedRemarkId ? "material-media__marker--selected" : ""
              ].filter(Boolean).join(" ")}
              style={{ left: `${marker.left}%`, ...(marker.width === null ? {} : { width: `${marker.width}%` }) }}
              title={`#${marker.number} · ${marker.label} · ${t(locale, remarkStatusKey(marker.status))}`}
              aria-label={`#${marker.number} · ${marker.label}`}
              onClick={() => {
                seek(marker.start);
                remarkActions.select(marker.remarkId);
              }}
            />
          ))}
        </div>
      )}
      {drawing ? (
        <div className="material-media__bar">
          <span>{`${t(locale, "mediaNow")} ${formatClock(now)}`}</span>
          <button type="button" onClick={() => remarkActions.draw(material.id, { kind: "time", start: moment(), end: null })}>
            <UiIcon name="flag" size="1em" />{t(locale, "mediaMarkMoment")}
          </button>
          {spanStart === null ? (
            <button type="button" onClick={() => setSpanStart(moment())}>{t(locale, "mediaSpanStart")}</button>
          ) : (
            <button
              type="button"
              disabled={now <= spanStart}
              onClick={() => {
                const end = moment();
                if (end > spanStart) remarkActions.draw(material.id, { kind: "time", start: spanStart, end });
                setSpanStart(null);
              }}
            >{`${t(locale, "mediaSpanEnd")} (${formatClock(spanStart)}–${formatClock(now)})`}</button>
          )}
        </div>
      ) : video ? (
        <div className="material-media__bar">
          <button type="button" disabled={capturing} onClick={() => void captureFrame()}>
            <UiIcon name="camera" size="1em" />{t(locale, "mediaCaptureFrame")}
          </button>
          {captureFailed && <span className="material-media__error">{t(locale, "mediaCaptureFailed")}</span>}
        </div>
      ) : null}
    </div>
  );
}

function uncovered(element: Element, rect: { x: number; y: number; width: number; height: number }): boolean {
  if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0
    || rect.x + rect.width > window.innerWidth || rect.y + rect.height > window.innerHeight) return false;
  return FRAME_PROBES.every(([x, y]) => document.elementFromPoint(rect.x + rect.width * x, rect.y + rect.height * y) === element);
}
