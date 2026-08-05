/**
 * The module dependency graph.
 *
 * The index already records what every file imports. That is a list of strings;
 * this turns it into a graph — specifiers resolved to real files, files rolled up
 * into modules, cycles found, and layers assigned — which is what actually
 * answers the architectural questions: what depends on what, what is tangled,
 * and what sits at the bottom holding everything else up.
 *
 * Deliberately free of `vscode` imports: the webview renders this graph, and the
 * digest builder feeds it to the model, so it has to run in both places.
 */

import { RISK_SIGNALS, type SignalKind } from "./symbols";

/** The slice of a `FileRecord` the graph needs, so this module stays portable. */
export interface GraphFileInput {
  path: string;
  loc: number;
  language: string;
  imports: string[];
  signals: Array<{ kind: SignalKind }>;
}

export interface GraphNode {
  id: string;
  /** Short display name — the last path segment. */
  label: string;
  kind: "file" | "module";
  /** Files rolled into this node (1 when kind is "file"). */
  fileCount: number;
  loc: number;
  language: string;
  /** Distinct modules importing this one, and imported by it. */
  fanIn: number;
  fanOut: number;
  /**
   * Depth in the dependency stack. 0 is a module nothing else imports — an
   * entry point — and each step up is one hop further down into what the
   * project rests on, so the deepest layer holds its foundations.
   */
  layer: number;
  isEntry: boolean;
  /** Risk signals found beneath this node, worst kinds first. */
  risks: SignalKind[];
  /** External packages this module pulls in, most-used first. */
  externals: string[];
  /** Workspace-relative paths rolled into this node, for drill-down. */
  files: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  /** How many file-level imports this module-level edge stands for. */
  weight: number;
  /** True when both ends sit in the same dependency cycle. */
  cyclic: boolean;
}

export interface ModuleGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Concrete dependency cycles, tightest first: each is a ring of modules where
   * every step is a real import and the last one closes back to the first. A
   * two-element entry is a straight mutual dependency, which is the common case
   * and the one worth fixing.
   */
  cycles: string[][];
  /** How many nodes deep the dependency stack is. */
  depth: number;
  granularity: "file" | "module";
  /** Fraction of internal-looking imports that could not be resolved (0–1). */
  unresolved: number;
  /** Set when the graph was too large to draw and was capped. */
  omitted?: number;
}

/**
 * Above this, files roll up into directories.
 *
 * Deliberately low. A file-level graph of even a medium project is both
 * unreadable — forty boxes shrunk to fit are forty illegible boxes — and the
 * wrong question: "does the auth module depend on the database module" is an
 * architectural question, "does authManager.ts import secretStore.ts" is not.
 * Small projects still get file granularity, where it is the only thing there.
 */
const MAX_NODES = 24;

const SOURCE_EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "cs", "php", "swift", "scala",
  "vue", "svelte", "c", "h", "cpp", "cc", "hpp", "ex", "exs",
];

const INDEX_BASENAMES = ["index", "__init__", "mod", "main"];

/** Extensions a source file is imported *as*, even when it is not one on disk. */
const REWRITTEN_EXTENSIONS = /\.(js|jsx|mjs|cjs)$/;

export interface BuildGraphOptions {
  /** Files the scanner identified as entry points, for node badging. */
  entryPoints?: string[];
  maxNodes?: number;
}

