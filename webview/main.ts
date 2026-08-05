import {
  CATEGORY_LABELS,
  SEVERITY_ORDER,
  type AnalysisReport,
  type Blueprint,
  type CodeFix,
  type Finding,
  type Severity,
} from "../src/engine/findings";
import { formatRing, type GraphNode } from "../src/memory/graph";
import type { AllowedCommand, HostMessage, WebviewMessage } from "../src/protocol";
import { GraphView } from "./graphView";
import { icon, type IconName } from "./icons";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

type TabId = "overview" | "map" | "findings" | "fixes" | "blueprint" | "scalability";

interface ViewState {
  tab: TabId;
  /** Severities the findings list is filtered to; empty means all. */
  severities: Set<Severity>;
  query: string;
  /** Node selected in the map, mirrored into the findings filter. */
  focusNode?: string;
}

let report: AnalysisReport | undefined;
let view: ViewState = { tab: "overview", severities: new Set(), query: "" };
let graphView: GraphView | undefined;
/** Apply/preview outcomes, keyed by fix id, so results survive a re-render. */
const fixResults = new Map<string, { ok: boolean; message: string }>();

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "report") {
    report = message.report;
    graphView = undefined;
    render();
  } else if (message.type === "fixResult") {
    fixResults.set(message.fixId, { ok: message.ok, message: message.message });
    render();
  }
});

vscode.postMessage({ type: "ready" });

function render(): void {
  if (!report) return;
  root.replaceChildren(hero(report), tabBar(report), panel(report), footer(report));
}

// --- Chrome ----------------------------------------------------------------

function hero(r: AnalysisReport): HTMLElement {
  const el = document.createElement("header");
  el.className = "hero";
  el.append(gradeRing(r.grade));

  const body = div("hero-body");
  const eyebrow = div("eyebrow");
  eyebrow.append(icon("layers", 12), textNode("span", "Architecture review"));
  body.append(eyebrow, tag("h1", r.workspaceName), tag("p", r.summary, "summary"));

  const meta = div("hero-meta");
  meta.append(
    metaItem("check", `${r.provider} · ${r.model}`),
    metaItem("file", `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`),
    metaItem("wrench", `${r.fixes.length} ready to apply`),
  );
  body.append(meta);

  if (r.incompleteReason) {
    const notice = div("notice");
    notice.append(icon("alert", 15), textNode("span", r.incompleteReason));
    body.append(notice);
  }
  el.append(body);
  return el;
}

/**
 * The grade as a ring. A letter on its own gives no sense of the scale it sits
 * on; an arc filled to four-fifths for a B says "close to the top" without a
 * legend.
 */
function gradeRing(grade: AnalysisReport["grade"]): HTMLElement {
  const fraction: Record<string, number> = { A: 1, B: 0.8, C: 0.6, D: 0.4, F: 0.18 };
  const wrap = div(`grade-ring grade-${grade}`);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  const radius = 44;
  const circumference = 2 * Math.PI * radius;

  for (const cls of ["track", "value"]) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "50");
    circle.setAttribute("cy", "50");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("class", cls);
    if (cls === "value") {
      circle.setAttribute("stroke-dasharray", String(circumference));
      circle.setAttribute("stroke-dashoffset", String(circumference));
      requestAnimationFrame(() =>
        circle.setAttribute(
          "stroke-dashoffset",
          String(circumference * (1 - (fraction[grade] ?? 0.5))),
        ),
      );
    }
    svg.append(circle);
  }
  wrap.append(svg);

  const letter = div("grade-letter");
  letter.textContent = grade;
  letter.setAttribute("aria-label", `Overall grade ${grade}`);
  wrap.append(letter);
  return wrap;
}

