import { describe, expect, it } from "vitest";
import { diffLines, formatDiffCounts, formatUnified } from "./diff";

const lines = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("diffLines", () => {
  it("reports no hunks when nothing changed", () => {
    const diff = diffLines("a\nb\nc", "a\nb\nc");
    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("counts a one-line replacement as one added and one removed", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(formatDiffCounts(diff)).toBe("+1 −1");
  });

  it("numbers each side independently", () => {
    const diff = diffLines("a\nb\nc", "a\nx\ny\nb\nc");
    const added = diff.hunks[0].lines.filter((l) => l.kind === "add");
    expect(added.map((l) => l.text)).toEqual(["x", "y"]);
    expect(added.map((l) => l.newLine)).toEqual([2, 3]);
    // Added lines exist only on the new side.
    expect(added.every((l) => l.oldLine === undefined)).toBe(true);
  });

  it("treats an empty original as an all-new file", () => {
    const diff = diffLines("", "a\nb");
    expect(diff.removed).toBe(0);
    expect(diff.added).toBe(2);
  });

  it("keeps only a window of context around a change in a long file", () => {
    const before = lines(200);
    const after = before.replace("line 100", "line 100 changed");
    const diff = diffLines(before, after);
    expect(diff.hunks).toHaveLength(1);
    // Three lines of context either side of one replaced line.
    expect(diff.hunks[0].lines).toHaveLength(8);
    expect(diff.hunks[0].oldStart).toBe(97);
  });

  it("joins changes whose context windows overlap into one hunk", () => {
    const before = lines(50);
    const after = before.replace("line 10", "ten").replace("line 12", "twelve");
    expect(diffLines(before, after).hunks).toHaveLength(1);
  });

  it("keeps distant changes in separate hunks", () => {
    const before = lines(80);
    const after = before.replace("line 10", "ten").replace("line 60", "sixty");
    expect(diffLines(before, after).hunks).toHaveLength(2);
  });

  it("falls back to a coarse diff rather than aligning an enormous change", () => {
    const diff = diffLines(lines(2000, "old"), lines(2000, "new"));
    expect(diff.coarse).toBe(true);
    expect(diff.added).toBe(2000);
    expect(diff.removed).toBe(2000);
  });

  it("renders a unified header naming both sides", () => {
    const unified = formatUnified(diffLines("a\nb\nc", "a\nB\nc"));
    expect(unified).toContain("@@ -1,3 +1,3 @@");
    expect(unified).toContain("-b");
    expect(unified).toContain("+B");
  });
});

describe("formatDiffCounts", () => {
  it("omits the side that did not change", () => {
    expect(formatDiffCounts({ added: 4, removed: 0 })).toBe("+4");
    expect(formatDiffCounts({ added: 0, removed: 2 })).toBe("−2");
    expect(formatDiffCounts({ added: 0, removed: 0 })).toBe("no change");
  });
});
