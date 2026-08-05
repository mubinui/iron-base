import { describe, expect, it } from "vitest";
import { buildModuleGraph, describeGraph, formatRing, type GraphFileInput } from "./graph";

/** A file with no signals, since only paths and imports matter to the graph. */
function file(path: string, imports: string[] = [], loc = 10): GraphFileInput {
  return { path, loc, language: path.split(".").pop() ?? "ts", imports, signals: [] };
}

const edgeSet = (graph: ReturnType<typeof buildModuleGraph>): string[] =>
  graph.edges.map((e) => `${e.from}->${e.to}`).sort();

describe("import resolution", () => {
  it("resolves relative specifiers, with and without extensions", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b", "./sub/c.ts"]),
      file("src/b.ts"),
      file("src/sub/c.ts"),
    ]);
    expect(edgeSet(graph)).toEqual(["src/a.ts->src/b.ts", "src/a.ts->src/sub/c.ts"]);
    expect(graph.unresolved).toBe(0);
  });

  it("resolves a directory import through its index file", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./thing"]),
      file("src/thing/index.ts"),
    ]);
    expect(edgeSet(graph)).toEqual(["src/a.ts->src/thing/index.ts"]);
  });

  // The NodeNext convention: TypeScript sources import the path the *runtime*
  // will see, so `./utils.js` on disk is `utils.ts`. Getting this wrong empties
  // the graph of every ESM TypeScript project.
  it("resolves a .js specifier to its TypeScript source", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./utils.js", "./deep/mod.mjs"]),
      file("src/utils.ts"),
      file("src/deep/mod.ts"),
    ]);
    expect(edgeSet(graph)).toEqual(["src/a.ts->src/deep/mod.ts", "src/a.ts->src/utils.ts"]);
    expect(graph.unresolved).toBe(0);
  });

  it("resolves a specifier pointing at a declaration file", () => {
    const graph = buildModuleGraph([
      file("types/index.ts", ["./dispatcher"]),
      file("types/dispatcher.d.ts"),
    ]);
    expect(edgeSet(graph)).toEqual(["types/index.ts->types/dispatcher.d.ts"]);
  });

  it("prefers a real source file over a declaration of the same name", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./thing"]),
      file("src/thing.d.ts"),
      file("src/thing.ts"),
    ]);
    expect(edgeSet(graph)).toEqual(["src/a.ts->src/thing.ts"]);
  });

  it("treats scheme-prefixed builtins as external, not as project paths", () => {
    const graph = buildModuleGraph([file("src/a.ts", ["node:stream/web", "node:util/types"])]);
    expect(graph.edges).toEqual([]);
    // The give-away for the old bug: these counted as failed internal imports.
    expect(graph.unresolved).toBe(0);
    expect(graph.nodes[0].externals).toContain("stream");
  });

  it("treats an unresolvable package subpath as external", () => {
    const graph = buildModuleGraph([file("src/a.ts", ["lodash/debounce"])]);
    expect(graph.unresolved).toBe(0);
    expect(graph.nodes[0].externals).toEqual(["lodash"]);
  });

  it("reports genuinely unresolvable relative imports", () => {
    const graph = buildModuleGraph([file("src/a.ts", ["./nowhere"])]);
    expect(graph.unresolved).toBe(1);
  });

  it("ignores a file importing itself", () => {
    const graph = buildModuleGraph([file("src/a.ts", ["./a"])]);
    expect(graph.edges).toEqual([]);
  });
});

