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
  /* Work done by something other than the agent itself — a delegated search, an
     MCP server. Fixed, and deliberately not the brand: the brand is a blue now,
     and the trace already spends blue on searching. */
  --tone-external: #8b5cf6;

  --accent: var(--vscode-textLink-foreground, #3b9eff);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);

  /* Brand — a fixed identity, deliberately NOT derived from the editor theme.
     This is the one exception to the rule at the top of this file, and it is
     scoped: only the surfaces IronBase owns outright — the sign-in hero, the
     wordmark, the primary connect action — reach for these. Everything that
     shows the user's own code stays theme-derived so it still reads natively.
     The pair holds its contrast on light and dark alike, which is why the
     identity can be a constant rather than two. */
  --brand-1: #0f5e9c;
  --brand-2: #31a8f0;
  --brand-accent: #3ba3ee;
  --brand-contrast: #ffffff;
  --brand-soft: color-mix(in srgb, var(--brand-1) 15%, transparent);

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

/**
 * The sign-in surface, shared by the sidebar and the build panel.
 *
 * Lives here rather than in either sheet because both draw the same hero and
 * the same connect matrix from `webview/brand.ts` — a copy in each is how the
 * panel ended up looking like a different product from the sidebar that opened
 * it.
 */
const SIGN_IN = `
/* ---- Sign-in ---- */

/* The hero owns its surface: a fixed brand look rather than the editor theme,
   because this is the three-second first impression and it should read as a
   product, not a panel. */
.hero {
  text-align: center;
  padding: 20px 6px 22px;
  position: relative;
}
.hero::before {
  /* A soft brand glow behind the mark, so the identity has presence without a
     background image the CSP would block anyway. */
  content: "";
  position: absolute;
  inset: -8% 18% auto;
  height: 130px;
  background: radial-gradient(58% 100% at 50% 0, var(--brand-soft), transparent 72%);
  pointer-events: none;
}
/* The mark: a rounded tile carrying the one gradient, the white glyph on top. */
.brand-tile {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--brand-1), var(--brand-2));
  box-shadow: 0 10px 26px -10px var(--brand-1), inset 0 1px 0 rgba(255, 255, 255, 0.22);
}
.wordmark {
  display: inline-flex;
  font-weight: 750;
  font-size: 18px;
  letter-spacing: 0.24em;
  /* Flat and monochrome: the gradient lives on the mark alone, so the identity
     is one accent, not two competing ones. The tracked second half stays a hair
     lighter to keep the two words legible as one lockup. */
  margin-bottom: 16px;
  margin-left: 0.24em;
}
.wordmark .w1 { color: var(--ink); }
.wordmark .w2 { color: var(--ink-muted); }
.hero h1 {
  font-size: 17px;
  font-weight: 650;
  line-height: 1.32;
  letter-spacing: -0.02em;
  margin: 0 auto 10px;
  max-width: 21ch;
}
.hero .lede {
  color: var(--ink-muted);
  font-size: 12px;
  line-height: 1.55;
  margin: 0 auto;
  max-width: 31ch;
}

/* ---- Connect matrix ---- */

.connect-grid { display: flex; flex-direction: column; gap: 7px; }

.connect {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 12px;
  border-radius: 12px;
  border: 1px solid var(--hairline);
  background: var(--surface);
  transition: border-color 140ms ease, background 140ms ease;
}
.connect:hover { border-color: var(--hairline-strong); background: var(--surface-raised); }
.connect .mark {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
}
.connect .body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.connect .name { font-weight: 600; }
.connect .detail { color: var(--ink-muted); font-size: 11px; line-height: 1.4; }
.connect .methods { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

button.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 550;
  border: 1px solid var(--hairline-strong);
  color: var(--ink);
  background: transparent;
}
button.chip:hover { background: var(--surface-raised); border-color: var(--brand-accent); }
button.chip.primary {
  border-color: transparent;
  color: var(--brand-contrast);
  background: linear-gradient(100deg, var(--brand-1), var(--brand-2));
}
button.chip.primary:hover { filter: brightness(1.08); transform: translateY(-0.5px); }

.more { margin: 10px 0 0; }
.more > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  color: var(--ink-muted);
  font-size: 11.5px;
  padding: 7px 2px;
}
.more > summary::-webkit-details-marker { display: none; }
.more > summary .chev { transition: transform 140ms ease; flex: 0 0 auto; }
.more[open] > summary .chev { transform: rotate(90deg); }
.more .connect-grid { margin-top: 6px; }

/* The label above a block on a sign-in screen. */
h2.section {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 20px 0 8px;
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
${SIGN_IN}

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
`;

/**
 * The build panel.
 *
 * A transcript that has to stay readable while it grows, in a column that may
 * be 260px wide or 1200. Two rules carry most of it.
 *
 * Nothing is laid out on a single unwrapping row. The header and the composer
 * both used to be one flex line of a dozen controls, which is fine at 900px and
 * silently runs off the edge of a sidebar — the version of this that "broke on
 * resize" was exactly that. Every horizontal group now wraps, and every text
 * node that can grow has `min-width: 0` above it so flexbox is allowed to
 * shrink it rather than overflowing its parent.
 *
 * And the noise collapses while the decisions do not. Tool calls are dim single
 * lines; a permission card and the diff it carries take the full width, the
 * full contrast, and a shadow that lifts them off the page.
 */
export const CHAT_STYLES = `
${TOKENS}
${BUTTONS}
${SIGN_IN}

:root {
  --chat-radius: 10px;
  --head-h: 1px;
}

body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: 13.5px;
  line-height: 1.62;
  letter-spacing: -0.003em;
  color: var(--ink);
  background: var(--vscode-editor-background);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
#root { display: flex; flex-direction: column; height: 100vh; min-width: 0; }

/* Anything that can hold long text has to be allowed to shrink, or flexbox
   keeps it at its content width and pushes its siblings off the edge. */
.chat-head, .head-row, .head-meters, .thread, .composer,
.card, .card-head, .trace, .trace-row, .composer .row { min-width: 0; }

/* ---- Header ---- */
.chat-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--hairline);
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--vscode-editor-foreground) 4%, var(--vscode-editor-background)),
    var(--surface-sunken)
  );
  flex: 0 0 auto;
}
.head-row { display: flex; align-items: center; gap: var(--space-2); }
.chat-head .title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: 12.5px;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.chat-head svg { flex: 0 0 auto; }

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: 0 0 auto;
  padding: 0.18rem 0.55rem 0.18rem 0.42rem;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--hairline-strong);
  color: var(--ink-muted);
  white-space: nowrap;
}
.mode-chip.architect {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  background: var(--accent-soft);
}
.mode-chip.build {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 38%, transparent);
  background: color-mix(in srgb, var(--good) 12%, transparent);
}

/* The meters wrap among themselves rather than pushing the row wider. */
.head-meters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); }
.meter {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 11px;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  max-width: 100%;
}
.meter .glyph { opacity: 0.6; flex: 0 0 auto; }
.meter > span { overflow: hidden; text-overflow: ellipsis; }
.meter.warn-text { color: var(--sev-medium); }
.meter.warn-text .glyph { opacity: 1; }
.meter.busy .glyph { opacity: 1; color: var(--accent); }
button.meter {
  border: none;
  padding: 0.1rem 0.3rem;
  margin: -0.1rem -0.3rem;
  border-radius: var(--radius-sm);
  font-size: 11px;
}
button.meter:hover { background: var(--surface-raised); color: var(--ink); }
button.meter.changed { color: var(--sev-medium); }

.btn.stop {
  border-color: color-mix(in srgb, var(--sev-critical) 45%, transparent);
  color: var(--sev-critical);
}
.btn.stop:hover { background: color-mix(in srgb, var(--sev-critical) 12%, transparent); }
.btn.send { gap: var(--space-2); }

/* ---- Todo rail ---- */
.todos {
  flex: 0 0 auto;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface);
  max-height: 34vh;
  overflow-y: auto;
}
.todos h3 {
  margin: 0 0 var(--space-2);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.todo { display: flex; align-items: baseline; gap: var(--space-2); font-size: 12px; padding: 2px 0; }
.todo .box { flex: 0 0 auto; width: 13px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.todo .label { min-width: 0; overflow-wrap: anywhere; }
.todo.done { color: var(--ink-muted); }
.todo.done .label { text-decoration: line-through; text-decoration-color: var(--hairline-strong); }
.todo.done .box { color: var(--good); }
.todo.active { color: var(--ink); font-weight: 600; }
.todo.active .box { color: var(--accent); }

/* ---- Thread ---- */
.thread { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: var(--space-4); }
.thread > * { max-width: 60rem; margin-inline: auto; }

.bubble-user {
  position: relative;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  border-radius: var(--chat-radius);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-shadow: var(--shadow-sm);
}
.assistant { margin-bottom: var(--space-4); overflow-wrap: anywhere; }
.assistant p { margin: 0 0 0.7em; }
.assistant p:last-child { margin-bottom: 0; }
.assistant ul, .assistant ol { margin: 0 0 0.7em; padding-left: 1.25em; }
.assistant li { margin: 0.15em 0; }
.assistant code {
  font-family: var(--mono);
  font-size: 0.92em;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  border-radius: 4px;
  padding: 0.05em 0.32em;
  overflow-wrap: anywhere;
}
.assistant pre {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  background: var(--surface-sunken);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  overflow-x: auto;
  margin: 0 0 0.7em;
}
.assistant pre code { background: none; border: none; padding: 0; }

/* ---- Tool trace ---- */
/*
 * One run of looking, drawn as a thread of steps rather than a stack of lines.
 *
 * The spine is the whole idea: a hairline down the column of marks, so a dozen
 * reads read as one movement with a beginning and an end, and the cards on
 * either side of it read as the things that came out of that movement. Every
 * row is on the same four-column grid, which is what lets the eye run down the
 * verbs, or down the paths, or down the results, without reading any of the
 * others.
 */
.trace {
  position: relative;
  margin: var(--space-3) 0;
  padding: var(--space-1) 0;
}
/* Behind the marks, stopping half a row short at each end so it reads as a
   thread through them rather than a rule the first mark is sitting on. */
.trace::before {
  content: "";
  position: absolute;
  left: 9.5px;
  top: 16px;
  bottom: 14px;
  width: 1px;
  background: linear-gradient(
    to bottom,
    transparent,
    var(--hairline) 12%,
    var(--hairline) 88%,
    transparent
  );
  pointer-events: none;
}

.trace-row {
  position: relative;
  display: grid;
  grid-template-columns: 20px 4.4rem minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  margin-inline: -6px;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--ink-muted);
}
.trace-row:hover { background: var(--surface); color: var(--ink); }
.trace-row.folded { display: none; }

/* The mark sits in a tile so it can carry a tone and cover the spine — the
   line has to pass behind the marks, not through the gaps between them. */
.trace-row .chip {
  position: relative;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  border: 1px solid var(--hairline);
  background: var(--vscode-editor-background);
  color: var(--ink-muted);
}
.trace-row.tone-find .chip {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  background: color-mix(in srgb, var(--accent) 9%, var(--vscode-editor-background));
}
.trace-row.tone-agent .chip {
  color: var(--tone-external);
  border-color: color-mix(in srgb, var(--tone-external) 32%, transparent);
  background: color-mix(in srgb, var(--tone-external) 10%, var(--vscode-editor-background));
}
.trace-row.bad .chip {
  color: var(--sev-critical);
  border-color: color-mix(in srgb, var(--sev-critical) 38%, transparent);
  background: color-mix(in srgb, var(--sev-critical) 10%, var(--vscode-editor-background));
}

.trace-row .verb {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trace-row .arg {
  min-width: 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  opacity: 0.82;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A path is read from its end, so it is the start that gives way. */
.trace-row .arg.path { direction: rtl; text-align: left; }
.trace-row .note {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
  white-space: nowrap;
}
.trace-row.bad .note { color: var(--sev-critical); opacity: 1; }

/* A step still in flight: the mark breathes a ring, and the argument carries a
   slow sweep. Both are pure decoration, so both stop under reduced motion and
   leave a row that still says everything it said before. */
.trace-row.running .chip::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  animation: trace-ping 1.6s ease-out infinite;
}
@keyframes trace-ping {
  0% { opacity: 0.9; transform: scale(0.82); }
  70% { opacity: 0; transform: scale(1.15); }
  100% { opacity: 0; transform: scale(1.15); }
}
.trace-row.running .arg {
  opacity: 1;
  background: linear-gradient(
    100deg,
    var(--ink-muted) 34%,
    var(--ink) 50%,
    var(--ink-muted) 66%
  ) 0 0 / 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: trace-sweep 1.9s linear infinite;
}
@keyframes trace-sweep {
  from { background-position: 150% 0; }
  to { background-position: -150% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .trace-row.running .arg {
    background: none;
    -webkit-text-fill-color: currentColor;
    color: var(--ink);
  }
  .trace-row.running .chip::after { display: none; }
}

/* The fold. One line standing in for however many steps have scrolled past. */
/* Same grid as a row, so its bead sits on the spine with all the others. */
.trace-more {
  display: grid;
  grid-template-columns: 20px auto auto;
  align-items: center;
  gap: var(--space-2);
  margin-inline: -6px;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  font-size: 10.5px;
  color: var(--ink-muted);
  border: none;
  text-align: left;
}
/* An author display rule beats the UA sheet's hidden-attribute rule, so the
   fold has to say so itself — without this it draws an empty bead whenever
   there is nothing folded. */
.trace-more[hidden] { display: none; }
.trace-more::before {
  content: "";
  width: 5px;
  height: 5px;
  justify-self: center;
  border-radius: 50%;
  background: var(--hairline-strong);
}
.trace-more .chev { transform: rotate(90deg); opacity: 0.7; }
.trace-more:hover { background: var(--surface); color: var(--ink); }

/* ---- Cards ---- */
.card {
  border: 1px solid var(--hairline);
  border-radius: var(--chat-radius);
  background: var(--surface);
  margin: var(--space-3) 0;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: 12px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--hairline);
  flex-wrap: wrap;
}
.card-head .path {
  min-width: 0;
  flex: 1 1 8rem;
  text-align: left;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  border: none;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}
.card-head .path:hover { color: var(--accent); text-decoration: underline; }
.card-head .spacer { flex: 1 1 auto; }
.card-head .verb {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
/* The mark is the fastest read on a card, so it carries the colour the words
   would otherwise have to. */
.card-head .glyph { flex: 0 0 auto; opacity: 0.75; }
.card-head .glyph.create { color: var(--good); opacity: 1; }
.card-head .glyph.delete { color: var(--sev-critical); opacity: 1; }
.card-head .glyph.edit { color: var(--accent); opacity: 1; }
.counts { flex: 0 0 auto; font-family: var(--mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.counts .add { color: var(--good); }
.counts .del { color: var(--sev-critical); }
.card .why {
  padding: var(--space-2) var(--space-3);
  color: var(--ink-muted);
  font-size: 11.5px;
  border-bottom: 1px solid var(--hairline);
  overflow-wrap: anywhere;
}
.card.reverted { opacity: 0.55; }
.card.reverted .card-head::after { content: "reverted"; font-size: 10px; color: var(--ink-muted); }

/* ---- Diff ---- */
.diff { font-family: var(--mono); font-size: 11.5px; line-height: 1.5; overflow: auto; max-height: 22rem; }
.diff-row { display: flex; white-space: pre; min-width: min-content; }
.diff-row .no {
  position: sticky;
  left: 0;
  flex: 0 0 3rem;
  text-align: right;
  padding-right: var(--space-2);
  color: var(--ink-muted);
  opacity: 0.55;
  user-select: none;
  font-variant-numeric: tabular-nums;
  background: inherit;
}
.diff-row .txt { flex: 1 0 auto; padding-right: var(--space-3); }
.diff-row.add { background: color-mix(in srgb, var(--good) 13%, transparent); }
.diff-row.add .txt::before { content: "+"; color: var(--good); }
.diff-row.remove { background: color-mix(in srgb, var(--sev-critical) 13%, transparent); }
.diff-row.remove .txt::before { content: "-"; color: var(--sev-critical); }
.diff-row.context { background: var(--surface); }
.diff-row.context .txt::before { content: " "; }
.diff-gap { padding: 2px var(--space-3) 2px 3rem; color: var(--ink-muted); opacity: 0.5; font-size: 10.5px; }

/* ---- Command ---- */
.cmd { font-family: var(--mono); font-size: 11.5px; }
.cmd .line {
  padding: var(--space-2) var(--space-3);
  font-weight: 600;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.cmd .line::before { content: "$ "; color: var(--ink-muted); }
.cmd .out {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--hairline);
  background: var(--surface-sunken);
  max-height: 18rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.45;
}
/* A command that has printed nothing yet should not reserve a band of empty
   sunken surface for the output it may never have. */
.cmd .out:empty { display: none; }

/*
 * How it ended, in the header where it gets scanned for — not under however
 * many lines of output the command happened to print.
 */
.pill {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-family: var(--vscode-font-family);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  border: 1px solid var(--hairline-strong);
  color: var(--ink-muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill::before {
  content: "";
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.pill.ok {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 38%, transparent);
  background: color-mix(in srgb, var(--good) 10%, transparent);
}
.pill.bad {
  color: var(--sev-critical);
  border-color: color-mix(in srgb, var(--sev-critical) 38%, transparent);
  background: color-mix(in srgb, var(--sev-critical) 10%, transparent);
}
.pill.running {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  background: var(--accent-soft);
}
.pill.running::before { animation: pill-breathe 1.4s ease-in-out infinite; }
@keyframes pill-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
/* A running command is the live thing on screen; the card says so. */
.cmd-card:has(.pill.running) {
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}

/* ---- Permission ---- */
.ask {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent), var(--shadow-md);
  background: var(--surface-raised);
}
.ask .card-head { background: var(--accent-soft); border-bottom-color: color-mix(in srgb, var(--accent) 25%, transparent); }
.ask.danger { border-color: color-mix(in srgb, var(--sev-critical) 50%, transparent); }
.ask.danger .card-head { background: color-mix(in srgb, var(--sev-critical) 12%, transparent); }
.ask .actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--hairline);
}
.ask .actions .spacer { flex: 1 1 auto; }

/* ---- Plan ---- */
.plan { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.plan h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.plan .body { padding: var(--space-4); }
.plan .summary { color: var(--ink-muted); margin: var(--space-2) 0 var(--space-4); }
.plan ol { margin: 0; padding-left: 1.25em; }
.plan ol li { margin-bottom: var(--space-3); }
.plan .step-title { font-weight: 600; }
.plan .files { font-family: var(--mono); font-size: 11px; color: var(--accent); overflow-wrap: anywhere; }
.plan .detail { color: var(--ink-muted); font-size: 12px; }
.plan h4 {
  margin: var(--space-4) 0 var(--space-1);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.plan .risk { color: var(--sev-high); }
.plan .actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--hairline);
  background: var(--surface-raised);
}
.plan .actions .spacer { flex: 1 1 auto; }

/* ---- Notices and the final report ---- */
.notice-line {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin: var(--space-2) 0;
  border: 1px solid;
  overflow-wrap: anywhere;
}
.notice-line svg { flex: 0 0 auto; margin-top: 2px; }
.notice-line.warning { color: var(--sev-medium); border-color: color-mix(in srgb, var(--sev-medium) 32%, transparent); background: color-mix(in srgb, var(--sev-medium) 9%, transparent); }
.notice-line.error { color: var(--sev-critical); border-color: color-mix(in srgb, var(--sev-critical) 32%, transparent); background: color-mix(in srgb, var(--sev-critical) 9%, transparent); }
.done-card { border-color: color-mix(in srgb, var(--good) 35%, transparent); }
.done-card .card-head { background: color-mix(in srgb, var(--good) 10%, transparent); color: var(--good); }
.done-card .card-head .glyph { color: var(--good); opacity: 1; }
.done-card .body { padding: var(--space-4); }

/* ---- Composer ---- */
/*
 * One surface, with its controls inside it. The textarea has no border of its
 * own: the box takes the focus ring, so typing lights up the whole control
 * rather than a rectangle inside another rectangle.
 */
.composer {
  flex: 0 0 auto;
  padding: var(--space-2) var(--space-4) var(--space-4);
  background: var(--vscode-editor-background);
}
.composer .inner {
  max-width: 60rem;
  margin-inline: auto;
  min-width: 0;
  /* The bar below collapses its labels against *this* width, not the window's:
     a docked sidebar is narrow no matter how wide the screen is. */
  container: composer / inline-size;
}

.composer-box {
  position: relative;
  border: 1px solid var(--hairline-strong);
  border-radius: 16px;
  background: var(--vscode-input-background, var(--surface));
  box-shadow: var(--shadow-sm);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.composer-box:focus-within {
  border-color: color-mix(in srgb, var(--accent) 65%, transparent);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-sm);
}
.composer-box.signed-out { padding: var(--space-4); display: grid; gap: var(--space-3); justify-items: start; }

.composer textarea {
  display: block;
  width: 100%;
  min-height: 3.2rem;
  max-height: 14rem;
  resize: none;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink);
  background: transparent;
  border: none;
  padding: 0.85rem 1rem 0.35rem;
}
.composer textarea:focus { outline: none; }
.composer textarea::placeholder { color: var(--ink-muted); opacity: 0.72; }

.composer-bar {
  display: flex;
  /* Never wrap. The send button is the last child, so wrapping is what dropped
     it onto a line of its own when the box got tight. Held on one line, the
     shrinkable items (the spacer, then the model name) give up their width
     first, and the labels collapse to icons below — the round button stays put. */
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
  padding: 0.4rem 0.5rem 0.5rem;
  min-width: 0;
}
.composer-bar .spacer { flex: 1 1 auto; min-width: 0; }

/*
 * Narrow composer: spend the words, keep the marks. Each chip still carries its
 * icon and its tooltip, so nothing becomes unreachable — it just stops paying
 * for a label there is no room for. Two steps: drop the setting labels first,
 * then the model name, so the round send button never has to leave the row.
 */
@container composer (max-width: 360px) {
  .composer-bar .bar-chip span { display: none; }
  .composer-bar .bar-chip { padding: 0.3rem; }
}
@container composer (max-width: 300px) {
  .composer-bar .model-pick > span { display: none; }
  .composer-bar .model-pick { padding: 0.3rem; }
}

/* A chip is a setting you can see and change without leaving the box. */
.bar-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex: 0 0 auto;
  padding: 0.3rem 0.6rem;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ink-muted);
  border: 1px solid transparent;
  white-space: nowrap;
}
.bar-chip:hover { background: var(--surface-raised); color: var(--ink); }
.bar-chip.on {
  color: var(--good);
  background: color-mix(in srgb, var(--good) 12%, transparent);
  border-color: color-mix(in srgb, var(--good) 32%, transparent);
}
.bar-chip svg { flex: 0 0 auto; }
/* The caret is the only thing saying this chip opens something rather than
   toggling in place, so it stays when the label is spent at narrow widths. */
.bar-chip.mode-pick .caret { transform: rotate(90deg); opacity: 0.6; margin-left: -0.15rem; }
.bar-chip.mode-pick:hover .caret { opacity: 1; }

/* Anchored to the mode chip at the left of the bar, not the model pick. */
.mode-menu { right: auto; left: 0; min-width: min(17rem, 100%); }
.mode-menu .popover-row .detail { white-space: normal; line-height: 1.35; }

.model-pick {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex: 0 1 auto;
  min-width: 0;
  padding: 0.3rem 0.55rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ink-muted);
  background: none;
}
.model-pick:hover:not(:disabled) { background: var(--surface-raised); color: var(--ink); }
.model-pick > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-pick svg { flex: 0 0 auto; }

/* The send button, round, the way every composer signals "go". */
.circle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: none;
}
.circle-btn.send {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.circle-btn.send:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.circle-btn.stop { background: var(--sev-critical); color: #fff; }
.circle-btn.stop:hover { filter: brightness(1.1); }

/* ---- Popover ---- */
/*
 * Anchored above its button, because the button is at the bottom of the view.
 * VS Code's own quick pick opens at the top of the window, which for a control
 * down here means the eye has to travel the whole height to find the answer.
 */
.popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  z-index: 20;
  /* Never wider than the bar it hangs off, or it escapes the left edge in a
     narrow sidebar: pinning the right edge only holds that one side. */
  min-width: min(15rem, 100%);
  max-width: min(22rem, 100%);
  max-height: 22rem;
  overflow-y: auto;
  padding: var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-md);
  background: var(--vscode-editorWidget-background, var(--surface-raised));
  box-shadow: var(--shadow-md);
}
.popover-group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.popover-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-sm);
  border: none;
  text-align: left;
  min-width: 0;
}
.popover-row:hover { background: var(--surface-raised); }
.popover-row.current { color: var(--accent); }
.popover-row svg { flex: 0 0 auto; }
.popover-row .body { display: grid; min-width: 0; }
.popover-row .name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popover-row .detail {
  font-size: 10.5px;
  color: var(--ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popover-row .tick { margin-left: auto; color: var(--accent); }
.popover-empty { padding: var(--space-3); font-size: 12px; color: var(--ink-muted); }

.toggle { display: inline-flex; align-items: center; gap: var(--space-2); font-size: 11.5px; color: var(--ink-muted); cursor: pointer; white-space: nowrap; }
.toggle input { accent-color: var(--accent); }
.hint { font-size: 11.5px; color: var(--ink-muted); margin: 0; }

/* ---- Start page ---- */
/*
 * The panel's first screen, wearing the same mark and the same connect matrix
 * as the sidebar — see SIGN_IN, which both sheets pull in. Only the widths and
 * the block above the matrix belong to this surface.
 */
.empty { max-width: 34rem; margin: 4vh auto 0; padding: 0 var(--space-2) var(--space-6); }
.empty .hero { padding-top: 8px; }
.empty .hero h1 { max-width: 24ch; }
.empty .hero .lede { max-width: 44ch; }
.empty h2.section { text-align: center; margin-top: 24px; }

.examples { display: grid; gap: var(--space-2); }
.examples button {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  color: var(--ink-muted);
  font-size: 12px;
  text-align: left;
  line-height: 1.45;
  background: var(--surface);
}
.examples button:hover { background: var(--surface-raised); color: var(--ink); border-color: var(--accent); }
.empty .footnote { text-align: center; }

/* ---- Narrow ---- */
/*
 * A docked sidebar is often under 300px. Below that the meters' labels are the
 * first thing worth spending, since each still has its mark and its tooltip.
 */
@media (max-width: 340px) {
  .chat-head, .todos { padding-left: var(--space-3); padding-right: var(--space-3); }
  .thread, .composer { padding-left: var(--space-3); padding-right: var(--space-3); }
  .trace-row { grid-template-columns: 20px minmax(0, auto) minmax(0, 1fr) auto; }
  .mode-chip span { display: none; }
  .mode-chip { padding: 0.2rem 0.4rem; }
  .head-meters { gap: var(--space-1) var(--space-2); }
}
`;
