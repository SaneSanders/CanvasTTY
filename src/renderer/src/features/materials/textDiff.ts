export const DIFF_LINE_LIMIT = 20_000;
export const DIFF_EDIT_LIMIT = 2_000;

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  before: number | null;
  after: number | null;
}

export type DiffRow = DiffLine | { kind: "skip"; count: number };

export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] | null {
  if (before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const middle = editScript(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix));
  if (!middle) return null;
  const lines: DiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) lines.push({ kind: "same", text: before[index], before: index + 1, after: index + 1 });
  for (const line of middle) {
    lines.push({
      kind: line.kind,
      text: line.text,
      before: line.before === null ? null : line.before + prefix + 1,
      after: line.after === null ? null : line.after + prefix + 1
    });
  }
  for (let index = suffix; index > 0; index -= 1) {
    lines.push({
      kind: "same",
      text: before[before.length - index],
      before: before.length - index + 1,
      after: after.length - index + 1
    });
  }
  return lines;
}

export function diffRows(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let offset = Math.max(0, index - context); offset <= Math.min(lines.length - 1, index + context); offset += 1) keep[offset] = 1;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) rows.push({ kind: "skip", count: skipped });
  return rows;
}

function editScript(before: readonly string[], after: readonly string[]): DiffLine[] | null {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0) {
    if (n + m > DIFF_EDIT_LIMIT) return null;
    return [
      ...before.map((text, index): DiffLine => ({ kind: "removed", text, before: index, after: null })),
      ...after.map((text, index): DiffLine => ({ kind: "added", text, before: null, after: index }))
    ];
  }
  const max = Math.min(n + m, DIFF_EDIT_LIMIT);
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(frontier.slice(offset - depth - 1, offset + depth + 2));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth || (diagonal !== depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
      let x = down ? frontier[offset + diagonal + 1] : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) return backtrack(trace, before, after, depth);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], before: readonly string[], after: readonly string[], depth: number): DiffLine[] {
  const lines: DiffLine[] = [];
  let x = before.length;
  let y = after.length;
  for (let step = depth; step > 0; step -= 1) {
    const frontier = trace[step];
    const at = (diagonal: number): number => frontier[diagonal + step + 1];
    const diagonal = x - y;
    const down = diagonal === -step || (diagonal !== step && at(diagonal - 1) < at(diagonal + 1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = at(previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      lines.push({ kind: "same", text: before[x], before: x, after: y });
    }
    if (down) {
      y -= 1;
      lines.push({ kind: "added", text: after[y], before: null, after: y });
    } else {
      x -= 1;
      lines.push({ kind: "removed", text: before[x], before: x, after: null });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    lines.push({ kind: "same", text: before[x], before: x, after: y });
  }
  return lines.reverse();
}
