/**
 * The visual system for both webviews.
 *
 * Two rules hold the whole thing together. First, every colour derives from a
 * VS Code theme variable, so the panel belongs to whatever theme the user chose
 * rather than fighting it — the only fixed colours are the severity palette and
 * the brand marks, which have to stay recognisable. Second, severity is never
 * carried by colour alone; every coloured element sits next to its written
 * label, which is what keeps the sub-3:1 steps legible.
 */

const TOKENS = `
:root {
  /* Status palette — fixed, because these encode state, not identity. */
  --sev-critical: #e0483f;
  --sev-high: #f0803c;
  --sev-medium: #f5b71d;
  --sev-low: #7c8899;
  --sev-info: #8a8a8a;
  --good: #1aa251;

  --accent: var(--vscode-textLink-foreground, #3b9eff);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  --ink: var(--vscode-foreground);
  --ink-muted: var(--vscode-descriptionForeground);
  --surface: color-mix(in srgb, var(--vscode-editor-foreground) 3.5%, var(--vscode-editor-background));
  --surface-raised: color-mix(in srgb, var(--vscode-editor-foreground) 7%, var(--vscode-editor-background));
  --surface-sunken: color-mix(in srgb, var(--vscode-editor-foreground) 1.5%, var(--vscode-editor-background));
  --hairline: color-mix(in srgb, var(--vscode-editor-foreground) 11%, transparent);
  --hairline-strong: color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.12);
  --shadow-md: 0 4px 16px -4px rgba(0, 0, 0, 0.24);

  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
}

* { box-sizing: border-box; }

/* Motion is decoration; anyone who has asked for less should get none. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}

:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, var(--accent));
  outline-offset: 2px;
  border-radius: 4px;
}
`;

const BUTTONS = `
button {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  transition: background 130ms ease, border-color 130ms ease, transform 130ms ease, opacity 130ms ease;
}
button:active { transform: translateY(0.5px); }
button:disabled { opacity: 0.5; cursor: default; }

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.44rem 0.85rem;
  white-space: nowrap;
}
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.btn.ghost {
  border-color: var(--hairline-strong);
  color: var(--ink);
}
.btn.ghost:hover { background: var(--surface-raised); }
.btn.quiet { color: var(--ink-muted); padding: 0.3rem 0.5rem; }
.btn.quiet:hover { background: var(--surface-raised); color: var(--ink); }

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--ink-muted);
  border-color: transparent;
}
.icon-button:hover { background: var(--surface-raised); color: var(--ink); }
`;

