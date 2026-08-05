/**
 * The icon set, drawn as inline SVG.
 *
 * Inline rather than a font or sprite sheet for two reasons: the webview runs
 * under a CSP that blocks every external resource, and icons that inherit
 * `currentColor` survive a theme switch without a second asset. Brand marks keep
 * their own colour, because a Claude logo tinted to match the sidebar stops
 * being recognisable — which is the entire job of a brand mark on a sign-in row.
 */

const NS = "http://www.w3.org/2000/svg";

export type IconName =
  | "claude"
  | "chatgpt"
  | "gemini"
  | "key"
  | "server"
  | "signIn"
  | "signOut"
  | "switchAccount"
  | "play"
  | "gauge"
  | "graph"
  | "wrench"
  | "download"
  | "refresh"
  | "search"
  | "check"
  | "alert"
  | "chevron"
  | "file"
  | "folder"
  | "layers"
  | "cycle"
  | "copy"
  | "diff"
  | "spinner"
  | "close"
  | "zoomIn"
  | "zoomOut"
  | "fit";

interface Glyph {
  /** Square viewBox edge length. */
  box: number;
  /** Filled paths — used by the brand marks. */
  fills?: Array<{ d: string; color?: string }>;
  /** Stroked paths — used by the interface icons. */
  strokes?: string[];
  /** Circles, for the few glyphs where a path would be silly. */
  circles?: Array<{ cx: number; cy: number; r: number; fill?: boolean }>;
  width?: number;
  /** Renders the brand gradient behind fills. */
  gradient?: [string, string];
}

