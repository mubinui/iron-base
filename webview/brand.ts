/**
 * The sign-in surface, shared by the sidebar and the build panel.
 *
 * Both places have to answer "what is this and how do I start it", and they had
 * begun answering it differently — a branded hero with the full connect matrix
 * in one, a bare sentence and a button in the other, which made the panel look
 * like a different product from the sidebar that opened it. This is the one
 * implementation of that screen; the surfaces differ only in what they do with
 * the button press, which is why `onConnect` is passed in rather than a
 * `vscode` handle being reached for from here.
 *
 * As everywhere else in the webviews, every node is built with `createElement`
 * and `textContent`. Nothing here interpolates markup.
 */

import {
  ALL_PROVIDERS,
  PROVIDER_DETAILS,
  PROVIDER_LABELS,
  PROVIDER_METHODS,
  type AuthMethod,
  type ProviderId,
} from "../src/llm/types";
import { icon, PROVIDER_ICONS, type IconName } from "./icons";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Providers led with in the connect matrix.
 *
 * The recognisable accounts, so the first screen is names people know rather
 * than a wall of fourteen. Everything else stays one disclosure away, which is
 * where choosing between OpenRouter and Groq actually belongs.
 */
export const FEATURED: ProviderId[] = [
  "anthropic-oauth",
  "chatgpt-oauth",
  "gemini-oauth",
  "chatgpt-web",
  "xai",
  "kimi",
];

/**
 * The IronBase mark: three solid tiers narrowing as they rise, white on the
 * brand gradient.
 *
 * The same stepped foundation as the activity-bar icon and the Marketplace
 * tile, so the product wears one face everywhere. The gradient is the tile's,
 * from CSS, and the tiers are flat white — no gradient inside the glyph itself,
 * which keeps it crisp at any size.
 */
export function brandMark(size = 26): HTMLElement {
  const tile = el("div", undefined, "brand-tile");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const tiers: Array<[number, number, number, number, number]> = [
    [8.5, 4, 7, 3.6, 1.3],
    [6, 10, 12, 3.6, 1.3],
    [3.5, 16, 17, 4, 1.5],
  ];
  for (const [x, y, w, h, r] of tiers) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(r));
    rect.setAttribute("fill", "#ffffff");
    svg.append(rect);
  }
  tile.append(svg);
  return tile;
}

/** IRON BASE, flat: the gradient lives on the mark alone. */
export function wordmark(): HTMLElement {
  const node = el("div", undefined, "wordmark");
  node.append(el("span", "IRON", "w1"), el("span", "BASE", "w2"));
  return node;
}

export interface HeroText {
  headline: string;
  lede: string;
}

/**
 * The three-second pitch.
 *
 * It commits to a look of its own rather than dissolving into the editor theme
 * — the one place the brand owns the surface outright.
 */
export function hero(text: HeroText): HTMLElement {
  const node = el("div", undefined, "hero");
  node.append(brandMark(), wordmark());
  node.append(el("h1", text.headline));
  node.append(el("p", text.lede, "lede"));
  return node;
}

/**
 * Every account, each showing every way it can be connected, with the long tail
 * behind a disclosure.
 *
 * The methods come straight from the engine's own matrix, so a provider can
 * never show a way in the code cannot actually take — and a `webSession` button
 * appears only where sign-in has been verified, never on a bare declaration.
 */
export function connectMatrix(
  sessionCapable: Set<ProviderId>,
  onConnect: (id: ProviderId, method: AuthMethod) => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];

  const featured = el("div", undefined, "connect-grid");
  for (const id of FEATURED) featured.append(connectCard(id, sessionCapable, onConnect));
  out.push(featured);

  const rest = ALL_PROVIDERS.filter((id) => !FEATURED.includes(id));
  const more = el("details", undefined, "more");
  const summary = document.createElement("summary");
  summary.append(icon("chevron", 13, "chev"), el("span", `${rest.length} more ways to connect`));
  more.append(summary);
  const restGrid = el("div", undefined, "connect-grid");
  for (const id of rest) restGrid.append(connectCard(id, sessionCapable, onConnect));
  more.append(restGrid);
  out.push(more);

  return out;
}

/** The line that answers "where does my key go", wherever the matrix appears. */
export function keychainFootnote(): HTMLElement {
  return el(
    "div",
    "Every credential is stored in your system keychain, and only ever sent to that provider.",
    "footnote",
  );
}

function connectCard(
  id: ProviderId,
  sessionCapable: Set<ProviderId>,
  onConnect: (id: ProviderId, method: AuthMethod) => void,
): HTMLElement {
  const card = el("div", undefined, "connect");

  const mark = el("span", undefined, "mark");
  mark.append(icon((PROVIDER_ICONS[id] ?? "key") as IconName, 18));

  const body = el("div", undefined, "body");
  body.append(el("span", PROVIDER_LABELS[id], "name"));
  body.append(el("span", PROVIDER_DETAILS[id], "detail"));

  const methods = el("div", undefined, "methods");
  for (const method of PROVIDER_METHODS[id]) {
    if (method === "webSession" && !sessionCapable.has(id)) continue;
    methods.append(methodChip(id, method, onConnect));
  }
  body.append(methods);

  card.append(mark, body);
  return card;
}

interface MethodLook {
  label: string;
  glyph: IconName;
  primary?: boolean;
}

/** How each method presents in the matrix. */
function methodLook(method: AuthMethod): MethodLook {
  switch (method) {
    case "oauth":
      return { label: "Sign in", glyph: "signIn", primary: true };
    case "webSession":
      return { label: "Log in — free", glyph: "plug", primary: true };
    case "apiKey":
      return { label: "API key", glyph: "key" };
    case "free":
      return { label: "Enable", glyph: "play", primary: true };
    case "local":
      return { label: "Connect", glyph: "server", primary: true };
  }
}

function methodChip(
  id: ProviderId,
  method: AuthMethod,
  onConnect: (id: ProviderId, method: AuthMethod) => void,
): HTMLElement {
  const look = methodLook(method);
  const chip = el("button", undefined, `chip${look.primary ? " primary" : ""}`);
  chip.append(icon(look.glyph, 13), el("span", look.label));
  chip.addEventListener("click", () => onConnect(id, method));
  return chip;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