function tabBar(r: AnalysisReport): HTMLElement {
  const bar = div("tabs");
  bar.setAttribute("role", "tablist");

  const tabs: Array<{ id: TabId; label: string; glyph: IconName; count?: number; show: boolean }> = [
    { id: "overview", label: "Overview", glyph: "gauge", show: true },
    {
      id: "map",
      label: "Architecture map",
      glyph: "graph",
      count: r.graph?.nodes.length,
      show: (r.graph?.nodes.length ?? 0) > 0,
    },
    { id: "findings", label: "Findings", glyph: "alert", count: r.findings.length, show: true },
    {
      id: "fixes",
      label: "Fixes",
      glyph: "wrench",
      count: r.fixes.length,
      show: r.fixes.length > 0,
    },
    { id: "blueprint", label: "Blueprint", glyph: "layers", show: Boolean(r.blueprint) },
    { id: "scalability", label: "Scalability", glyph: "gauge", show: Boolean(r.scalability) },
  ];

  for (const entry of tabs.filter((t) => t.show)) {
    const button = document.createElement("button");
    button.className = `tab${view.tab === entry.id ? " active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(view.tab === entry.id));
    button.append(icon(entry.glyph, 14), textNode("span", entry.label));
    if (entry.count !== undefined) {
      button.append(textNode("span", String(entry.count), "pill"));
    }
    button.addEventListener("click", () => {
      view.tab = entry.id;
      render();
    });
    bar.append(button);
  }
  return bar;
}

function panel(r: AnalysisReport): HTMLElement {
  const el = document.createElement("section");
  el.className = "panel";
  el.setAttribute("role", "tabpanel");

  switch (view.tab) {
    case "overview":
      el.append(...overviewPanel(r));
      break;
    case "map":
      el.append(mapPanel(r));
      break;
    case "findings":
      el.append(...findingsPanel(r));
      break;
    case "fixes":
      el.append(...fixesPanel(r));
      break;
    case "blueprint":
      if (r.blueprint) el.append(...blueprintPanel(r.blueprint));
      break;
    case "scalability":
      if (r.scalability) el.append(...scalabilityPanel(r.scalability));
      break;
  }
  return el;
}

// --- Overview --------------------------------------------------------------

function overviewPanel(r: AnalysisReport): HTMLElement[] {
  const out: HTMLElement[] = [];

  const counts = countBySeverity(r.findings);
  const stats = div("stats");
  for (const severity of SEVERITY_ORDER.filter((s) => counts[s] > 0)) {
    stats.append(statTile(String(counts[severity]), severity, SEVERITY_COLOR[severity]));
  }
  stats.append(statTile(String(r.fixes.length), "applicable fixes"));
  if (r.graph) {
    stats.append(statTile(String(r.graph.cycles.length), "circular deps"));
    stats.append(statTile(String(r.graph.depth), "layers deep"));
  }
  out.push(stats);

  const actions = div("filters");
  actions.append(
    actionButton("Export as Markdown", "download", "ironbase.exportReport", "primary"),
    actionButton("Re-run review", "refresh", "ironbase.analyze", "ghost"),
    actionButton("Scalability check", "gauge", "ironbase.scalabilityCheck", "ghost"),
  );
  actions.style.marginTop = "var(--space-6)";
  out.push(actions);

  // The top of the report should answer "what do I do now", so the worst
  // findings that already have a patch come first.
  const actionable = r.findings
    .filter((f) => r.fixes.some((fix) => fix.findingId === f.id))
    .slice(0, 3);
  if (actionable.length > 0) {
    out.push(tag("h2", "Start here"));
    for (const finding of actionable) out.push(findingCard(finding, r, true));
  } else if (r.findings.length > 0) {
    out.push(tag("h2", "Most important first"));
    for (const finding of r.findings.slice(0, 3)) out.push(findingCard(finding, r, true));
  }

  if (r.graph && r.graph.cycles.length > 0) {
    out.push(tag("h2", "Tangles worth untying"));
    for (const cycle of r.graph.cycles.slice(0, 4)) {
      const row = div("move");
      row.append(
        textNode(
          "div",
          cycle.length === 2
            ? "These two import each other"
            : `${cycle.length} modules form a dependency loop`,
          "move-what",
        ),
      );
      row.append(textNode("div", formatRing(cycle), "move-why"));
      out.push(row);
    }
  }
  return out;
}

function statTile(value: string, label: string, color?: string): HTMLElement {
  const tile = div("stat-tile");
  tile.append(textNode("div", value, "n"));
  const key = div("k");
  if (color) {
    const dot = div("dot");
    dot.style.background = color;
    key.append(dot);
  }
  key.append(textNode("span", label));
  tile.append(key);
  return tile;
}

// --- Architecture map ------------------------------------------------------

function mapPanel(r: AnalysisReport): HTMLElement {
  const layout = div("graph-layout");
  if (!r.graph) return layout;

  const inspector = div("inspector");
  showInspector(inspector, undefined, r);

  graphView = new GraphView(r.graph, r.findings, {
    onSelect: (node) => {
      view.focusNode = node?.id;
      showInspector(inspector, node, r);
    },
    onOpenFile: (file, line) => vscode.postMessage({ type: "openFile", file, line }),
  });

  layout.append(graphView.element, inspector);
  return layout;
}

/** The side panel: what one module is, and what is wrong inside it. */
function showInspector(
  host: HTMLElement,
  node: GraphNode | undefined,
  r: AnalysisReport,
): void {
  host.replaceChildren();
  if (!node) {
    host.append(
      textNode("p", "Select a box to see what it depends on and what was found inside it.", "empty-hint"),
    );
    return;
  }

  host.append(tag("h4", node.id));

  const kv = document.createElement("dl");
  kv.className = "kv";
  const rows: Array<[string, string]> = [
    ["Depended on by", `${node.fanIn} module${node.fanIn === 1 ? "" : "s"}`],
    ["Depends on", `${node.fanOut} module${node.fanOut === 1 ? "" : "s"}`],
    ["Layer", String(node.layer)],
    ["Lines", node.loc.toLocaleString()],
  ];
  if (node.kind !== "file") rows.push(["Files", String(node.fileCount)]);
  for (const [key, value] of rows) {
    kv.append(tag("dt", key), tag("dd", value));
  }
  host.append(kv);

  if (node.risks.length > 0) {
    host.append(textNode("p", "Risk signals", "label"));
    const chips = div("chip-row");
    for (const risk of node.risks.slice(0, 6)) chips.append(textNode("span", risk, "chip risk"));
    host.append(chips);
  }
  if (node.externals.length > 0) {
    host.append(textNode("p", "Depends on", "label"));
    const chips = div("chip-row");
    for (const name of node.externals) chips.append(textNode("span", name, "chip"));
    host.append(chips);
  }

  const findings = graphView?.findingsOn(node.id) ?? [];
  if (findings.length > 0) {
    host.append(textNode("p", `${findings.length} finding${findings.length === 1 ? "" : "s"} here`, "label"));
    // A finding title is a sentence, not a path, so it needs the reading font
    // and a row of its own — `ref` alone runs them together in monospace.
    const list = div("finding-list");
    for (const finding of findings) {
      const link = document.createElement("a");
      link.className = "ref prose";
      const dot = div("dot");
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;flex:none;background:${SEVERITY_COLOR[finding.severity]}`;
      link.append(dot, textNode("span", finding.title));
      link.addEventListener("click", () => {
        view.tab = "findings";
        view.query = finding.title;
        render();
      });
      list.append(link);
    }
    host.append(list);
  }

  const files = div("file-list");
  for (const file of node.files.slice(0, 12)) {
    const link = document.createElement("a");
    link.className = "ref";
    link.textContent = file;
    link.addEventListener("click", () => vscode.postMessage({ type: "openFile", file }));
    files.append(link);
  }
  host.append(textNode("p", "Files", "label"), files);
}

