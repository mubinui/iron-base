/**
 * Line diffs, for showing a change before it is made.
 *
 * The permission card is the moment a developer decides whether to let a model
 * write to their file, so the diff behind it has to be one they can actually
 * read: the changed lines, a little context, and nothing else. A patch shown as
 * two full files is not a decision anyone can make in three seconds.
 *
 * Deliberately free of `vscode`, so the algorithm can be tested directly.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number on its own side; absent on the side it does not exist. */
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /**
   * True when the change was too large to align line by line and is shown as one
   * wholesale replacement instead. Rare, and worth admitting rather than
   * pretending the diff is exact.
   */
  coarse: boolean;
}

/** Lines to show either side of a change. */
const CONTEXT = 3;
/**
 * Above this many differing lines the quadratic alignment stops being worth its
 * cost — and a diff that big is not being read line by line anyway.
 */
const MAX_ALIGNED_LINES = 1500;

export function diffLines(before: string, after: string): FileDiff {
  const oldLines = before.length === 0 ? [] : before.split(/\r?\n/);
  const newLines = after.length === 0 ? [] : after.split(/\r?\n/);

  // Identical head and tail are the bulk of most edits and cost nothing to
  // skip, which is also what keeps the alignment below small enough to run.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);

  const coarse = oldMiddle.length > MAX_ALIGNED_LINES || newMiddle.length > MAX_ALIGNED_LINES;
  const middle: DiffLine[] = coarse
    ? [
        ...oldMiddle.map((text, i) => lineOf("remove", text, head + i + 1, undefined)),
        ...newMiddle.map((text, i) => lineOf("add", text, undefined, head + i + 1)),
      ]
    : align(oldMiddle, newMiddle, head);

  const all: DiffLine[] = [
    ...oldLines.slice(0, head).map((text, i) => lineOf("context", text, i + 1, i + 1)),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((text, i) => {
      const oldNo = oldLines.length - tail + i + 1;
      return lineOf("context", text, oldNo, newLines.length - tail + i + 1);
    }),
  ];

  return {
    hunks: toHunks(all),
    added: all.filter((l) => l.kind === "add").length,
    removed: all.filter((l) => l.kind === "remove").length,
    coarse,
  };
}

/** "+12 −3", or "no change". The minus is U+2212, which lines up with the plus. */
export function formatDiffCounts(diff: Pick<FileDiff, "added" | "removed">): string {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`+${diff.added}`);
  if (diff.removed > 0) parts.push(`−${diff.removed}`);
  return parts.length > 0 ? parts.join(" ") : "no change";
}

/** A unified-diff rendering, for the Markdown export and the output channel. */
export function formatUnified(diff: FileDiff): string {
  const out: string[] = [];
  for (const hunk of diff.hunks) {
    const oldCount = hunk.lines.filter((l) => l.kind !== "add").length;
    const newCount = hunk.lines.filter((l) => l.kind !== "remove").length;
    out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`);
    }
  }
  return out.join("\n");
}

/**
 * Longest common subsequence over lines, walked back into add/remove/context.
 *
 * The table is `(n+1)×(m+1)` numbers, which is why the caller trims the shared
 * head and tail first and gives up past `MAX_ALIGNED_LINES`.
 */
function align(oldLines: string[], newLines: string[], offset: number): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(lineOf("context", oldLines[i], offset + i + 1, offset + j + 1));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(lineOf("remove", oldLines[i], offset + i + 1, undefined));
      i++;
    } else {
      out.push(lineOf("add", newLines[j], undefined, offset + j + 1));
      j++;
    }
  }
  while (i < n) out.push(lineOf("remove", oldLines[i], offset + ++i, undefined));
  while (j < m) out.push(lineOf("add", newLines[j], undefined, offset + ++j));
  return out;
}

/** Groups changed lines with CONTEXT lines either side, dropping the rest. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  const changed = lines
    .map((line, i) => (line.kind === "context" ? -1 : i))
    .filter((i) => i >= 0);
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(lines.length - 1, index + CONTEXT);
    const last = ranges[ranges.length - 1];
    // Overlapping windows are joined rather than emitted as two hunks that
    // repeat the same context lines between them.
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  return ranges.map(([from, to]) => {
    const slice = lines.slice(from, to + 1);
    return {
      oldStart: slice.find((l) => l.oldLine !== undefined)?.oldLine ?? 1,
      newStart: slice.find((l) => l.newLine !== undefined)?.newLine ?? 1,
      lines: slice,
    };
  });
}

function lineOf(
  kind: DiffLineKind,
  text: string,
  oldLine: number | undefined,
  newLine: number | undefined,
): DiffLine {
  return { kind, text, oldLine, newLine };
}