const GLYPHS: Record<IconName, Glyph> = {
  // --- Brand marks ---------------------------------------------------------

  /**
   * Anthropic's radial burst. Three tapered spoke pairs, drawn as filled
   * wedges so it stays solid at 16px where thin strokes would disappear.
   */
  claude: {
    box: 24,
    fills: [
      {
        d:
          "M12 1.6 L13.5 9.1 L12 10.6 L10.5 9.1 Z " +
          "M12 22.4 L10.5 14.9 L12 13.4 L13.5 14.9 Z " +
          "M1.6 12 L9.1 10.5 L10.6 12 L9.1 13.5 Z " +
          "M22.4 12 L14.9 13.5 L13.4 12 L14.9 10.5 Z " +
          "M4.7 4.7 L10.6 9.4 L10.6 11.5 L8.5 11.5 Z " +
          "M19.3 19.3 L13.4 14.6 L13.4 12.5 L15.5 12.5 Z " +
          "M19.3 4.7 L14.6 10.6 L12.5 10.6 L12.5 8.5 Z " +
          "M4.7 19.3 L9.4 13.4 L11.5 13.4 L11.5 15.5 Z",
        color: "#d97757",
      },
    ],
  },

  /**
   * OpenAI's knot, approximated as six overlapping rounded lobes on a hexagonal
   * axis. Not the exact spline, but at icon size it reads correctly, and it
   * inherits currentColor so it works on light and dark alike.
   */
  chatgpt: {
    box: 24,
    strokes: [
      "M12 3.4 A4.3 4.3 0 0 1 16.3 7.7 L16.3 12",
      "M19.4 7.9 A4.3 4.3 0 0 1 17.3 13.7 L13.6 15.9",
      "M19.4 16.1 A4.3 4.3 0 0 1 13.6 18.2 L10 16.1",
      "M12 20.6 A4.3 4.3 0 0 1 7.7 16.3 L7.7 12",
      "M4.6 16.1 A4.3 4.3 0 0 1 6.7 10.3 L10.4 8.1",
      "M4.6 7.9 A4.3 4.3 0 0 1 10.4 5.8 L14 7.9",
    ],
  },

  /** Google's four-pointed spark, with the Gemini gradient. */
  gemini: {
    box: 24,
    gradient: ["#4489f8", "#a259e8"],
    fills: [
      {
        d:
          "M12 2 C12 7.5 16.5 12 22 12 C16.5 12 12 16.5 12 22 " +
          "C12 16.5 7.5 12 2 12 C7.5 12 12 7.5 12 2 Z",
      },
    ],
  },

  // --- Account actions -----------------------------------------------------

  /**
   * Stands in for the brand marks of the key-based providers.
   *
   * A wrong logo is worse than an honest generic one, and at sign-in time the
   * useful distinction is not whose logo it is — the row says that in words —
   * but what connecting will ask of you: a key here, a local server below.
   */
  key: {
    box: 24,
    strokes: [
      "M14.5 9.5 A4 4 0 1 0 10.9 13.1 L11 13 L13 15 L11 17 L13 19 L15.5 16.5 V13.5 L14.5 12.5",
    ],
    circles: [{ cx: 15.5, cy: 8.5, r: 1.4, fill: true }],
  },
  server: {
    box: 24,
    strokes: [
      "M4.5 5.5 H19.5 A1 1 0 0 1 20.5 6.5 V10 A1 1 0 0 1 19.5 11 H4.5 A1 1 0 0 1 3.5 10 V6.5 A1 1 0 0 1 4.5 5.5 Z",
      "M4.5 13 H19.5 A1 1 0 0 1 20.5 14 V17.5 A1 1 0 0 1 19.5 18.5 H4.5 A1 1 0 0 1 3.5 17.5 V14 A1 1 0 0 1 4.5 13 Z",
    ],
    circles: [
      { cx: 7, cy: 8.25, r: 1, fill: true },
      { cx: 7, cy: 15.75, r: 1, fill: true },
    ],
  },
  signIn: {
    box: 24,
    strokes: [
      "M14 3.5 H18.5 A1.5 1.5 0 0 1 20 5 V19 A1.5 1.5 0 0 1 18.5 20.5 H14",
      "M10 8 L14 12 L10 16",
      "M14 12 H3.5",
    ],
  },
  signOut: {
    box: 24,
    strokes: [
      "M10 3.5 H5.5 A1.5 1.5 0 0 0 4 5 V19 A1.5 1.5 0 0 0 5.5 20.5 H10",
      "M16.5 8 L20.5 12 L16.5 16",
      "M20.5 12 H9",
    ],
  },
  /**
   * Two arrows passing each other — "use the other one", not "reload". Drawn
   * flat rather than as two little avatars: at 13px the avatar version turns
   * into a grey smudge, and the swap arrows stay legible at any size.
   */
  switchAccount: {
    box: 24,
    strokes: [
      "M3.5 8.5 H17",
      "M13.5 5 L17 8.5 L13.5 12",
      "M20.5 15.5 H7",
      "M10.5 12 L7 15.5 L10.5 19",
    ],
  },

  // --- Interface -----------------------------------------------------------

  play: {
    box: 24,
    strokes: ["M8 4.8 L19 12 L8 19.2 Z"],
  },
  gauge: {
    box: 24,
    strokes: ["M3.5 18 A9 9 0 1 1 20.5 18", "M12 12 L16.5 8.5"],
    circles: [{ cx: 12, cy: 12, r: 1.3, fill: true }],
  },
  graph: {
    box: 24,
    strokes: ["M8.5 6.5 H15.5", "M6.5 9 V15", "M17.5 9 V15", "M8.5 17.5 H15.5"],
    circles: [
      { cx: 5, cy: 7, r: 2.6 },
      { cx: 19, cy: 7, r: 2.6 },
      { cx: 5, cy: 17, r: 2.6 },
      { cx: 19, cy: 17, r: 2.6 },
    ],
  },
  wrench: {
    box: 24,
    strokes: [
      "M15.6 4.2 A5.2 5.2 0 0 0 9.4 11.3 L4 16.7 A2 2 0 0 0 6.8 19.5 L12.2 14.1 A5.2 5.2 0 0 0 19.3 7.9 L16.2 11 L13 10.3 L12.3 7.1 Z",
    ],
  },
  download: {
    box: 24,
    strokes: ["M12 3.5 V15", "M7.5 10.5 L12 15 L16.5 10.5", "M4.5 19.5 H19.5"],
  },
  refresh: {
    box: 24,
    strokes: [
      "M20 12 A8 8 0 1 1 17 5.8",
      "M17.2 3 V6.4 H13.8",
    ],
  },
  search: {
    box: 24,
    strokes: ["M20 20 L15.6 15.6"],
    circles: [{ cx: 10.5, cy: 10.5, r: 6.5 }],
  },
  check: {
    box: 24,
    strokes: ["M4.5 12.5 L9.5 17.5 L19.5 6.5"],
  },
  alert: {
    box: 24,
    strokes: ["M12 4 L21.5 20 H2.5 Z", "M12 10 V14"],
    circles: [{ cx: 12, cy: 16.8, r: 0.9, fill: true }],
  },
  chevron: {
    box: 24,
    strokes: ["M9 5 L16 12 L9 19"],
  },
  file: {
    box: 24,
    strokes: ["M14 3.5 H7 A1.5 1.5 0 0 0 5.5 5 V19 A1.5 1.5 0 0 0 7 20.5 H17 A1.5 1.5 0 0 0 18.5 19 V8 Z", "M14 3.5 V8 H18.5"],
  },
  folder: {
    box: 24,
    strokes: ["M3.5 6.5 A1.5 1.5 0 0 1 5 5 H9.5 L11.5 7.5 H19 A1.5 1.5 0 0 1 20.5 9 V18 A1.5 1.5 0 0 1 19 19.5 H5 A1.5 1.5 0 0 1 3.5 18 Z"],
  },
  layers: {
    box: 24,
    strokes: ["M12 3 L21 8 L12 13 L3 8 Z", "M3 13 L12 18 L21 13", "M3 17 L12 21.5 L21 17"],
  },
  /** A closed loop with an arrowhead — the circular-dependency badge. */
  cycle: {
    box: 24,
    strokes: [
      "M7.5 6.5 A7.5 7.5 0 1 1 5.2 14.5",
      "M4 11.2 L5.2 15 L8.9 13.6",
    ],
  },
  copy: {
    box: 24,
    strokes: [
      "M9 9 H18.5 A1 1 0 0 1 19.5 10 V19.5 A1 1 0 0 1 18.5 20.5 H9 A1 1 0 0 1 8 19.5 V10 A1 1 0 0 1 9 9 Z",
      "M5.5 15.5 A1 1 0 0 1 4.5 14.5 V5 A1 1 0 0 1 5.5 4 H15 A1 1 0 0 1 16 5",
    ],
  },
  diff: {
    box: 24,
    strokes: ["M7 3.5 V12", "M3.5 7.5 H10.5", "M13.5 17.5 H20.5", "M17 21 L20.5 17.5 L17 14"],
  },
  spinner: {
    box: 24,
    strokes: ["M12 3.2 A8.8 8.8 0 0 1 20.8 12"],
    circles: [{ cx: 12, cy: 12, r: 8.8 }],
  },
  close: {
    box: 24,
    strokes: ["M6 6 L18 18", "M18 6 L6 18"],
  },
  zoomIn: {
    box: 24,
    strokes: ["M20 20 L15.6 15.6", "M10.5 7.5 V13.5", "M7.5 10.5 H13.5"],
    circles: [{ cx: 10.5, cy: 10.5, r: 6.5 }],
  },
  zoomOut: {
    box: 24,
    strokes: ["M20 20 L15.6 15.6", "M7.5 10.5 H13.5"],
    circles: [{ cx: 10.5, cy: 10.5, r: 6.5 }],
  },
  fit: {
    box: 24,
    strokes: [
      "M4 9 V5 A1 1 0 0 1 5 4 H9",
      "M15 4 H19 A1 1 0 0 1 20 5 V9",
      "M20 15 V19 A1 1 0 0 1 19 20 H15",
      "M9 20 H5 A1 1 0 0 1 4 19 V15",
    ],
  },
};