const GRAPH = `
/* ---- Architecture map ---- */

.graph-host { display: flex; flex-direction: column; gap: var(--space-3); }

.graph-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.graph-summary {
  margin: 0;
  font-size: 12px;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}
.graph-controls { display: flex; gap: 2px; margin-left: auto; }

.graph-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.22rem 0.6rem;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--sev-critical) 40%, transparent);
  background: color-mix(in srgb, var(--sev-critical) 12%, transparent);
  color: var(--sev-critical);
}
.graph-badge:hover { background: color-mix(in srgb, var(--sev-critical) 20%, transparent); }

.graph-frame {
  position: relative;
  /* Provisional only — fit() replaces this with the height the graph needs. */
  height: 380px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 1px 1px, var(--hairline) 1px, transparent 0) 0 0 / 22px 22px,
    var(--surface-sunken);
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.graph-frame.dragging { cursor: grabbing; }
.graph-svg { width: 100%; height: 100%; display: block; }

.node { cursor: pointer; }
.node-box {
  fill: var(--surface-raised);
  stroke: var(--hairline-strong);
  stroke-width: 1;
  transition: fill 130ms ease, stroke 130ms ease;
}
.node:hover .node-box { fill: color-mix(in srgb, var(--accent) 10%, var(--surface-raised)); }
.node.active .node-box {
  stroke: var(--accent);
  stroke-width: 1.8;
  fill: color-mix(in srgb, var(--accent) 14%, var(--surface-raised));
}
.node-label {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  fill: var(--ink);
}
.node-meta { font-size: 10px; fill: var(--ink-muted); }
.node-entry {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  fill: var(--accent);
}
.badge-text { font-size: 10px; font-weight: 700; fill: #fff; }

.node.dim { opacity: 0.28; }
.node { transition: opacity 140ms ease; }

.edge {
  fill: none;
  stroke: var(--hairline-strong);
  transition: opacity 140ms ease, stroke 140ms ease;
}
.edge.cyclic { stroke: var(--sev-critical); stroke-dasharray: 4 3; opacity: 0.85; }
.edge.dim { opacity: 0.12; }
.edge.lit { stroke: var(--accent); opacity: 1; }
.arrow-head { fill: var(--hairline-strong); }
.arrow-head.cyclic { fill: var(--sev-critical); }
g.focused .edge:not(.lit) { opacity: 0.12; }

.graph-legend { display: flex; flex-direction: column; gap: var(--space-2); }
.legend-note { font-size: 11.5px; color: var(--ink-muted); }
.legend-keys { display: flex; gap: var(--space-4); flex-wrap: wrap; }
.legend-key {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11px;
  color: var(--ink-muted);
}
.legend-swatch { width: 9px; height: 9px; border-radius: 3px; }
.legend-swatch.neutral { background: var(--node-quiet); }
.legend-caveat { margin: 0; font-size: 11px; color: var(--ink-muted); font-style: italic; }

:root { --node-quiet: color-mix(in srgb, var(--vscode-editor-foreground) 22%, transparent); }
`;