// --- Findings --------------------------------------------------------------

function findingsPanel(r: AnalysisReport): HTMLElement[] {
  const out: HTMLElement[] = [];
  const counts = countBySeverity(r.findings);

  const filters = div("filters");
  for (const severity of SEVERITY_ORDER.filter((s) => counts[s] > 0)) {
    const chip = document.createElement("button");
    chip.className = `filter-chip${view.severities.has(severity) ? " on" : ""}`;
    const dot = div("dot");
    dot.style.background = SEVERITY_COLOR[severity];
    chip.append(dot, textNode("span", `${severity} · ${counts[severity]}`));
    chip.addEventListener("click", () => {
      if (view.severities.has(severity)) view.severities.delete(severity);
      else view.severities.add(severity);
      render();
    });
    filters.append(chip);
  }

  const search = div("search-box");
  search.append(icon("search", 13));
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Filter findings…";
  input.value = view.query;
  input.addEventListener("input", () => {
    view.query = input.value;
    renderFindingsList(list, r);
  });
  search.append(input);
  filters.append(search);
  out.push(filters);

  const list = div("findings-list");
  renderFindingsList(list, r);
  out.push(list);
  return out;
}

function renderFindingsList(host: HTMLElement, r: AnalysisReport): void {
  const query = view.query.trim().toLowerCase();
  const matching = r.findings.filter((finding) => {
    if (view.severities.size > 0 && !view.severities.has(finding.severity)) return false;
    if (query.length === 0) return true;
    return (
      finding.title.toLowerCase().includes(query) ||
      finding.explanation.toLowerCase().includes(query) ||
      finding.evidence.some((e) => e.file.toLowerCase().includes(query))
    );
  });

  host.replaceChildren();
  if (matching.length === 0) {
    host.append(
      emptyState(
        "check",
        r.findings.length === 0 ? "No problems reported" : "Nothing matches those filters",
        r.findings.length === 0
          ? "The review found no architecture problems worth reporting in this workspace."
          : "Try clearing the search box or turning a severity filter back on.",
      ),
    );
    return;
  }

  for (const severity of SEVERITY_ORDER) {
    const group = matching.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const heading = tag("h3");
    const dot = div("dot");
    dot.style.background = SEVERITY_COLOR[severity];
    heading.append(dot, document.createTextNode(`${severity} · ${group.length}`));
    host.append(heading);
    for (const finding of group) host.append(findingCard(finding, r, false));
  }
}

