/**
 * Just enough Markdown, built as DOM nodes.
 *
 * The model writes prose with code in it, and reading `` `sessions` `` as a
 * literal backtick-wrapped string is a small papercut that happens on every
 * turn. So: paragraphs, lists, fenced blocks, inline code, bold, and nothing
 * else. Headings and links are deliberately absent — a chat reply does not need
 * them, and every feature added here is another parser to get wrong.
 *
 * Nothing is ever assembled as an HTML string. Everything is `createElement` and
 * `textContent`, which is what makes this safe to point at model output: there
 * is no path by which text becomes markup, so there is nothing to escape and
 * nothing to forget to escape.
 */

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.split("\n");

  let paragraph: string[] = [];
  let list: HTMLElement | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const p = document.createElement("p");
    p.append(inline(paragraph.join(" ")));
    fragment.append(p);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) fragment.append(list);
    list = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: everything up to the closing fence is taken verbatim,
    // including whatever looks like markup inside it.
    const fence = /^\s*```+(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? "UL" : "OL";
      if (list && list.tagName !== wanted) flushList();
      list ??= document.createElement(bullet ? "ul" : "ol");
      const li = document.createElement("li");
      li.append(inline((bullet ?? numbered)![1]));
      list.append(li);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return fragment;
}

/**
 * Inline spans: `code` and **bold**.
 *
 * Code is matched first and its contents are never looked at again, so a `**`
 * inside a code span stays literal — which is what anyone writing about
 * pointers or Markdown itself expects.
 */
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) {
      fragment.append(document.createTextNode(text.slice(last, match.index)));
    }
    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[1];
      fragment.append(code);
    } else {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      fragment.append(strong);
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
  return fragment;
}
