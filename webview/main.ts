import {
  CATEGORY_LABELS,
  SEVERITY_ORDER,
  type AnalysisReport,
  type Finding,
  type Severity,
} from "../src/engine/findings";
import type { HostMessage, WebviewMessage } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

/**
 * Severity uses the fixed status palette. Each colour is always rendered next to
 * its written label, so identity never rests on colour alone.
 */
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "report") render(event.data.report);
});

vscode.postMessage({ type: "ready" });

function render(report: AnalysisReport): void {
  root.replaceChildren(
    header(report),
    ...(report.scalability ? [scalabilitySection(report.scalability)] : []),
    findingsSection(report.findings),
    footer(report),
  );
}

function header(report: AnalysisReport): HTMLElement {
  const el = document.createElement("header");

  const row = div("grade-row");
  const grade = div(`grade grade-${report.grade}`);
  grade.textContent = report.grade;
  grade.setAttribute("aria-label", `Overall grade ${report.grade}`);

  const titles = div("titles");
  titles.append(
    tag("p", "Architecture review", "eyebrow"),
    tag("h1", report.workspaceName),
    tag("p", `${report.provider} · ${report.model}`, "meta"),
  );
  row.append(grade, titles);
  el.append(row);
  el.append(tag("p", report.summary, "summary"));

  if (report.incompleteReason) {
    el.append(tag("p", report.incompleteReason, "notice"));
  }

  const counts = countBySeverity(report.findings);
  const present = SEVERITY_ORDER.filter((s) => counts[s] > 0);
  if (present.length > 0) {
    const row2 = div("counts");
    for (const severity of present) {
      const item = div("count");
      const dot = div("dot");
      dot.style.background = SEVERITY_COLOR[severity];
      item.append(dot, tag("span", String(counts[severity]), "n"), tag("span", severity, "label"));
      row2.append(item);
    }
    el.append(row2);
  }

  const toolbar = div("toolbar");
  toolbar.append(
    button("Export as Markdown", () =>
      vscode.postMessage({ type: "command", command: "ironbase.exportReport" }),
    ),
    button(
      "Re-run review",
      () => vscode.postMessage({ type: "command", command: "ironbase.analyze" }),
      "secondary",
    ),
  );
  el.append(toolbar);
  return el;
}

function findingsSection(findings: Finding[]): HTMLElement {
  const section = document.createElement("section");
  section.append(tag("h2", "Findings"));

  if (findings.length === 0) {
    section.append(
      tag("p", "No architecture problems were reported for this workspace.", "empty"),
    );
    return section;
  }

  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const heading = tag("h3");
    const dot = div("dot");
    dot.style.background = SEVERITY_COLOR[severity];
    heading.append(dot, document.createTextNode(`${severity} · ${group.length}`));
    section.append(heading);
    for (const finding of group) section.append(findingCard(finding));
  }
  return section;
}

function findingCard(finding: Finding): HTMLElement {
  const details = document.createElement("details");
  details.className = "finding";
  if (finding.severity === "critical" || finding.severity === "high") details.open = true;

  const summary = document.createElement("summary");
  summary.append(
    chevron(),
    tag("span", finding.title, "finding-title"),
    tag(
      "span",
      CATEGORY_LABELS[finding.category] + (finding.effort ? ` · ${finding.effort}` : ""),
      "tag",
    ),
  );
  details.append(summary);

  const body = div("finding-body");
  body.append(tag("p", finding.explanation));

  const fix = tag("p", "", "fix");
  const label = document.createElement("strong");
  label.textContent = "Fix — ";
  fix.append(label, document.createTextNode(finding.recommendation));
  body.append(fix);

  if (finding.evidence.length > 0) {
    const list = div("evidence");
    for (const evidence of finding.evidence) {
      const link = document.createElement("a");
      link.className = "ref";
      link.textContent = evidence.startLine
        ? `${evidence.file}:${evidence.startLine}`
        : evidence.file;
      link.addEventListener("click", () =>
        vscode.postMessage({
          type: "openFile",
          file: evidence.file,
          line: evidence.startLine,
        }),
      );
      list.append(link);
    }
    body.append(list);
  }

  details.append(body);
  return details;
}