function findingCard(finding: Finding, r: AnalysisReport, open: boolean): HTMLElement {
  const details = document.createElement("details");
  details.className = "finding";
  const fixes = r.fixes.filter((fix) => fix.findingId === finding.id);
  details.open = open || finding.severity === "critical" || finding.severity === "high";

  const summary = document.createElement("summary");
  const bar = div("sev-bar");
  bar.style.background = SEVERITY_COLOR[finding.severity];
  summary.append(icon("chevron", 13, "chev"), bar, textNode("span", finding.title, "finding-title"));

  if (fixes.length > 0) {
    const badge = textNode(
      "span",
      fixes.length === 1 ? "1 fix" : `${fixes.length} fixes`,
      "tag has-fix",
    );
    badge.prepend(icon("wrench", 11));
    summary.append(badge);
  }
  summary.append(
    textNode(
      "span",
      CATEGORY_LABELS[finding.category] + (finding.effort ? ` · ${finding.effort}` : ""),
      "tag",
    ),
  );
  details.append(summary);

  const body = div("finding-body");
  body.append(tag("p", finding.explanation));

  const note = tag("p", "", "fix-note");
  const label = document.createElement("strong");
  label.textContent = "What to do — ";
  note.append(label, document.createTextNode(finding.recommendation));
  body.append(note);

  if (finding.evidence.length > 0) {
    const list = div("evidence");
    for (const evidence of finding.evidence) {
      const link = document.createElement("a");
      link.className = "ref";
      link.textContent = evidence.startLine
        ? `${evidence.file}:${evidence.startLine}`
        : evidence.file;
      link.addEventListener("click", () =>
        vscode.postMessage({ type: "openFile", file: evidence.file, line: evidence.startLine }),
      );
      list.append(link);
    }
    body.append(list);
  }

  for (const fix of fixes) body.append(patchCard(fix));
  details.append(body);
  return details;
}

