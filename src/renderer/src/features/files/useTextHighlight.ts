import { useEffect, useMemo, useState } from "react";
import { classifyTextPreview } from "./textPreview.ts";
import type { HighlightLines } from "./textPreview.ts";

interface TextHighlightInput {
  name: string;
  text: string;
  hash: string;
  byteSize: number;
}

interface HighlightResult {
  hash: string;
  language: string;
  lines: HighlightLines | null;
}

export function useTextHighlight(input: TextHighlightInput | null): { lines: HighlightLines | null; plain: boolean } {
  const name = input?.name ?? "";
  const content = input?.text ?? "";
  const hash = input?.hash ?? null;
  const byteSize = input?.byteSize ?? 0;
  const model = useMemo(() => classifyTextPreview({ name, content, byteSize, truncated: false }), [name, content, byteSize]);
  const language = model.highlightable ? model.language : null;
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    if (hash === null || language === null) return;
    let cancelled = false;
    void import("./codeHighlight.ts").then(({ highlightCodeLines }) => {
      if (cancelled) return;
      const lines = highlightCodeLines(content, language);
      if (!cancelled) setResult({ hash, language, lines });
    }).catch(() => {
      if (!cancelled) setResult({ hash, language, lines: null });
    });
    return () => { cancelled = true; };
  }, [hash, language, content]);

  const current = result?.hash === hash && result?.language === language ? result : null;
  return { lines: current?.lines ?? null, plain: model.richDisabled || (current !== null && current.lines === null) };
}