export function buildModuleGraph(
  files: GraphFileInput[],
  options: BuildGraphOptions = {},
): ModuleGraph {
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const resolver = new ImportResolver(byPath);

  // 1. Resolve every import to a file in the workspace, or record it external.
  const fileEdges: Array<[string, string]> = [];
  const externalsByFile = new Map<string, string[]>();
  let internalAttempts = 0;
  let internalResolved = 0;

  for (const file of files) {
    const externals: string[] = [];
    for (const specifier of file.imports) {
      const kind = classifySpecifier(specifier);
      if (kind === "external") {
        externals.push(packageNameOf(specifier));
        continue;
      }
      const target = resolver.resolve(specifier, file.path);
      if (target && target !== file.path) {
        internalAttempts++;
        internalResolved++;
        fileEdges.push([file.path, target]);
        continue;
      }
      // `lodash/debounce` and `src/db` are the same shape, so a slash-bearing
      // specifier is only a guess at being internal. When nothing in the
      // workspace matches, the other reading is the right one: it is a package
      // subpath. Counting it as a failed internal import would both understate
      // the dependencies and make the graph look less certain than it is.
      if (kind === "rooted") {
        externals.push(packageNameOf(specifier));
        continue;
      }
      internalAttempts++;
    }
    if (externals.length > 0) externalsByFile.set(file.path, externals);
  }

  // 2. Roll files up until the picture is small enough to read.
  const grouping = chooseGrouping(files, maxNodes);
  const nodeOf = (path: string): string => grouping.assign(path);

  const nodes = new Map<string, GraphNode>();
  for (const file of files) {
    const id = nodeOf(file.path);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        // A module keeps its path — "src/engine" and "src/memory" both reduce
        // to nothing useful once the parent is dropped. Files keep just their
        // name, since the full path rarely fits and the tooltip carries it.
        label: labelFor(id, grouping.granularity),
        kind: grouping.granularity === "file" ? "file" : "module",
        fileCount: 0,
        loc: 0,
        language: file.language,
        fanIn: 0,
        fanOut: 0,
        layer: 0,
        isEntry: false,
        risks: [],
        externals: [],
        files: [],
      };
      nodes.set(id, node);
    }
    node.fileCount++;
    node.loc += file.loc;
    if (node.files.length < 40) node.files.push(file.path);
  }

  // 3. Aggregate the per-file facts onto their module.
  const riskTally = new Map<string, Map<SignalKind, number>>();
  const externalTally = new Map<string, Map<string, number>>();
  const languageTally = new Map<string, Map<string, number>>();

  for (const file of files) {
    const id = nodeOf(file.path);
    const risks = riskTally.get(id) ?? new Map<SignalKind, number>();
    for (const signal of file.signals) {
      if (!RISK_SIGNALS.includes(signal.kind)) continue;
      risks.set(signal.kind, (risks.get(signal.kind) ?? 0) + 1);
    }
    riskTally.set(id, risks);

    const externals = externalTally.get(id) ?? new Map<string, number>();
    for (const name of externalsByFile.get(file.path) ?? []) {
      externals.set(name, (externals.get(name) ?? 0) + 1);
    }
    externalTally.set(id, externals);

    const languages = languageTally.get(id) ?? new Map<string, number>();
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
    languageTally.set(id, languages);
  }

  for (const [id, node] of nodes) {
    node.risks = topKeys(riskTally.get(id)) as SignalKind[];
    node.externals = topKeys(externalTally.get(id)).slice(0, 6);
    node.language = topKeys(languageTally.get(id))[0] ?? node.language;
  }

  // A bare basename is only a useful label while it is unique. Two boxes both
  // reading "index.ts" are worse than no label at all, so collisions get their
  // parent directory back.
  const byLabel = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    const list = byLabel.get(node.label) ?? [];
    list.push(node);
    byLabel.set(node.label, list);
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    for (const node of group) {
      node.label = node.id.split("/").slice(-2).join("/");
    }
  }

  for (const entry of options.entryPoints ?? []) {
    const node = nodes.get(nodeOf(entry));
    if (node) node.isEntry = true;
  }

  // 4. Collapse file edges onto module edges, dropping self-references.
  const edgeWeights = new Map<string, number>();
  for (const [from, to] of fileEdges) {
    const a = nodeOf(from);
    const b = nodeOf(to);
    if (a === b || !nodes.has(a) || !nodes.has(b)) continue;
    const key = `${a}\0${b}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }

  let edges: GraphEdge[] = [...edgeWeights].map(([key, weight]) => {
    const [from, to] = key.split("\0");
    return { from, to, weight, cyclic: false };
  });

  // 5. Trim to the node cap by dropping the least-connected, smallest modules.
  let omitted: number | undefined;
  if (nodes.size > maxNodes) {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const ranked = [...nodes.values()].sort(
      (a, b) =>
        (degree.get(b.id) ?? 0) * 1000 + b.loc - ((degree.get(a.id) ?? 0) * 1000 + a.loc),
    );
    const keep = new Set(ranked.slice(0, maxNodes).map((n) => n.id));
    omitted = nodes.size - keep.size;
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from) from.fanOut++;
    if (to) to.fanIn++;
  }

  // 6. Find cycles, then layer the graph they leave behind.
  //
  // Two different questions, so two different answers. Layering needs the
  // strongly-connected components — every node in one has to collapse to a
  // single point or the condensation is not a DAG. The developer needs the
  // concrete cycles instead: "auth and llm import each other" is something you
  // can go and untangle, while the component holding them is usually most of
  // the codebase and reads as "everything is broken".
  const components = stronglyConnected(nodes, edges);
  const inComponent = new Map<string, number>();
  components.forEach((component, i) => {
    for (const id of component) inComponent.set(id, i);
  });

  const cycles = findSimpleCycles(components, edges);
  // Every edge inside a component is technically on *some* cycle, so marking
  // them all paints a well-layered project entirely red. Only the edges that
  // close a cycle we actually reported get drawn as one.
  // Keyed on NUL like the edge weights above: a module id is a path, and paths
  // can contain spaces, so any printable separator lets `a b`+`c` collide with
  // `a`+`b c` and mark an innocent edge as cyclic.
  const cyclicEdges = new Set<string>();
  for (const cycle of cycles) {
    cycle.forEach((from, i) => cyclicEdges.add(`${from}\0${cycle[(i + 1) % cycle.length]}`));
  }
  for (const edge of edges) {
    edge.cyclic = cyclicEdges.has(`${edge.from}\0${edge.to}`);
  }

  const layers = assignLayers(nodes, edges, inComponent);
  let depth = 0;
  for (const [id, layer] of layers) {
    const node = nodes.get(id);
    if (node) node.layer = layer;
    depth = Math.max(depth, layer + 1);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id)),
    edges,
    cycles,
    depth,
    granularity: grouping.granularity,
    unresolved:
      internalAttempts === 0 ? 0 : 1 - internalResolved / internalAttempts,
    omitted,
  };
}

// --- Import resolution -----------------------------------------------------

type SpecifierKind = "relative" | "rooted" | "dotted" | "external";

function classifySpecifier(specifier: string): SpecifierKind {
  const s = specifier.trim();
  if (s.startsWith("./") || s.startsWith("../") || s === "." || s === "..") return "relative";
  // A scheme means a runtime builtin or a remote module — `node:stream/web`,
  // `bun:test`, `jsr:@std/path`. The slash in it is not a path into the project,
  // so without this they read as unresolvable internal imports and drag the
  // confidence number down for every Node codebase.
  if (/^[a-z][a-z0-9+.-]*:/.test(s)) return "external";
  // A slash with no leading @ scope reads as a path into the project. Bare
  // package names never contain one; scoped packages always start with @.
  if (s.includes("/") && !s.startsWith("@")) return "rooted";
  // `a.b.c` is Python/Java package syntax. A single dotted pair is ambiguous
  // with a filename, so both readings get tried during resolution.
  if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(s)) return "dotted";
  return "external";
}

function packageNameOf(specifier: string): string {
  const s = specifier.trim().replace(/^node:/, "");
  if (s.startsWith("@")) return s.split("/").slice(0, 2).join("/");
  return s.split("/")[0].split(".")[0];
}

/**
 * Resolves an import specifier to a workspace file.
 *
 * There is no module resolver here on purpose: reading tsconfig paths, package
 * exports maps, and every language's search rules would be a project of its own,
 * and a graph does not need to be exact to be useful. What it needs is to be
 * right about the common shapes — relative paths, root-relative paths, and
 * dotted packages — and honest about the rest, which is what `unresolved` reports.
 */
class ImportResolver {
  /** Every path that could be the target of an extensionless specifier. */
  private readonly byStem = new Map<string, string[]>();

  constructor(private readonly byPath: Map<string, GraphFileInput>) {
    for (const path of byPath.keys()) {
      const withoutExt = stripExtension(path);
      push(this.byStem, withoutExt, path);
      const base = withoutExt.split("/").pop() ?? "";
      if (INDEX_BASENAMES.includes(base)) {
        // `foo/index.ts` is also reachable as `foo`.
        push(this.byStem, withoutExt.split("/").slice(0, -1).join("/"), path);
      }
    }
  }

  resolve(specifier: string, fromFile: string): string | undefined {
    const kind = classifySpecifier(specifier);
    const clean = specifier.trim().replace(/\\/g, "/");
    const fromDir = fromFile.includes("/")
      ? fromFile.slice(0, fromFile.lastIndexOf("/"))
      : "";

    if (kind === "relative") {
      return this.lookup(normalize(`${fromDir}/${clean}`));
    }
    if (kind === "rooted") {
      // Try it as written, then progressively drop leading segments: `src/db`
      // resolves in a repo rooted at `src`, and also in one where `src` is a
      // package directory reached through an alias.
      const parts = clean.replace(/^\/+/, "").split("/");
      for (let i = 0; i < Math.min(parts.length, 3); i++) {
        const hit = this.lookup(parts.slice(i).join("/"));
        if (hit) return hit;
      }
      return this.lookup(normalize(`${fromDir}/${clean}`));
    }
    if (kind === "dotted") {
      const asPath = clean.replace(/\./g, "/");
      return (
        this.lookup(asPath) ??
        this.lookup(normalize(`${fromDir}/${asPath}`)) ??
        // `from .models import X` arrives here with the leading dot stripped by
        // the import pattern, so a sibling lookup is the last thing worth trying.
        this.lookup(normalize(`${fromDir}/${clean.split(".").pop() ?? ""}`))
      );
    }
    return undefined;
  }

  private lookup(stem: string): string | undefined {
    if (!stem) return undefined;
    const direct = this.lookupExact(stem);
    if (direct) return direct;
    // A TypeScript file compiled for ESM must import the specifier the *runtime*
    // will see, so `./utils.js` is how you refer to `utils.ts`. Without this the
    // graph of a NodeNext project comes out completely empty — every import
    // unresolved, every node an orphan. Only JS extensions are retried, so a
    // stylesheet import cannot be mistaken for a module of the same name.
    if (REWRITTEN_EXTENSIONS.test(stem)) return this.lookupExact(stripExtension(stem));
    return undefined;
  }

  private lookupExact(stem: string): string | undefined {
    if (this.byPath.has(stem)) return stem;

    const exact = this.byStem.get(stem);
    if (exact && exact.length > 0) return pickBest(exact);

    for (const ext of SOURCE_EXTENSIONS) {
      if (this.byPath.has(`${stem}.${ext}`)) return `${stem}.${ext}`;
    }
    for (const base of INDEX_BASENAMES) {
      for (const ext of SOURCE_EXTENSIONS) {
        const candidate = `${stem}/${base}.${ext}`;
        if (this.byPath.has(candidate)) return candidate;
      }
    }
    return undefined;
  }
}

/** Prefers a real source file over a declaration or stylesheet of the same stem. */
function pickBest(candidates: string[]): string {
  const rank = (path: string): number => {
    if (path.endsWith(".d.ts")) return 3;
    const ext = path.split(".").pop() ?? "";
    return SOURCE_EXTENSIONS.includes(ext) ? 0 : 1;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
}

function stripExtension(path: string): string {
  // `foo.d.ts` is imported as `./foo`, so dropping one extension is not enough —
  // it would leave `foo.d` and never match.
  const declaration = /\.d\.[mc]?ts$/.exec(path);
  if (declaration) return path.slice(0, declaration.index);
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(0, dot) : path;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// --- Grouping --------------------------------------------------------------

interface Grouping {
  granularity: "file" | "module";
  assign(path: string): string;
}

/**
 * Picks the deepest directory level that still fits under the node cap.
 *
 * A graph of 800 files is not a graph, it is a texture. Rolling up to whole
 * directories keeps it legible, and going as deep as the cap allows keeps it
 * specific — `src/auth` says more than `src`.
 */
function chooseGrouping(files: GraphFileInput[], maxNodes: number): Grouping {
  if (files.length <= maxNodes) {
    return { granularity: "file", assign: (path) => path };
  }
  for (let depth = 6; depth >= 1; depth--) {
    const distinct = new Set(files.map((f) => directoryAt(f.path, depth)));
    if (distinct.size <= maxNodes) {
      return { granularity: "module", assign: (path) => directoryAt(path, depth) };
    }
  }
  return { granularity: "module", assign: (path) => directoryAt(path, 1) };
}

function labelFor(id: string, granularity: "file" | "module"): string {
  if (id === "" || id === ".") return "(root)";
  return granularity === "module" ? id : (id.split("/").pop() ?? id);
}

/** The first `depth` segments of a file's directory, or "." at the root. */
function directoryAt(path: string, depth: number): string {
  const parts = path.split("/");
  parts.pop();
  if (parts.length === 0) return ".";
  return parts.slice(0, depth).join("/");
}

function topKeys<K>(counts: Map<K, number> | undefined): K[] {
  if (!counts) return [];
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

// --- Cycles and layering ---------------------------------------------------

/** How many rings to report before the list stops being read. */
const MAX_CYCLES = 12;

/**
 * The shortest real cycle through each module, tightest first.
 *
 * A strongly-connected component answers "which modules can reach each other",
 * which is the right input for layering and the wrong thing to show a developer:
 * one shared helper at the bottom of a project is enough to swallow most of the
 * codebase into a single component, and "these 9 modules import each other" is
 * both alarming and unactionable. The shortest ring through a module is neither
 * — `auth → llm → auth` names two modules and one import to invert.
 *
 * Breadth-first from each member, so the first ring found through it is its
 * smallest. Bounded by the node cap, so the cost is trivial.
 */
function findSimpleCycles(components: string[][], edges: GraphEdge[]): string[][] {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    // A directory's loose files roll up into a node that sits beside its own
    // subdirectories, so `src` ends up holding both the entry point (which
    // imports everything) and the shared config (which everything imports).
    // That reads as `src ↔ src/auth` and it is not a cycle — it is one level of
    // the tree pointing at another. Real rings run between siblings.
    if (isNested(edge.from, edge.to)) continue;
    push(out, edge.from, edge.to);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();

  for (const component of components) {
    const members = new Set(component);
    for (const start of [...component].sort()) {
      const previous = new Map<string, string>();
      const visited = new Set<string>([start]);
      const queue: string[] = [start];
      let closing: string | undefined;

      while (queue.length > 0 && closing === undefined) {
        const current = queue.shift()!;
        for (const next of out.get(current) ?? []) {
          // Only inside this component: an edge leaving it can never come back.
          if (!members.has(next)) continue;
          if (next === start) {
            closing = current;
            break;
          }
          if (visited.has(next)) continue;
          visited.add(next);
          previous.set(next, current);
          queue.push(next);
        }
      }
      if (closing === undefined) continue;

      const ring: string[] = [];
      for (let at: string | undefined = closing; at !== undefined; at = previous.get(at)) {
        ring.push(at);
      }
      ring.reverse();

      const key = canonicalRing(ring);
      if (seen.has(key)) continue;
      seen.add(key);
      cycles.push(ring);
    }
  }

  return cycles
    .sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()))
    .slice(0, MAX_CYCLES);
}

/** True when one node contains the other, e.g. `src` and `src/auth`. */
function isNested(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Rotation-independent identity, so one ring is not reported once per member. */
function canonicalRing(ring: string[]): string {
  let pivot = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i] < ring[pivot]) pivot = i;
  return [...ring.slice(pivot), ...ring.slice(0, pivot)].join("\0");
}

/**
 * Tarjan's strongly-connected components, iterative so a deep graph cannot blow
 * the stack. Every component of size > 1 is a set of modules that can all reach
 * each other, which is what has to collapse to a point before the graph can be
 * layered.
 */
function stronglyConnected(nodes: Map<string, GraphNode>, edges: GraphEdge[]): string[][] {
  const out = new Map<string, string[]>();
  for (const id of nodes.keys()) out.set(id, []);
  for (const edge of edges) out.get(edge.from)?.push(edge.to);

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of nodes.keys()) {
    if (index.has(root)) continue;
    // Each frame tracks how far through its successor list it has walked.
    const work: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const successors = out.get(frame.id) ?? [];

      if (frame.next < successors.length) {
        const next = successors[frame.next++];
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(next)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.id) break;
        }
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components;
}

/**
 * Longest-path layering over the cycle-condensed graph.
 *
 * Layer 0 holds the modules nothing imports — entry points and dead code — and
 * each successive layer is one hop deeper into what they rest on, so the last
 * layer is the project's foundation. Drawing by layer turns a hairball into a
 * stack that can be read in one direction, and a module sitting much deeper
 * than its neighbours is usually the one everything has quietly come to depend
 * on.
 */
function assignLayers(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  inCycle: Map<string, number>,
): Map<string, number> {
  // Every node in a cycle shares one representative, so the condensation is a DAG.
  const rep = (id: string): string => {
    const cycle = inCycle.get(id);
    return cycle === undefined ? id : `\0cycle-${cycle}`;
  };

  const successors = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) {
    const r = rep(id);
    if (!successors.has(r)) successors.set(r, new Set());
    if (!inDegree.has(r)) inDegree.set(r, 0);
  }
  for (const edge of edges) {
    const a = rep(edge.from);
    const b = rep(edge.to);
    if (a === b) continue;
    const set = successors.get(a)!;
    if (!set.has(b)) {
      set.add(b);
      inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
    }
  }

  // A dependency edge points at what a module rests on, so depth flows the other
  // way: process dependencies first, then whatever sits on top of them.
  const layerOf = new Map<string, number>();
  const queue = [...inDegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  for (const id of queue) layerOf.set(id, 0);

  const remaining = new Map(inDegree);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of successors.get(current) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) {
        queue.push(next);
        layerOf.set(next, 0);
      }
    }
  }

  // Relax to longest path: a node sits one above its deepest dependency.
  // The condensation is acyclic, so |V| passes always converge.
  const reversed = new Map<string, string[]>();
  for (const [from, set] of successors) {
    for (const to of set) push(reversed, to, from);
  }
  const order = [...successors.keys()];
  for (let pass = 0; pass < order.length; pass++) {
    let changed = false;
    for (const id of order) {
      let best = 0;
      for (const dep of reversed.get(id) ?? []) {
        best = Math.max(best, (layerOf.get(dep) ?? 0) + 1);
      }
      if (best !== (layerOf.get(id) ?? 0)) {
        layerOf.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const result = new Map<string, number>();
  for (const id of nodes.keys()) result.set(id, layerOf.get(rep(id)) ?? 0);
  return result;
}

// --- Summaries -------------------------------------------------------------

/**
 * The graph as prose, for the model's brief. Cycles and hubs are the two things
 * a reader cannot see from a file listing but that decide how a codebase ages.
 */
/** A mutual pair reads as one relationship; anything longer reads as a loop. */
export function formatRing(cycle: string[]): string {
  return cycle.length === 2
    ? cycle.join(" ↔ ")
    : `${cycle.join(" → ")} → ${cycle[0]}`;
}

export function describeGraph(graph: ModuleGraph): string[] {
  if (graph.nodes.length === 0) return [];
  const lines: string[] = ["## Module dependency graph"];
  lines.push(
    `${graph.nodes.length} ${graph.granularity === "file" ? "files" : "modules"}, ` +
      `${graph.edges.length} dependency edges, ${graph.depth} layer(s) deep. ` +
      `Resolved from import statements${
        graph.unresolved > 0.25
          ? `; ${Math.round(graph.unresolved * 100)}% of internal imports could not be resolved, so this is partial`
          : ""
      }.`,
  );

  if (graph.cycles.length > 0) {
    lines.push("");
    lines.push(
      "**Circular dependencies** — each ring closes back on itself, so none of its modules can be changed, tested, or extracted alone:",
    );
    for (const cycle of graph.cycles.slice(0, 6)) {
      lines.push(`- ${formatRing(cycle)}`);
    }
  }

  const hubs = [...graph.nodes]
    .filter((n) => n.fanIn + n.fanOut > 0)
    .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))
    .slice(0, 8);
  if (hubs.length > 0) {
    lines.push("");
    lines.push("**Most connected modules** — a change here ripples furthest:");
    for (const hub of hubs) {
      lines.push(
        `- ${hub.id} — ${hub.fanIn} module(s) depend on it, it depends on ${hub.fanOut}; ` +
          `${hub.loc.toLocaleString()} lines, layer ${hub.layer}`,
      );
    }
  }

  const orphans = graph.nodes.filter((n) => n.fanIn === 0 && n.fanOut === 0);
  if (orphans.length > 0 && orphans.length < graph.nodes.length) {
    lines.push("");
    lines.push(
      `Unconnected: ${orphans
        .slice(0, 10)
        .map((n) => n.id)
        .join(", ")}${orphans.length > 10 ? `, +${orphans.length - 10} more` : ""}.`,
    );
  }
  return lines;
}