export const REPORT_STYLES = `
${TOKENS}

body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  background: var(--vscode-editor-background);
  -webkit-font-smoothing: antialiased;
}
#root { max-width: 74rem; margin: 0 auto; padding: 0 var(--space-8) var(--space-12); }
@media (max-width: 720px) { #root { padding: 0 var(--space-4) var(--space-8); } }

.loading { color: var(--ink-muted); padding-top: var(--space-10); }

${BUTTONS}

/* ---- Hero ---- */

.hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-6);
  align-items: center;
  padding: var(--space-10) 0 var(--space-6);
}
@media (max-width: 640px) { .hero { grid-template-columns: 1fr; } }

/* The grade is the one hero figure, so it gets a ring showing how much of the
   scale it occupies — a letter alone gives no sense of the range it sits in. */
.grade-ring { position: relative; width: 104px; height: 104px; }
.grade-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.grade-ring .track { fill: none; stroke: var(--hairline); stroke-width: 6; }
.grade-ring .value {
  fill: none;
  stroke-width: 6;
  stroke-linecap: round;
  transition: stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1);
}
.grade-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  font-weight: 300;
  letter-spacing: -0.04em;
  line-height: 1;
}
.grade-A .value, .grade-A .grade-letter { stroke: var(--good); color: var(--good); }
.grade-B .value, .grade-B .grade-letter { stroke: var(--good); color: var(--good); }
.grade-C .value, .grade-C .grade-letter { stroke: var(--sev-medium); color: var(--sev-medium); }
.grade-D .value, .grade-D .grade-letter { stroke: var(--sev-high); color: var(--sev-high); }
.grade-F .value, .grade-F .grade-letter { stroke: var(--sev-critical); color: var(--sev-critical); }

.hero-body { min-width: 0; }
.eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 0 0 var(--space-2);
}
h1 {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 var(--space-3);
  word-break: break-word;
}
.summary { margin: 0; font-size: 14.5px; line-height: 1.6; max-width: 52rem; }
.hero-meta {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-3);
  font-size: 11.5px;
  color: var(--ink-muted);
}
.hero-meta span { display: inline-flex; align-items: center; gap: var(--space-1); }

.notice {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  margin: var(--space-4) 0 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--sev-medium) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--sev-medium) 30%, transparent);
  font-size: 12.5px;
}
.notice svg { flex: 0 0 auto; color: var(--sev-medium); margin-top: 1px; }

/* ---- Stat tiles ---- */

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(126px, 1fr));
  gap: var(--space-2);
  margin: var(--space-6) 0 0;
}
.stat-tile {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--hairline);
}
.stat-tile .n {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.stat-tile .k {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11px;
  color: var(--ink-muted);
  margin-top: 2px;
}
.stat-tile .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }

/* ---- Tabs ---- */

.tabs {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  gap: var(--space-1);
  margin: var(--space-8) 0 var(--space-6);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--hairline);
  background: var(--vscode-editor-background);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-muted);
  white-space: nowrap;
  position: relative;
}
.tab:hover { background: var(--surface-raised); color: var(--ink); }
.tab.active { color: var(--ink); background: var(--surface-raised); }
.tab.active::after {
  content: "";
  position: absolute;
  left: 0.75rem;
  right: 0.75rem;
  bottom: -9px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.tab .pill {
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  color: var(--ink-muted);
}
.tab.active .pill { background: var(--accent-soft); border-color: transparent; color: var(--accent); }

.panel { animation: rise 220ms cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

h2 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: var(--space-8) 0 var(--space-4);
}
h2:first-child { margin-top: 0; }
h3 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: var(--space-6) 0 var(--space-3);
}
h3 .dot { width: 7px; height: 7px; border-radius: 50%; }

${GRAPH}

/* ---- Graph detail panel ---- */

.graph-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 272px;
  gap: var(--space-4);
  align-items: start;
}
@media (max-width: 900px) { .graph-layout { grid-template-columns: 1fr; } }

/* Nudged down so it lines up with the top of the graph frame, not the toolbar
   sitting above it in the other column. */
.inspector {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: var(--space-4);
  position: sticky;
  top: 56px;
  margin-top: 34px;
}
@media (max-width: 900px) { .inspector { margin-top: 0; } }
.inspector .empty-hint { color: var(--ink-muted); font-size: 12px; margin: 0; }
.inspector h4 {
  margin: 0 0 var(--space-1);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--mono);
  word-break: break-all;
}
.inspector .kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-3);
  margin: var(--space-3) 0;
  font-size: 11.5px;
}
.inspector .kv dt { color: var(--ink-muted); }
.inspector .kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.inspector .chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--space-2); }
.chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  color: var(--ink-muted);
  background: var(--surface-raised);
}
.chip.risk { color: var(--sev-high); border-color: color-mix(in srgb, var(--sev-high) 35%, transparent); }
.inspector .file-list { display: flex; flex-direction: column; gap: 1px; margin-top: var(--space-2); }
.inspector .finding-list { display: flex; flex-direction: column; gap: 2px; margin-top: var(--space-2); }

/* ---- Findings ---- */

.filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.25rem 0.65rem;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  font-size: 11.5px;
  color: var(--ink-muted);
}
.filter-chip:hover { border-color: var(--hairline-strong); color: var(--ink); }
.filter-chip.on {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--ink);
}
.filter-chip .dot { width: 7px; height: 7px; border-radius: 50%; }
.search-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: var(--ink-muted);
}
.search-box:focus-within { border-color: var(--accent); }
.search-box input {
  border: none;
  background: none;
  outline: none;
  color: var(--ink);
  font-family: inherit;
  font-size: 12px;
  width: 11rem;
  max-width: 40vw;
}

details.finding {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-2);
  background: var(--surface);
  overflow: hidden;
  transition: border-color 130ms ease, box-shadow 130ms ease;
}
details.finding:hover { border-color: var(--hairline-strong); box-shadow: var(--shadow-sm); }
details.finding[open] { box-shadow: var(--shadow-sm); }
details.finding > summary {
  cursor: pointer;
  padding: var(--space-3) var(--space-4);
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: 13.5px;
  font-weight: 500;
}
details.finding > summary::-webkit-details-marker { display: none; }
.chev { flex: 0 0 auto; opacity: 0.5; transition: transform 160ms ease; }
details.finding[open] .chev { transform: rotate(90deg); }
.sev-bar { flex: 0 0 auto; width: 3px; height: 18px; border-radius: 2px; }
.finding-title { flex: 1; min-width: 0; }
.tag {
  font-size: 10.5px;
  font-weight: 500;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  flex: 0 0 auto;
  color: var(--ink-muted);
  border: 1px solid var(--hairline);
  white-space: nowrap;
}
.tag.has-fix {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 40%, transparent);
  background: color-mix(in srgb, var(--good) 10%, transparent);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.finding-body {
  padding: 0 var(--space-4) var(--space-4) calc(var(--space-4) + 3px + var(--space-3) + 16px);
  font-size: 13px;
}
.finding-body > p { margin: 0 0 var(--space-3); max-width: 50rem; }
.fix-note {
  padding: var(--space-3);
  background: var(--surface-raised);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--accent);
  margin-bottom: var(--space-3) !important;
}
.evidence { display: flex; flex-direction: column; gap: 1px; }
a.ref {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  align-self: flex-start;
  padding: 0.15rem 0.4rem;
  margin-left: -0.4rem;
  border-radius: 4px;
}
a.ref:hover { background: var(--surface-raised); text-decoration: underline; }
/* Titles rather than paths: readable font, one per row, dot kept off the text. */
a.ref.prose {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  line-height: 1.45;
  display: flex;
  align-items: baseline;
  align-self: stretch;
}

/* ---- Patch cards ---- */

.patch {
  margin-top: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface-sunken);
}
.patch-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-raised);
  border-bottom: 1px solid var(--hairline);
}
.patch-head .who { flex: 1; min-width: 0; }
.patch-title { font-weight: 600; font-size: 12.5px; }
.patch-where {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-muted);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.patch-actions { display: flex; gap: var(--space-2); flex: 0 0 auto; }
.patch-why {
  padding: var(--space-3) var(--space-4);
  font-size: 12.5px;
  color: var(--ink-muted);
  border-bottom: 1px solid var(--hairline);
}

/* A real diff, not a code block: the gutter carries the sign so the colour is
   never the only thing saying whether a line went in or out. */
.diff {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-x: auto;
  max-height: 24rem;
  overflow-y: auto;
}
.diff-line { display: flex; white-space: pre; min-width: max-content; }
.diff-line .sign {
  flex: 0 0 auto;
  width: 1.6rem;
  padding-left: var(--space-3);
  color: var(--ink-muted);
  user-select: none;
  opacity: 0.7;
}
.diff-line .code { padding-right: var(--space-4); }
.diff-line.add { background: color-mix(in srgb, var(--good) 13%, transparent); }
.diff-line.add .sign { color: var(--good); opacity: 1; }
.diff-line.del { background: color-mix(in srgb, var(--sev-critical) 12%, transparent); }
.diff-line.del .sign { color: var(--sev-critical); opacity: 1; }
.patch-result {
  padding: var(--space-2) var(--space-4);
  font-size: 11.5px;
  border-top: 1px solid var(--hairline);
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}
.patch-result.ok { color: var(--good); }
.patch-result.bad { color: var(--sev-critical); }
.patch-result svg { flex: 0 0 auto; margin-top: 2px; }

/* ---- Blueprint ---- */

.blueprint-summary {
  padding: var(--space-5);
  border-radius: var(--radius-lg);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 10%, var(--surface)),
    var(--surface)
  );
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: var(--space-6);
}
.move {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  background: var(--surface);
  margin-bottom: var(--space-2);
}
@media (max-width: 640px) { .move { grid-template-columns: 1fr; } .move .arrow { display: none; } }
.move .path {
  font-family: var(--mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.move .path.from { color: var(--ink-muted); }
.move .path.to { color: var(--accent); }
.move .arrow { color: var(--ink-muted); }
.move-what { grid-column: 1 / -1; font-weight: 600; font-size: 12.5px; }
.move-why { grid-column: 1 / -1; font-size: 12px; color: var(--ink-muted); }

.upgrade {
  display: grid;
  grid-template-columns: 8.5rem minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  padding: var(--space-4);
  border-bottom: 1px solid var(--hairline);
}
.upgrade:last-child { border-bottom: none; }
@media (max-width: 640px) { .upgrade { grid-template-columns: 1fr; } }
.upgrade .concern { font-weight: 600; font-size: 12.5px; }
.upgrade .swap { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; font-size: 12.5px; }
.upgrade .now { color: var(--ink-muted); text-decoration: line-through; text-decoration-color: var(--hairline-strong); }
.upgrade .next { font-weight: 600; color: var(--good); }
.upgrade .why { grid-column: 2; font-size: 12px; color: var(--ink-muted); }
@media (max-width: 640px) { .upgrade .why { grid-column: 1; } }

/* ---- Scalability ---- */

.capacity-card {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  background: var(--surface);
}
.capacity-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}
.capacity-block.right { text-align: right; }
.label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 0 0 var(--space-1);
}
.capacity-value { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: -0.01em; line-height: 1.35; }
.capacity-value.target { color: var(--ink-muted); font-weight: 500; }

.meter { height: 9px; border-radius: 999px; overflow: hidden; position: relative; }
.meter-fill {
  height: 100%;
  border-radius: 999px;
  min-width: 3px;
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1);
}
.meter-caption {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-2);
  font-size: 11.5px;
  color: var(--ink-muted);
}
.assumptions { margin-top: var(--space-6); padding-top: var(--space-4); border-top: 1px solid var(--hairline); }

.bottleneck { display: flex; gap: var(--space-4); padding: var(--space-3) 0; border-bottom: 1px solid var(--hairline); }
.bottleneck:last-child { border-bottom: none; }
.rank {
  flex: 0 0 auto;
  width: 1.7rem;
  height: 1.7rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}
.bottleneck-name { font-weight: 600; font-size: 13px; margin: 0 0 2px; }
.bottleneck-why { margin: 0; font-size: 12.5px; color: var(--ink-muted); max-width: 48rem; }

.phase { display: flex; gap: var(--space-4); padding-bottom: var(--space-6); position: relative; }
.phase:not(:last-child)::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 1.4rem;
  bottom: 0;
  width: 1px;
  background: var(--hairline);
}
.phase-marker {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--vscode-editor-background);
  margin-top: 0.35rem;
  z-index: 1;
}
.phase-body { min-width: 0; flex: 1; }
.phase h4 { margin: 0 0 var(--space-2); font-size: 13.5px; font-weight: 600; }
.outcome {
  font-size: 11.5px;
  color: var(--ink-muted);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  background: var(--surface-raised);
  border-radius: 4px;
  display: inline-block;
}

ul { margin: var(--space-2) 0; padding-left: 1.1rem; }
li { margin-bottom: var(--space-1); }
.assumptions li { font-size: 12.5px; color: var(--ink-muted); }

/* ---- Empty states ---- */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-12) var(--space-4);
  text-align: center;
  color: var(--ink-muted);
}
.empty-state svg { opacity: 0.4; }
.empty-state strong { color: var(--ink); font-size: 14px; font-weight: 600; }
.empty-state p { margin: 0; font-size: 12.5px; max-width: 30rem; }

footer {
  margin-top: var(--space-12);
  padding-top: var(--space-4);
  border-top: 1px solid var(--hairline);
  font-size: 11.5px;
  color: var(--ink-muted);
  max-width: 48rem;
}
`;