let gradientSeq = 0;

/**
 * Builds one icon. `size` is the rendered edge in pixels; the geometry is
 * defined on a 24-unit grid and scales from there.
 */
export function icon(name: IconName, size = 16, className?: string): SVGSVGElement {
  const glyph = GLYPHS[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${glyph.box} ${glyph.box}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);

  let paint: string | undefined;
  if (glyph.gradient) {
    const id = `ib-grad-${++gradientSeq}`;
    const defs = document.createElementNS(NS, "defs");
    const gradient = document.createElementNS(NS, "linearGradient");
    gradient.setAttribute("id", id);
    gradient.setAttribute("x1", "0");
    gradient.setAttribute("y1", "0");
    gradient.setAttribute("x2", "1");
    gradient.setAttribute("y2", "1");
    for (const [offset, color] of [["0", glyph.gradient[0]], ["1", glyph.gradient[1]]]) {
      const stop = document.createElementNS(NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      gradient.append(stop);
    }
    defs.append(gradient);
    svg.append(defs);
    paint = `url(#${id})`;
  }

  for (const fill of glyph.fills ?? []) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", fill.d);
    path.setAttribute("fill", fill.color ?? paint ?? "currentColor");
    svg.append(path);
  }

  const strokeWidth = glyph.width ?? 1.7;
  for (const d of glyph.strokes ?? []) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", String(strokeWidth));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }

  for (const circle of glyph.circles ?? []) {
    const node = document.createElementNS(NS, "circle");
    node.setAttribute("cx", String(circle.cx));
    node.setAttribute("cy", String(circle.cy));
    node.setAttribute("r", String(circle.r));
    if (circle.fill) {
      node.setAttribute("fill", "currentColor");
    } else {
      node.setAttribute("stroke", "currentColor");
      node.setAttribute("stroke-width", String(strokeWidth));
      node.setAttribute("fill", "none");
    }
    svg.append(node);
  }

  // The spinner's arc is drawn over its own track, so the track goes behind it.
  if (name === "spinner") {
    const track = svg.querySelector("circle");
    if (track) {
      track.setAttribute("opacity", "0.25");
      svg.insertBefore(track, svg.firstChild);
    }
  }
  return svg;
}

export const PROVIDER_ICONS: Record<string, IconName> = {
  "anthropic-oauth": "claude",
  "chatgpt-oauth": "chatgpt",
  "gemini-oauth": "gemini",
  kimi: "key",
  deepseek: "key",
  ollama: "server",
};
