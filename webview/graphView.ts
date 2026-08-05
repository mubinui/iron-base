/**
 * The architecture map.
 *
 * A layered node-link diagram rather than a force-directed blob. Force layouts
 * look impressive and say nothing: node position carries no meaning, and the
 * picture is different every time you open it. Here the x axis *is* the
 * dependency depth — layer 0 on the left depends on nothing internal, each
 * column to the right sits on top of the one before — so "what rests on what"
 * is readable at a glance and stable between runs.
 *
 * Everything is hand-rolled SVG: the webview CSP blocks external scripts, and a
 * graph library would be an order of magnitude more bytes than the layout it
 * replaces.
 */

import type { GraphEdge, GraphNode, ModuleGraph } from "../src/memory/graph";
import type { Finding, Severity } from "../src/engine/findings";
import { SEVERITY_ORDER } from "../src/engine/findings";
import { icon } from "./icons";

const NS = "http://www.w3.org/2000/svg";

const NODE_W = 168;
const NODE_H = 46;
const COL_GAP = 92;
const ROW_GAP = 18;
const PADDING = 28;

export interface GraphViewCallbacks {
  onSelect(node: GraphNode | undefined): void;
  onOpenFile(file: string, line?: number): void;
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  /** Worst severity of any finding landing on this node, or undefined. */
  severity?: Severity;
  findings: Finding[];
}

export class GraphView {
  private readonly placed = new Map<string, Placed>();
  private readonly host: HTMLElement;
  private svg!: SVGSVGElement;
  private viewport!: SVGGElement;
  private selected: string | undefined;

  /** Current pan/zoom, applied as a transform on the viewport group. */
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private width = 0;
  private height = 0;

  constructor(
    private readonly graph: ModuleGraph,
    private readonly findings: Finding[],
    private readonly callbacks: GraphViewCallbacks,
  ) {
    this.host = document.createElement("div");
    this.host.className = "graph-host";
    this.layout();
    this.build();
  }

  get element(): HTMLElement {
    return this.host;
  }

  /**
   * Assigns coordinates: one column per dependency layer, nodes ordered inside
   * a column by the average position of what they connect to. Two barycentre
   * sweeps is enough to pull most edges straight — a full crossing-minimisation
   * pass costs far more than it buys at this graph size.
   */
  private layout(): void {
    const byLayer = new Map<number, GraphNode[]>();
    for (const node of this.graph.nodes) {
      const list = byLayer.get(node.layer) ?? [];
      list.push(node);
      byLayer.set(node.layer, list);
    }

    // Layer numbers can be sparse — nothing guarantees every depth is occupied —
    // so columns are indexed by position in the sorted list, not by layer value.
    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    const column = new Map<number, number>();
    layers.forEach((layer, i) => column.set(layer, i));

    const order = new Map<string, number>();
    for (const layer of layers) {
      const nodes = byLayer.get(layer)!;
      nodes.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || a.id.localeCompare(b.id));
      nodes.forEach((node, i) => order.set(node.id, i));
    }