describe("cycles", () => {
  it("finds a mutual dependency as a two-module ring", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b"]),
      file("src/b.ts", ["./a"]),
    ]);
    expect(graph.cycles).toHaveLength(1);
    expect([...graph.cycles[0]].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports nothing for a layered graph", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b"]),
      file("src/b.ts", ["./c"]),
      file("src/c.ts"),
    ]);
    expect(graph.cycles).toEqual([]);
    expect(graph.edges.every((e) => !e.cyclic)).toBe(true);
  });

  /**
   * The failure that made the map unreadable: one shared helper pulls most of
   * the codebase into a single strongly-connected component, and reporting that
   * component says "these nine modules import each other" — true of the
   * component, useless to the developer, and it painted every edge red.
   */
  it("reports the tight rings, not the whole component they sit in", () => {
    const graph = buildModuleGraph([
      file("pkg/a/one.ts", ["../b/one", "../shared/util"]),
      file("pkg/b/one.ts", ["../a/one", "../shared/util"]),
      file("pkg/c/one.ts", ["../d/one", "../shared/util"]),
      file("pkg/d/one.ts", ["../c/one", "../shared/util"]),
      file("pkg/shared/util.ts", ["../a/one"]),
    ]);
    // Every ring reported is a real one: each step is an edge in the graph.
    for (const ring of graph.cycles) {
      expect(ring.length).toBeGreaterThan(1);
      for (const [i, from] of ring.entries()) {
        const to = ring[(i + 1) % ring.length];
        expect(edgeSet(graph)).toContain(`${from}->${to}`);
      }
    }
    // The two genuine mutual pairs are both named.
    const pairs = graph.cycles.filter((c) => c.length === 2).map((c) => [...c].sort().join("+"));
    expect(pairs).toContain("pkg/a/one.ts+pkg/b/one.ts");
    expect(pairs).toContain("pkg/c/one.ts+pkg/d/one.ts");
  });

  it("does not call a parent/child directory pair a cycle", () => {
    // `src` holds the entry point and the shared config; `src/auth` is its own
    // module. The entry importing auth and auth importing config is normal
    // layering, but rolled up it looks like `src ↔ src/auth`.
    const files: GraphFileInput[] = [
      file("src/extension.ts", ["./auth/manager"]),
      file("src/config.ts"),
      file("src/auth/manager.ts", ["../config"]),
    ];
    // Force the directory rollup that creates the artifact.
    const graph = buildModuleGraph(files, { maxNodes: 2 });
    expect(graph.granularity).toBe("module");
    expect(graph.cycles).toEqual([]);
  });

  it("marks only the edges that close a reported ring", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b"]),
      file("src/b.ts", ["./a", "./c"]),
      file("src/c.ts"),
    ]);
    const cyclic = graph.edges.filter((e) => e.cyclic).map((e) => `${e.from}->${e.to}`).sort();
    expect(cyclic).toEqual(["src/a.ts->src/b.ts", "src/b.ts->src/a.ts"]);
  });
});

describe("layering", () => {
  it("puts what nothing imports first and the foundation last", () => {
    const graph = buildModuleGraph([
      file("src/entry.ts", ["./mid"]),
      file("src/mid.ts", ["./base"]),
      file("src/base.ts"),
    ]);
    const layerOf = Object.fromEntries(graph.nodes.map((n) => [n.id, n.layer]));
    expect(layerOf["src/entry.ts"]).toBe(0);
    expect(layerOf["src/mid.ts"]).toBe(1);
    expect(layerOf["src/base.ts"]).toBe(2);
    expect(graph.depth).toBe(3);
  });

  it("counts how many modules depend on a shared module", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./shared"]),
      file("src/b.ts", ["./shared"]),
      file("src/shared.ts"),
    ]);
    const shared = graph.nodes.find((n) => n.id === "src/shared.ts")!;
    expect(shared.fanIn).toBe(2);
    expect(shared.fanOut).toBe(0);
  });

  it("keeps every node in one layer even when a cycle spans them", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b"]),
      file("src/b.ts", ["./a"]),
      file("src/c.ts", ["./a"]),
    ]);
    expect(graph.nodes.every((n) => Number.isInteger(n.layer) && n.layer >= 0)).toBe(true);
  });
});

describe("rollup", () => {
  it("groups files into directories once past the node cap", () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`src/mod${i % 2}/f${i}.ts`));
    const graph = buildModuleGraph(files, { maxNodes: 4 });
    expect(graph.granularity).toBe("module");
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["src/mod0", "src/mod1"]);
    expect(graph.nodes.every((n) => n.fileCount === 5)).toBe(true);
  });

  it("stays at file granularity for a small project", () => {
    const graph = buildModuleGraph([file("a.ts"), file("b.ts")]);
    expect(graph.granularity).toBe("file");
  });

  it("caps the node count and says how many it dropped", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`d${i}/f.ts`, [], i));
    const graph = buildModuleGraph(files, { maxNodes: 5 });
    expect(graph.nodes.length).toBeLessThanOrEqual(5);
    expect(graph.omitted).toBe(25);
  });
});

describe("presentation", () => {
  it("writes a mutual pair as a two-way arrow and a longer ring as a loop", () => {
    expect(formatRing(["a", "b"])).toBe("a ↔ b");
    expect(formatRing(["a", "b", "c"])).toBe("a → b → c → a");
  });

  it("handles an empty project without throwing", () => {
    const graph = buildModuleGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.unresolved).toBe(0);
    expect(describeGraph(graph)).toEqual([]);
  });

  it("names the cycles in the brief given to the model", () => {
    const graph = buildModuleGraph([
      file("src/a.ts", ["./b"]),
      file("src/b.ts", ["./a"]),
    ]);
    expect(describeGraph(graph).join("\n")).toContain("src/a.ts ↔ src/b.ts");
  });
});