// --- Fixes -----------------------------------------------------------------

function fixesPanel(r: AnalysisReport): HTMLElement[] {
  if (r.fixes.length === 0) {
    return [
      emptyState(
        "wrench",
        "No patches this run",
        "The review did not produce any changes small enough to write out. The findings still describe what to do.",
      ),
    ];
  }

  const out: HTMLElement[] = [];
  out.push(
    textNode(
      "p",
      "Each patch was checked against the file it targets when the review ran, and is checked again the moment you apply it. Applying leaves the change unsaved in your editor, so you can undo it.",
      "summary",
    ),
  );

  const byFile = new Map<string, CodeFix[]>();
  for (const fix of r.fixes) {
    const list = byFile.get(fix.file) ?? [];
    list.push(fix);
    byFile.set(fix.file, list);
  }
  for (const [file, fixes] of byFile) {
    out.push(tag("h3", file));
    for (const fix of fixes) out.push(patchCard(fix));
  }
  return out;
}

/**
 * One patch, shown as a diff.
 *
 * The signs in the gutter do the work colour cannot: a red-green diff is
 * unreadable to a chunk of the people who will open this panel, and "−" and "+"
 * are unambiguous to everyone.
 */
function patchCard(fix: CodeFix): HTMLElement {
  const card = div("patch");

  const head = div("patch-head");
  const who = div("who");
  who.append(textNode("div", fix.title, "patch-title"));
  who.append(
    textNode(
      "span",
      fix.kind === "create"
        ? `creates ${fix.file}`
        : `${fix.file}${fix.startLine ? `:${fix.startLine}` : ""}`,
      "patch-where",
    ),
  );
  head.append(who);

  const actions = div("patch-actions");
  actions.append(
    fixButton("Preview", "diff", "ghost", () =>
      vscode.postMessage({ type: "previewFix", fixId: fix.id }),
    ),
    fixButton("Copy", "copy", "ghost", () =>
      vscode.postMessage({ type: "copyFix", fixId: fix.id }),
    ),
    fixButton("Apply", "check", "primary", () =>
      vscode.postMessage({ type: "applyFix", fixId: fix.id }),
    ),
  );
  head.append(actions);
  card.append(head);

  card.append(textNode("div", fix.rationale, "patch-why"));

  card.append(renderDiff(fix));

  const result = fixResults.get(fix.id);
  if (result) {
    const row = div(`patch-result ${result.ok ? "ok" : "bad"}`);
    row.append(icon(result.ok ? "check" : "alert", 13), textNode("span", result.message));
    card.append(row);
  }
  return card;
}

/**
 * Renders the patch as a diff with context.
 *
 * Most patches change two lines out of eight, and showing all eight as deleted
 * and all eight as added buries which two actually moved. Trimming the shared
 * head and tail is the cheap 90% of a real diff: it needs no edit-distance
 * algorithm and it puts the change where the eye already is.
 */
function renderDiff(fix: CodeFix): HTMLElement {
  const diff = div("diff");

  if (fix.kind === "create") {
    for (const line of fix.replacement.split("\n")) diff.append(diffLine("+", line, "add"));
    return diff;
  }
  if (fix.kind === "insert-after") {
    for (const line of fix.anchor.split("\n")) diff.append(diffLine(" ", line, ""));
    for (const line of fix.replacement.split("\n")) diff.append(diffLine("+", line, "add"));
    return diff;
  }

  const before = fix.anchor.split("\n");
  const after = fix.replacement.split("\n");

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  for (const line of before.slice(0, head)) diff.append(diffLine(" ", line, ""));
  for (const line of before.slice(head, before.length - tail)) {
    diff.append(diffLine("−", line, "del"));
  }
  for (const line of after.slice(head, after.length - tail)) {
    diff.append(diffLine("+", line, "add"));
  }
  for (const line of before.slice(before.length - tail)) diff.append(diffLine(" ", line, ""));
  return diff;
}

