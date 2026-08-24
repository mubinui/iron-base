/**
 * Tests for the one function standing between text a language model wrote and
 * the file system.
 *
 * Everything here is a path a model could plausibly emit — by confusion or by
 * suggestion in a poisoned source file — and the contract is that anything the
 * guard cannot vouch for comes back `undefined` rather than resolved. These
 * are the cases that must never regress when the matching is next tweaked.
 */

import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { relativeTo, resolveInside } from "./paths";

const root = vscode.Uri.file("/work/project") as vscode.Uri;

describe("resolveInside", () => {
  describe("accepts paths inside the workspace", () => {
    it("resolves a plain relative path", () => {
      expect(resolveInside(root, "src/app.ts")?.path).toBe("/work/project/src/app.ts");
    });

    it("resolves a dot-slash prefixed path", () => {
      expect(resolveInside(root, "./src/app.ts")?.path).toBe("/work/project/src/app.ts");
    });

    it("resolves a deeply nested path", () => {
      expect(resolveInside(root, "src/engine/tools/inner.ts")?.path).toBe(
        "/work/project/src/engine/tools/inner.ts",
      );
    });

    it("accepts backslash separators, which Windows models emit", () => {
      expect(resolveInside(root, "src\\report\\styles.ts")?.path).toBe(
        "/work/project/src/report/styles.ts",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(resolveInside(root, "  src/app.ts  ")?.path).toBe("/work/project/src/app.ts");
    });

    it("treats an empty path and a bare dot as the root itself", () => {
      expect(resolveInside(root, "")).toBe(root);
      expect(resolveInside(root, ".")).toBe(root);
      expect(resolveInside(root, "   ")).toBe(root);
    });

    // A bare "/" collapses to the empty path and comes back as the workspace
    // root rather than the filesystem root — contained, not an escape. Pinned
    // here because it reads like a traversal and is not one, so the next person
    // to tighten the absolute-path check knows this case was considered.
    it("collapses a bare slash to the workspace root, not the filesystem root", () => {
      expect(resolveInside(root, "/")).toBe(root);
    });
  });

  describe("refuses anything that leaves the workspace", () => {
    // The table is the point: each of these is a real shape a model has been
    // observed to produce, and every one of them must come back undefined.
    const refused: [string, string][] = [
      ["a bare parent segment", ".."],
      ["a traversal to an absolute-looking target", "../etc/passwd"],
      ["a traversal buried mid-path", "src/../../etc/passwd"],
      ["a traversal that would land back inside", "src/../src/app.ts"],
      ["a deep traversal", "../../../../etc/passwd"],
      ["a backslash traversal", "..\\..\\Windows\\System32"],
      ["a posix absolute path", "/etc/passwd"],
      ["an absolute path to a plausible-looking file", "/work/other/app.ts"],
      ["an uppercase drive letter", "C:\\Windows\\System32\\config"],
      ["a lowercase drive letter", "c:/Windows"],
      ["a home-relative path", "~/.ssh/id_rsa"],
      ["a bare tilde", "~"],
    ];

    for (const [label, input] of refused) {
      it(`refuses ${label}: ${JSON.stringify(input)}`, () => {
        expect(resolveInside(root, input)).toBeUndefined();
      });
    }
  });
});

describe("relativeTo", () => {
  it("strips the workspace prefix", () => {
    const uri = vscode.Uri.file("/work/project/src/app.ts") as vscode.Uri;
    expect(relativeTo(root, uri)).toBe("src/app.ts");
  });

  it("handles a root that already ends in a separator", () => {
    const trailing = vscode.Uri.file("/work/project/") as vscode.Uri;
    const uri = vscode.Uri.file("/work/project/src/app.ts") as vscode.Uri;
    expect(relativeTo(trailing, uri)).toBe("src/app.ts");
  });

  it("returns the full path for something outside the workspace", () => {
    const outside = vscode.Uri.file("/etc/passwd") as vscode.Uri;
    expect(relativeTo(root, outside)).toBe("/etc/passwd");
  });

  it("does not mistake a sibling directory for a child", () => {
    const sibling = vscode.Uri.file("/work/project-other/src/app.ts") as vscode.Uri;
    expect(relativeTo(root, sibling)).toBe("/work/project-other/src/app.ts");
  });
});