export const SIDEBAR_STYLES = `
${TOKENS}

body {
  margin: 0;
  padding: 14px 12px 24px;
  font-family: var(--vscode-font-family);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
:root {
  --surface: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 4%, transparent);
  --surface-raised: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 8%, transparent);
  --surface-sunken: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 2%, transparent);
  --hairline: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 13%, transparent);
  --hairline-strong: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 22%, transparent);
}

${BUTTONS}

h2 {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 20px 0 8px;
}
h2:first-child { margin-top: 0; }
p { margin: 0 0 10px; }
.muted { color: var(--ink-muted); font-size: 11.5px; line-height: 1.5; }

/* ---- Sign-in ---- */

.welcome { text-align: center; padding: 10px 0 16px; }
.welcome .mark-row { display: flex; justify-content: center; gap: 10px; margin-bottom: 12px; }
.welcome .mark-row > * {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
}
.welcome h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }

.account {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 10px;
  border: 1px solid var(--hairline);
  background: var(--surface);
  color: var(--ink);
  font-size: 12.5px;
  text-align: left;
}
.account:hover {
  background: var(--surface-raised);
  border-color: var(--hairline-strong);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}
.account .mark {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
}
.account .body { min-width: 0; flex: 1; }
.account .name { font-weight: 600; display: block; }
.account .detail { color: var(--ink-muted); font-size: 11px; display: block; }
.account .go { color: var(--ink-muted); flex: 0 0 auto; }
.account.connected { border-color: color-mix(in srgb, var(--good) 40%, transparent); }
.account .active-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); flex: 0 0 auto; }

button.action {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 6px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.action:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
button.action.ghost {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--hairline);
}
button.action.ghost:hover { background: var(--surface-raised); }
button.link {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 0;
  width: 100%;
  color: var(--ink-muted);
  font-size: 11.5px;
  text-align: left;
}
button.link:hover { color: var(--accent); }

/* ---- Live run ---- */

.status {
  padding: 12px;
  border-radius: 10px;
  margin-bottom: 10px;
  background: var(--surface);
  border: 1px solid var(--hairline);
}
.status .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.status .headline { font-weight: 600; font-size: 12.5px; flex: 1; }
.glyph { color: var(--accent); animation: spin 1.4s linear infinite; flex: 0 0 auto; }
@keyframes spin { to { transform: rotate(360deg); } }

.telemetry {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid var(--hairline);
  font-variant-numeric: tabular-nums;
}
.stat { display: flex; align-items: baseline; gap: 3px; }
.stat .v { font-size: 13px; font-weight: 600; }
.stat .k { font-size: 10px; color: var(--ink-muted); letter-spacing: 0.03em; }
.stat .arrow { font-size: 10px; color: var(--ink-muted); }
.budget { height: 3px; border-radius: 999px; margin-top: 8px; overflow: hidden; background: var(--surface-raised); }
.budget-fill { height: 100%; border-radius: 999px; transition: width 400ms ease; }
.status .activity {
  color: var(--ink-muted);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#stream {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 13rem;
  overflow-y: auto;
  color: var(--ink-muted);
  margin-top: 10px;
  padding: 10px;
  background: var(--surface-sunken);
  border-radius: 9px;
  border: 1px solid var(--hairline);
}
/* Before the model has said anything there is nothing to frame. */
#stream:empty { display: none; }
.warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--sev-medium);
  font-size: 11.5px;
  margin-bottom: 8px;
}
.warn:empty { display: none; }

/* ---- Last result ---- */

.result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  margin-bottom: 8px;
  background: var(--surface);
  border: 1px solid var(--hairline);
}
.result .grade {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  font-weight: 300;
  letter-spacing: -0.02em;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
}
.grade-A, .grade-B { color: var(--good); }
.grade-C { color: var(--sev-medium); }
.grade-D { color: var(--sev-high); }
.grade-F { color: var(--sev-critical); }
.result .body { min-width: 0; }
.result .count { font-weight: 600; font-size: 12.5px; }
.result .sum {
  color: var(--ink-muted);
  font-size: 11.5px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.footnote {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
  font-size: 11px;
  color: var(--ink-muted);
  line-height: 1.5;
}
`;