function scalabilitySection(
  scalability: NonNullable<AnalysisReport["scalability"]>,
): HTMLElement {
  const section = document.createElement("section");
  section.append(tag("h2", "Scalability"));

  const card = div("capacity-card");

  const head = div("capacity-head");
  const now = div("capacity-block");
  now.append(
    tag("p", "Estimated capacity today", "label"),
    tag("p", scalability.estimatedCurrentCapacity, "capacity-value"),
  );
  const target = div("capacity-block right");
  target.append(
    tag("p", "Target", "label"),
    tag("p", scalability.target, "capacity-value target"),
  );
  head.append(now, target);
  card.append(head);

  card.append(capacityMeter(scalability.estimatedCurrentCapacity, scalability.target));

  if (scalability.assumptions.length > 0) {
    const block = div("assumptions");
    block.append(tag("p", "What this estimate assumes", "label"));
    block.append(bulletList(scalability.assumptions));
    card.append(block);
  }
  section.append(card);

  if (scalability.bottlenecks.length > 0) {
    section.append(tag("h3", "What caps it, most limiting first"));
    for (const bottleneck of scalability.bottlenecks) {
      const row = div("bottleneck");
      row.append(tag("div", String(bottleneck.rank), "rank"));
      const body = div("bottleneck-body");
      body.append(
        tag("p", bottleneck.component, "bottleneck-name"),
        tag("p", bottleneck.why, "bottleneck-why"),
      );
      row.append(body);
      section.append(row);
    }
  }

  if (scalability.roadmap.length > 0) {
    section.append(tag("h3", "How to close the gap"));
    for (const phase of scalability.roadmap) {
      const block = div("phase");
      block.append(div("phase-marker"));
      const body = div("phase-body");
      body.append(tag("h4", phase.phase));
      body.append(bulletList(phase.actions));
      body.append(tag("p", `Expected after this phase: ${phase.expectedCapacity}`, "outcome"));
      block.append(body);
      section.append(block);
    }
  }
  return section;
}

/**
 * A meter — a single ratio against a limit — rather than a dial gauge.
 * The fill carries severity and the track is a dimmer step of the same colour,
 * so the state reads across the whole bar and not just the filled portion.
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

  // Below a tenth of target is critical, below half is serious, below target is
  // a warning, at or above target is good.
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
  fill.style.width = `${((ratio ?? 0.04) * 100).toFixed(1)}%`;
  meter.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
  meter.append(fill);

  const caption = div("meter-caption");
  if (ratio === undefined) {
    caption.append(
      tag("span", "The estimate is not a plain number, so the bar is indicative only."),
    );
  } else if (ratio >= 1) {
    caption.append(tag("span", "The current estimate already meets the target."));
  } else {
    const shortfall = target! / Math.max(current!, 1);
    caption.append(
      tag("span", `About ${formatMultiple(shortfall)} short of the target`),
      tag("span", `${Math.round(ratio * 100)}% of the way there`),
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

function footer(report: AnalysisReport): HTMLElement {
  const el = document.createElement("footer");
  el.textContent =
    `Generated ${new Date(report.generatedAt).toLocaleString()}. ` +
    "Capacity figures are read from the code, not measured — treat them as a starting point for your own load testing.";
  return el;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 8 12");
  svg.setAttribute("class", "chev");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1.5 1.5 L6 6 L1.5 10.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
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

function bulletList(items: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.append(li);
  }
  return ul;
}

function button(
  text: string,
  onClick: () => void,
  className?: string,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = text;
  if (className) el.className = className;
  el.addEventListener("click", onClick);
  return el;
}