function diffLine(sign: string, code: string, className: string): HTMLElement {
  const line = div(`diff-line ${className}`.trim());
  line.append(textNode("span", sign, "sign"), textNode("span", code || " ", "code"));
  return line;
}

// --- Blueprint -------------------------------------------------------------

function blueprintPanel(blueprint: Blueprint): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(textNode("div", blueprint.summary, "blueprint-summary"));

  if (blueprint.moves.length > 0) {
    out.push(tag("h2", "What should move where"));
    for (const move of blueprint.moves) {
      const row = div("move");
      row.append(textNode("div", move.what, "move-what"));
      row.append(textNode("div", move.from, "path from"));
      const arrow = div("arrow");
      arrow.append(icon("chevron", 13));
      row.append(arrow);
      row.append(textNode("div", move.to, "path to"));
      if (move.why) row.append(textNode("div", move.why, "move-why"));
      out.push(row);
    }
  }

  if (blueprint.stack.length > 0) {
    out.push(tag("h2", "Worth modernising"));
    const card = div("capacity-card");
    card.style.padding = "0";
    for (const upgrade of blueprint.stack) {
      const row = div("upgrade");
      row.append(textNode("div", upgrade.concern, "concern"));
      const swap = div("swap");
      swap.append(
        textNode("span", upgrade.current, "now"),
        icon("chevron", 12),
        textNode("span", upgrade.recommended, "next"),
      );
      row.append(swap);
      if (upgrade.why) row.append(textNode("div", upgrade.why, "why"));
      card.append(row);
    }
    out.push(card);
  }
  return out;
}

// --- Scalability -----------------------------------------------------------

function scalabilityPanel(
  scalability: NonNullable<AnalysisReport["scalability"]>,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const card = div("capacity-card");

  const head = div("capacity-head");
  const now = div("capacity-block");
  now.append(
    textNode("p", "Estimated capacity today", "label"),
    textNode("p", scalability.estimatedCurrentCapacity, "capacity-value"),
  );
  const target = div("capacity-block right");
  target.append(
    textNode("p", "Target", "label"),
    textNode("p", scalability.target, "capacity-value target"),
  );
  head.append(now, target);
  card.append(head, capacityMeter(scalability.estimatedCurrentCapacity, scalability.target));

  if (scalability.assumptions.length > 0) {
    const block = div("assumptions");
    block.append(textNode("p", "What this estimate assumes", "label"), bulletList(scalability.assumptions));
    card.append(block);
  }
  out.push(card);

  if (scalability.bottlenecks.length > 0) {
    out.push(tag("h2", "What caps it, most limiting first"));
    for (const bottleneck of scalability.bottlenecks) {
      const row = div("bottleneck");
      row.append(textNode("div", String(bottleneck.rank), "rank"));
      const body = div("bottleneck-body");
      body.append(
        textNode("p", bottleneck.component, "bottleneck-name"),
        textNode("p", bottleneck.why, "bottleneck-why"),
      );
      row.append(body);
      out.push(row);
    }
  }

  if (scalability.roadmap.length > 0) {
    out.push(tag("h2", "How to close the gap"));
    for (const phase of scalability.roadmap) {
      const block = div("phase");
      block.append(div("phase-marker"));
      const body = div("phase-body");
      body.append(tag("h4", phase.phase), bulletList(phase.actions));
      body.append(textNode("p", `Expected after this phase: ${phase.expectedCapacity}`, "outcome"));
      block.append(body);
      out.push(block);
    }
  }
  return out;
}