    const neighbours = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      const list = neighbours.get(a);
      if (list) list.push(b);
      else neighbours.set(a, [b]);
    };
    for (const edge of this.graph.edges) {
      link(edge.from, edge.to);
      link(edge.to, edge.from);
    }

    for (let sweep = 0; sweep < 2; sweep++) {
      for (const layer of layers) {
        const nodes = byLayer.get(layer)!;
        const score = new Map<string, number>();
        for (const node of nodes) {
          const linked = neighbours.get(node.id) ?? [];
          const positions = linked
            .map((id) => order.get(id))
            .filter((v): v is number => v !== undefined);
          score.set(
            node.id,
            positions.length > 0
              ? positions.reduce((a, b) => a + b, 0) / positions.length
              : (order.get(node.id) ?? 0),
          );
        }
        nodes.sort((a, b) => score.get(a.id)! - score.get(b.id)!);
        nodes.forEach((node, i) => order.set(node.id, i));
      }
    }

    const tallest = Math.max(...layers.map((l) => byLayer.get(l)!.length), 1);
    const contentHeight = tallest * NODE_H + (tallest - 1) * ROW_GAP;

    const findingsByNode = this.mapFindings();

    for (const layer of layers) {
      const nodes = byLayer.get(layer)!;
      const columnHeight = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
      const top = PADDING + (contentHeight - columnHeight) / 2;
      nodes.forEach((node, i) => {
        const attached = findingsByNode.get(node.id) ?? [];
        this.placed.set(node.id, {
          node,
          x: PADDING + column.get(layer)! * (NODE_W + COL_GAP),
          y: top + i * (NODE_H + ROW_GAP),
          severity: worstOf(attached),
          findings: attached,
        });
      });
    }

    this.width = PADDING * 2 + layers.length * NODE_W + (layers.length - 1) * COL_GAP;
    this.height = PADDING * 2 + contentHeight;
  }

  /** Attaches each finding to the node owning the file its evidence points at. */
  private mapFindings(): Map<string, Finding[]> {
    const owners = [...this.graph.nodes]
      .map((n) => n.id)
      .sort((a, b) => b.length - a.length);
    const result = new Map<string, Finding[]>();

    for (const finding of this.findings) {
      const hit = new Set<string>();
      for (const evidence of finding.evidence) {
        const owner = owners.find(
          (id) => evidence.file === id || evidence.file.startsWith(`${id}/`),
        );
        if (owner) hit.add(owner);
      }
      for (const id of hit) {
        const list = result.get(id) ?? [];
        list.push(finding);
        result.set(id, list);
      }
    }
    return result;
  }

  private build(): void {
    this.host.append(this.toolbar());

    const frame = document.createElement("div");
    frame.className = "graph-frame";

    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "graph-svg");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute(
      "aria-label",
      `Module dependency graph: ${this.graph.nodes.length} nodes, ${this.graph.edges.length} dependencies`,
    );
    this.svg.append(arrowDefs());

    this.viewport = document.createElementNS(NS, "g");
    this.svg.append(this.viewport);

    const edgeLayer = document.createElementNS(NS, "g");
    edgeLayer.setAttribute("class", "edges");
    const nodeLayer = document.createElementNS(NS, "g");

    for (const edge of this.graph.edges) this.drawEdge(edge, edgeLayer);
    for (const placed of this.placed.values()) this.drawNode(placed, nodeLayer);

    this.viewport.append(edgeLayer, nodeLayer);
    frame.append(this.svg);
    this.host.append(frame);
    this.host.append(this.legend());

    this.attachPanZoom(frame);
    // Deselect when the background is clicked, but not when a node is.
    this.svg.addEventListener("click", (event) => {
      if (event.target === this.svg || (event.target as Element).classList.contains("edge")) {
        this.select(undefined);
      }
    });

    requestAnimationFrame(() => this.fit());
  }

  private toolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "graph-toolbar";

    const summary = document.createElement("p");
    summary.className = "graph-summary";
    const unit = this.graph.granularity === "file" ? "file" : "module";
    summary.textContent =
      `${this.graph.nodes.length} ${unit}${this.graph.nodes.length === 1 ? "" : "s"}, ` +
      `${this.graph.edges.length} dependenc${this.graph.edges.length === 1 ? "y" : "ies"}, ` +
      `${this.graph.depth} layer${this.graph.depth === 1 ? "" : "s"} deep`;
    bar.append(summary);

    if (this.graph.cycles.length > 0) {
      const badge = document.createElement("button");
      badge.className = "graph-badge danger";
      badge.append(
        icon("cycle", 13),
        text(
          "span",
          `${this.graph.cycles.length} circular ${this.graph.cycles.length === 1 ? "dependency" : "dependencies"}`,
        ),
      );
      badge.title = this.graph.cycles
        .map((cycle) => cycle.join(" → "))
        .join("\n");
      badge.addEventListener("click", () => this.focusCycle());
      bar.append(badge);
    }

    const controls = document.createElement("div");
    controls.className = "graph-controls";
    controls.append(
      iconButton("zoomOut", "Zoom out", () => this.zoomBy(1 / 1.25)),
      iconButton("zoomIn", "Zoom in", () => this.zoomBy(1.25)),
      iconButton("fit", "Fit to view", () => this.fit()),
    );
    bar.append(controls);
    return bar;
  }

  private legend(): HTMLElement {
    const legend = document.createElement("div");
    legend.className = "graph-legend";

    const note = this.graph.granularity === "file" ? "Each box is a file." : "Each box is a directory.";
    legend.append(
      text(
        "span",
        `${note} Arrows point from a module to what it depends on; depth increases left to right.`,
        "legend-note",
      ),
    );

    const keys = document.createElement("div");
    keys.className = "legend-keys";
    for (const severity of ["critical", "high", "medium", "low"] as Severity[]) {
      const key = document.createElement("span");
      key.className = "legend-key";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = `var(--sev-${severity})`;
      key.append(swatch, text("span", severity));
      keys.append(key);
    }
    const clean = document.createElement("span");
    clean.className = "legend-key";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch neutral";
    clean.append(swatch, text("span", "no findings"));
    keys.append(clean);
    legend.append(keys);

    if (this.graph.unresolved > 0.25) {
      legend.append(
        text(
          "p",
          `About ${Math.round(this.graph.unresolved * 100)}% of imports could not be traced to a file in this workspace — usually path aliases or generated code — so some edges are missing.`,
          "legend-caveat",
        ),
      );
    }
    if (this.graph.omitted) {
      legend.append(
        text(
          "p",
          `${this.graph.omitted} less-connected module${this.graph.omitted === 1 ? " is" : "s are"} hidden to keep the map readable.`,
          "legend-caveat",
        ),
      );
    }
    return legend;
  }

  private drawEdge(edge: GraphEdge, parent: SVGGElement): void {
    const from = this.placed.get(edge.from);
    const to = this.placed.get(edge.to);
    if (!from || !to) return;

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", edgePath(from, to));
    path.setAttribute("class", `edge${edge.cyclic ? " cyclic" : ""}`);
    path.setAttribute("data-from", edge.from);
    path.setAttribute("data-to", edge.to);
    path.setAttribute("stroke-width", String(Math.min(1 + Math.log2(edge.weight + 1) * 0.6, 3)));
    path.setAttribute("marker-end", edge.cyclic ? "url(#arrow-cyclic)" : "url(#arrow)");
    parent.append(path);
  }

  private drawNode(placed: Placed, parent: SVGGElement): void {
    const { node } = placed;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", "node");
    group.setAttribute("data-id", node.id);
    group.setAttribute("transform", `translate(${placed.x}, ${placed.y})`);
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");

    const box = document.createElementNS(NS, "rect");
    box.setAttribute("class", "node-box");
    box.setAttribute("width", String(NODE_W));
    box.setAttribute("height", String(NODE_H));
    box.setAttribute("rx", "9");
    group.append(box);

    // A severity stripe down the leading edge: colour without tinting the label.
    const stripe = document.createElementNS(NS, "rect");
    stripe.setAttribute("class", "node-stripe");
    stripe.setAttribute("width", "4");
    stripe.setAttribute("height", String(NODE_H - 14));
    stripe.setAttribute("y", "7");
    stripe.setAttribute("x", "0");
    stripe.setAttribute("rx", "2");
    stripe.setAttribute(
      "fill",
      placed.severity ? `var(--sev-${placed.severity})` : "var(--node-quiet)",
    );
    group.append(stripe);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "node-label");
    label.setAttribute("x", "14");
    label.setAttribute("y", "19");
    label.textContent = ellipsize(node.label, 20);
    group.append(label);

    const meta = document.createElementNS(NS, "text");
    meta.setAttribute("class", "node-meta");
    meta.setAttribute("x", "14");
    meta.setAttribute("y", "34");
    meta.textContent =
      node.kind === "file"
        ? `${node.loc.toLocaleString()} lines`
        : `${node.fileCount} file${node.fileCount === 1 ? "" : "s"} · ${node.loc.toLocaleString()} lines`;
    group.append(meta);

    if (placed.findings.length > 0) {
      const badge = document.createElementNS(NS, "g");
      badge.setAttribute("class", "node-badge");
      const bubble = document.createElementNS(NS, "circle");
      bubble.setAttribute("cx", String(NODE_W - 17));
      bubble.setAttribute("cy", "16");
      bubble.setAttribute("r", "9");
      bubble.setAttribute("fill", `var(--sev-${placed.severity ?? "low"})`);
      const count = document.createElementNS(NS, "text");
      count.setAttribute("class", "badge-text");
      count.setAttribute("x", String(NODE_W - 17));
      count.setAttribute("y", "19.5");
      count.setAttribute("text-anchor", "middle");
      count.textContent = String(placed.findings.length);
      badge.append(bubble, count);
      group.append(badge);
    }

    if (node.isEntry) {
      const entry = document.createElementNS(NS, "text");
      entry.setAttribute("class", "node-entry");
      entry.setAttribute("x", String(NODE_W - 12));
      entry.setAttribute("y", String(NODE_H - 9));
      entry.setAttribute("text-anchor", "end");
      entry.textContent = "entry";
      group.append(entry);
    }

    const title = document.createElementNS(NS, "title");
    title.textContent = [
      node.id,
      `${node.fanIn} module(s) depend on this; it depends on ${node.fanOut}`,
      `layer ${node.layer}${node.risks.length > 0 ? ` · risk signals: ${node.risks.join(", ")}` : ""}`,
      placed.findings.length > 0 ? `${placed.findings.length} finding(s)` : "no findings",
    ].join("\n");
    group.append(title);

    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.select(this.selected === node.id ? undefined : node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.select(this.selected === node.id ? undefined : node.id);
      }
    });
    group.addEventListener("mouseenter", () => this.highlight(node.id));
    group.addEventListener("mouseleave", () => this.highlight(this.selected));
    parent.append(group);
  }

  /**
   * Dims everything not touching `id`. Reading one module's dependencies out of
   * a dense picture is otherwise guesswork, and hover is cheaper than clicking.
   */
  private highlight(id: string | undefined): void {
    const related = new Set<string>();
    if (id) {
      related.add(id);
      for (const edge of this.graph.edges) {
        if (edge.from === id) related.add(edge.to);
        if (edge.to === id) related.add(edge.from);
      }
    }
    this.viewport.classList.toggle("focused", id !== undefined);

    for (const group of this.svg.querySelectorAll<SVGGElement>("g.node")) {
      const nodeId = group.getAttribute("data-id")!;
      group.classList.toggle("dim", id !== undefined && !related.has(nodeId));
      group.classList.toggle("active", nodeId === id);
    }
    for (const edge of this.svg.querySelectorAll<SVGPathElement>("path.edge")) {
      const touches =
        id !== undefined &&
        (edge.getAttribute("data-from") === id || edge.getAttribute("data-to") === id);
      edge.classList.toggle("dim", id !== undefined && !touches);
      edge.classList.toggle("lit", touches);
    }
  }

  private select(id: string | undefined): void {
    this.selected = id;
    this.highlight(id);
    const placed = id ? this.placed.get(id) : undefined;
    this.callbacks.onSelect(placed?.node);
  }

  /** Pans to the largest cycle and selects one of its members. */
  private focusCycle(): void {
    const cycle = this.graph.cycles[0];
    if (!cycle || cycle.length === 0) return;
    const placed = this.placed.get(cycle[0]);
    if (!placed) return;
    const frame = this.svg.getBoundingClientRect();
    this.scale = Math.min(1.2, this.scale);
    this.tx = frame.width / 2 - (placed.x + NODE_W / 2) * this.scale;
    this.ty = frame.height / 2 - (placed.y + NODE_H / 2) * this.scale;
    this.applyTransform();
    this.select(cycle[0]);
  }

  /** Findings attached to a node, for the detail panel next to the graph. */
  findingsOn(id: string): Finding[] {
    return this.placed.get(id)?.findings ?? [];
  }

  // --- Pan and zoom --------------------------------------------------------

  private attachPanZoom(frame: HTMLElement): void {
    // Pointer capture is taken only once the pointer has actually moved.
    // Capturing on pointerdown retargets the click that follows to the frame,
    // which silently breaks selecting a node — the drag would eat every click.
    const DRAG_THRESHOLD = 4;
    let pressed = false;
    let dragging = false;
    let originX = 0;
    let originY = 0;
    let startX = 0;
    let startY = 0;

    frame.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pressed = true;
      dragging = false;
      originX = event.clientX;
      originY = event.clientY;
      startX = event.clientX - this.tx;
      startY = event.clientY - this.ty;
    });
    frame.addEventListener("pointermove", (event) => {
      if (!pressed) return;
      if (!dragging) {
        const moved = Math.hypot(event.clientX - originX, event.clientY - originY);
        if (moved < DRAG_THRESHOLD) return;
        dragging = true;
        frame.classList.add("dragging");
        frame.setPointerCapture(event.pointerId);
      }
      this.tx = event.clientX - startX;
      this.ty = event.clientY - startY;
      this.applyTransform();
    });
    const stop = (event: PointerEvent): void => {
      pressed = false;
      dragging = false;
      frame.classList.remove("dragging");
      if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    };
    frame.addEventListener("pointerup", stop);
    frame.addEventListener("pointercancel", stop);

    frame.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = frame.getBoundingClientRect();
        // Zoom toward the cursor rather than the origin, so the thing under the
        // pointer stays under the pointer.
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAt(px, py, factor);
      },
      { passive: false },
    );
  }

  private zoomBy(factor: number): void {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const next = clamp(this.scale * factor, 0.25, 2.5);
    const applied = next / this.scale;
    this.tx = px - (px - this.tx) * applied;
    this.ty = py - (py - this.ty) * applied;
    this.scale = next;
    this.applyTransform();
  }

  /**
   * Sizes the frame to the graph rather than the other way round.
   *
   * A dependency graph is almost always much wider than it is tall — ten layers
   * of four modules, not four layers of ten — so a fixed-height frame leaves a
   * band of empty grid above and below and makes the whole thing read as tiny.
   * Fitting to width first and then shrinking the frame to whatever height that
   * needs keeps the nodes as large as they can be.
   */
  fit(): void {
    const frame = this.svg.parentElement;
    if (!frame) return;
    const available = frame.clientWidth;
    if (available === 0) return;

    // Never shrink past the point where the labels stop being readable; a very
    // wide graph is better panned than squinted at.
    this.scale = clamp(available / this.width, 0.55, 1.15);
    const wanted = clamp(this.height * this.scale + 8, 260, 640);
    frame.style.height = `${Math.round(wanted)}px`;

    this.tx = (available - this.width * this.scale) / 2;
    this.ty = (wanted - this.height * this.scale) / 2;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.tx.toFixed(2)}, ${this.ty.toFixed(2)}) scale(${this.scale.toFixed(3)})`,
    );
  }
}

/**
 * A cubic curve leaving the source's right edge and arriving at the target's
 * left. Cycle edges run backwards, so they bow outward above the nodes instead
 * of cutting straight through them.
 */
function edgePath(from: Placed, to: Placed): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  if (x2 >= x1) {
    const dx = Math.max(36, (x2 - x1) * 0.5);
    return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  // Backwards edge: arc over the top so it stays legible.
  const lift = Math.min(from.y, to.y) - 34;
  const midX = (x1 + x2) / 2;
  return `M${from.x} ${y1} C${from.x - 50} ${y1}, ${midX} ${lift}, ${to.x + NODE_W / 2} ${to.y - 6}`;
}

function arrowDefs(): SVGDefsElement {
  const defs = document.createElementNS(NS, "defs");
  for (const [id, className] of [
    ["arrow", "arrow-head"],
    ["arrow-cyclic", "arrow-head cyclic"],
  ]) {
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M0 1 L9 5 L0 9 z");
    path.setAttribute("class", className);
    marker.append(path);
    defs.append(marker);
  }
  return defs;
}

function worstOf(findings: Finding[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const finding of findings) {
    if (!worst || SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(worst)) {
      worst = finding.severity;
    }
  }
  return worst;
}

function ellipsize(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function text(tag: string, content: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
}

function iconButton(
  name: Parameters<typeof icon>[0],
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name, 15));
  button.addEventListener("click", onClick);
  return button;
}
