import * as vscode from "vscode";

/**
 * Turns a model-supplied path into a URI inside the workspace, or refuses.
 *
 * This is the only thing standing between text a language model wrote and the
 * file system, so it is deliberately strict: no `..` segments, no absolute
 * paths, no drive letters, no `~`, and a final check that the resolved URI
 * really does sit under the root. Anything it cannot vouch for comes back
 * undefined and the caller reports a refusal rather than guessing.
 *
 * Every read, every write and every patch goes through this one function. It
 * used to exist twice — once for the review tools and once for the fix
 * applier — which is one copy too many for a check whose failure mode is
 * writing outside the user's project.
 */
export function resolveInside(root: vscode.Uri, relPath: string): vscode.Uri | undefined {
  const cleaned = relPath.trim().replace(/^\.?\//, "");
  if (cleaned === "" || cleaned === ".") return root;
  if (/^([a-zA-Z]:|~)/.test(cleaned) || relPath.trim().startsWith("/")) return undefined;
  const segments = cleaned.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return undefined;
  const uri = vscode.Uri.joinPath(root, ...segments);
  return uri.path.startsWith(root.path) ? uri : undefined;
}

/** The workspace-relative form of a URI, for display and for citing evidence. */
export function relativeTo(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return uri.path.startsWith(rootPath) ? uri.path.slice(rootPath.length) : uri.path;
}