/**
 * A meter — one ratio against a limit — rather than a dial. The fill carries
 * severity and the track is a dimmer step of the same colour, so the state reads
 * across the whole bar and not just the filled part.
 */
function capacityMeter(currentText: string, targetText: string): HTMLElement {
  const current = firstNumber(currentText);
  const target = firstNumber(targetText);

  const wrap = document.createElement("div");
  const meter = div("meter");
  const fill = div("meter-fill");

  let ratio: number | undefined;
  if (current !== undefined && target !== undefined && target > 0) {
    ratio = Math.max(0, Math.min(1, current / target));
  }

  const color =
    ratio === undefined
      ? "var(--sev-low)"
      : ratio >= 1
        ? "var(--good)"
        : ratio >= 0.5
          ? "var(--sev-medium)"
          : ratio >= 0.1
            ? "var(--sev-high)"
            : "var(--sev-critical)";

  fill.style.background = color;
  meter.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
  meter.append(fill);
  requestAnimationFrame(() => {
    fill.style.width = `${((ratio ?? 0.04) * 100).toFixed(1)}%`;
  });

  const caption = div("meter-caption");
  if (ratio === undefined) {
    caption.append(textNode("span", "The estimate is not a plain number, so the bar is indicative only."));
  } else if (ratio >= 1) {
    caption.append(textNode("span", "The current estimate already meets the target."));
  } else {
    const shortfall = target! / Math.max(current!, 1);
    caption.append(
      textNode("span", `About ${formatMultiple(shortfall)} short of the target`),
      textNode("span", `${Math.round(ratio * 100)}% of the way there`),
    );
  }
  wrap.append(meter, caption);
  return wrap;
}

/** Pulls the first magnitude out of prose like "roughly 50–150 concurrent users". */
function firstNumber(text: string): number | undefined {
  const match = /(\d[\d,.]*)\s*(k|m|thousand|million)?/i.exec(text.replace(/,/g, ""));
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2]?.toLowerCase();
  if (unit === "k" || unit === "thousand") return value * 1000;
  if (unit === "m" || unit === "million") return value * 1_000_000;
  return value;
}

function formatMultiple(value: number): string {
  if (value >= 100) return `${Math.round(value / 10) * 10}×`;
  if (value >= 10) return `${Math.round(value)}×`;
  return `${value.toFixed(1)}×`;
}

function footer(r: AnalysisReport): HTMLElement {
  const el = document.createElement("footer");
  el.textContent =
    `Generated ${new Date(r.generatedAt).toLocaleString()} by ${r.provider}. ` +
    "Capacity figures are read from the code, not measured — treat them as a starting point for your own load testing. " +
    "The dependency map is built from import statements, so dynamic or generated imports will not appear in it.";
  return el;
}

// --- Small builders --------------------------------------------------------

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

function emptyState(glyph: IconName, title: string, body: string): HTMLElement {
  const el = div("empty-state");
  el.append(icon(glyph, 32), textNode("strong", title), textNode("p", body));
  return el;
}

function metaItem(glyph: IconName, label: string): HTMLElement {
  const span = document.createElement("span");
  span.append(icon(glyph, 12), document.createTextNode(label));
  return span;
}

function actionButton(
  label: string,
  glyph: IconName,
  command: AllowedCommand,
  variant: "primary" | "ghost",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `btn ${variant}`;
  button.append(icon(glyph, 14), textNode("span", label));
  button.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
  return button;
}

function fixButton(
  label: string,
  glyph: IconName,
  variant: "primary" | "ghost",
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `btn ${variant}`;
  button.append(icon(glyph, 13), textNode("span", label));
  button.addEventListener("click", onClick);
  return button;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  if (className) el.className = className;
  return el;
}

function tag(name: string, text?: string, className?: string): HTMLElement {
  const el = document.createElement(name);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function textNode(name: string, text: string, className?: string): HTMLElement {
  return tag(name, text, className);
}

function bulletList(items: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.append(li);
  }
  return ul;
}
