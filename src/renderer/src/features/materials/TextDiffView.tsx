import { useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { diffLines, diffRows } from "./textDiff";

const DIFF_OVERSCAN = 8;
const DIFF_FIRST_PAGE = 50;

export function TextDiffView({
  before,
  after,
  locale,
  labels,
  marked = null
}: {
  before: string;
  after: string;
  locale: LocaleId;
  labels: { before: string; after: string };
  marked?: { start: number; end: number } | null;
}): React.JSX.Element {
  const rows = useMemo(() => {
    const lines = diffLines(before.split("\n"), after.split("\n"));
    return lines ? diffRows(lines) : null;
  }, [after, before]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ rowHeight: 0, legendHeight: 0, scrollTop: 0, clientHeight: 0 });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !rows) return;
    const measure = (): void => {
      const row = element.querySelector<HTMLElement>(".material-text-diff__row, .material-text-diff__skip");
      const legend = element.querySelector<HTMLElement>(".material-text-diff__legend");
      setMetrics({
        rowHeight: row?.offsetHeight ?? 0,
        legendHeight: legend?.offsetHeight ?? 0,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rows]);

  if (!rows) return <p className="material-text-diff__empty">{t(locale, "compareTooDifferent")}</p>;
  if (rows.every((row) => row.kind === "skip")) return <p className="material-text-diff__empty">{t(locale, "compareNoDifference")}</p>;

  const windowed = metrics.rowHeight > 0;
  const scrolled = Math.max(0, metrics.scrollTop - metrics.legendHeight);
  const first = windowed ? Math.max(0, Math.floor(scrolled / metrics.rowHeight) - DIFF_OVERSCAN) : 0;
  const last = windowed
    ? Math.min(rows.length, Math.ceil((scrolled + metrics.clientHeight) / metrics.rowHeight) + DIFF_OVERSCAN)
    : Math.min(rows.length, DIFF_FIRST_PAGE);
  return (
    <div
      ref={scrollRef}
      className="material-text-diff"
      role="table"
      aria-label={t(locale, "compareDifference")}
      data-canvas-wheel-priority="local"
      onScroll={(event) => {
        const { scrollTop, clientHeight } = event.currentTarget;
        setMetrics((current) => ({ ...current, scrollTop, clientHeight }));
      }}
    >
      <p className="material-text-diff__legend">
        <span className="material-text-diff__legend-removed">{`− ${labels.before}`}</span>
        <span className="material-text-diff__legend-added">{`+ ${labels.after}`}</span>
      </p>
      {first > 0 && <div aria-hidden="true" style={{ height: first * metrics.rowHeight }} />}
      {rows.slice(first, last).map((row, index) => row.kind === "skip" ? (
        <div key={`skip-${first + index}`} className="material-text-diff__skip" role="row">{`${t(locale, "compareUnchanged")} ${row.count}`}</div>
      ) : (
        <div
          key={`${row.kind}-${row.before ?? ""}-${row.after ?? ""}`}
          className={[
            "material-text-diff__row",
            `material-text-diff__row--${row.kind}`,
            marked && row.before !== null && row.before >= marked.start && row.before <= marked.end ? "material-text-diff__row--marked" : ""
          ].filter(Boolean).join(" ")}
          role="row"
        >
          <span className="material-text-diff__number">{row.before ?? ""}</span>
          <span className="material-text-diff__number">{row.after ?? ""}</span>
          <span className="material-text-diff__sign" aria-hidden="true">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
          <span className="material-text-diff__text">{row.text || " "}</span>
        </div>
      ))}
      {last < rows.length && <div aria-hidden="true" style={{ height: (rows.length - last) * metrics.rowHeight }} />}
    </div>
  );
}
