/**
 * Fitting a slide to the canvas.
 *
 * The contract lets a slide hold more than one canvas can show at a size read
 * from across a stairwell: eight events, twelve resources, an agenda of forty
 * items, sixty table rows, a hundred and twenty doors, two thousand characters
 * of news in as many paragraphs and lines as it likes. Nothing a slide holds is
 * cut off; a slide the canvas cannot hold is shown a page at a time:
 *
 * 1. A slide's list is shown as many of its items as the canvas holds whole.
 * 2. A page still too tall, such as one long event or a news item, is set
 *    smaller, down to `MIN_SCALE` of its size.
 * 3. A page too tall even then continues on the next page, its text broken
 *    between two words, or a word longer than a page holds between two of its
 *    characters.
 *
 * It measures the slide in the page, so it does nothing where nothing is laid
 * out: before the element has a size, and under a DOM without layout.
 */

/** The attribute on a slide's list that may be shown a page at a time. */
export const PAGED_LIST_ATTRIBUTE = "data-obrf-display-paged";

/**
 * The attribute on an element of a slide whose text is all on other pages of
 * it. The stylesheet takes it out of the page, except a table's cell, which
 * stays empty to keep its row's columns.
 */
export const ELSEWHERE_ATTRIBUTE = "data-obrf-display-elsewhere";

/** The smallest a slide is set, as a share of its size. */
const MIN_SCALE = 0.6;

const SCALE_STEP = 0.05;

/** Which page of the slide is shown, of how many, and whether it fits. */
export interface SlideFit {
  page: number;
  pages: number;
  /**
   * False when the page still holds more than it shows: a single character
   * too wide or too tall for the canvas even at `MIN_SCALE`.
   */
  fits: boolean;
}

/** One page of a slide. */
interface Page {
  /** The items of the slide's list on it, from and up to. */
  from: number;
  to: number;
  /** The unit it is set in, or null for the canvas's own. */
  unit: string | null;
  /** The part of its text on it, from and up to, or null for all of it. */
  text: readonly [number, number] | null;
}

/**
 * Fits a slide that is on the stage, showing page `page` of it (the last page
 * when it has fewer). `unit` is the canvas's unit in pixels, a hundredth of
 * its shorter side, or 0 when it has no size.
 */
export function fitSlide(
  slide: HTMLElement,
  unit: number,
  page: number,
): SlideFit {
  const list = slide.querySelector(`[${PAGED_LIST_ATTRIBUTE}]`);
  const items =
    list === null
      ? []
      : Array.from(list.children as HTMLCollectionOf<HTMLElement>);
  restore(slide, items);
  if (unit <= 0 || !overflows(slide)) {
    return { page: 0, pages: 1, fits: true };
  }
  const pages: Page[] = [];
  for (const [from, to] of itemPages(slide, items)) {
    restore(slide, items);
    show(items, from, to);
    const scaled = shrink(slide, unit);
    if (!overflows(slide)) {
      pages.push({ from, to, unit: scaled, text: null });
      continue;
    }
    const parts = textPages(slide, textFlow(slide));
    for (const text of parts.length > 0 ? parts : [null]) {
      pages.push({ from, to, unit: scaled, text });
    }
  }
  const shown = Math.min(Math.max(0, page), pages.length - 1);
  const chosen = pages[shown] ?? {
    from: 0,
    to: items.length,
    unit: null,
    text: null,
  };
  restore(slide, items);
  show(items, chosen.from, chosen.to);
  if (chosen.unit !== null) {
    slide.style.setProperty("--obrf-display-u", chosen.unit);
  }
  if (chosen.text !== null) {
    textFlow(slide).show(...chosen.text);
  }
  return { page: shown, pages: pages.length, fits: !overflows(slide) };
}

/** Shows the items from `from` up to `to`, and hides the rest. */
function show(items: readonly HTMLElement[], from: number, to: number): void {
  items.forEach((item, index) => {
    item.hidden = index < from || index >= to;
  });
}

/** The ranges of the list's items a page each holds whole: all of it when it has one item or none. */
function itemPages(
  slide: HTMLElement,
  items: readonly HTMLElement[],
): [number, number][] {
  if (items.length <= 1) {
    return [[0, items.length]];
  }
  const pages: [number, number][] = [];
  for (let start = 0; start < items.length;) {
    const count = fitting(slide, items, start);
    pages.push([start, start + count]);
    start += count;
  }
  return pages;
}

/** How many items from `start` the slide holds whole: at least one. */
function fitting(
  slide: HTMLElement,
  items: readonly HTMLElement[],
  start: number,
): number {
  let low = 1;
  let high = items.length - start;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    show(items, start, start + count);
    if (overflows(slide)) {
      high = count - 1;
    } else {
      low = count;
    }
  }
  return low;
}

/** Sets the slide smaller until it fits or reaches `MIN_SCALE`, and hands back the unit it set. */
function shrink(slide: HTMLElement, unit: number): string | null {
  let set: string | null = null;
  for (
    let scale = 1 - SCALE_STEP;
    overflows(slide) && scale >= MIN_SCALE - SCALE_STEP / 2;
    scale -= SCALE_STEP
  ) {
    set = `${unit * scale}px`;
    slide.style.setProperty("--obrf-display-u", set);
  }
  return set;
}

/**
 * The pages of text the slide holds, each at least one character. A page ends
 * between two words. A word longer than a page holds starts on the page it
 * comes to, is broken between two of its characters, and goes on on the next.
 */
function textPages(
  slide: HTMLElement,
  flow: TextFlow,
): (readonly [number, number])[] {
  const pages: [number, number][] = [];
  for (let start = 0; start < flow.length;) {
    const words = flow.wordEnds.filter((wordEnd) => wordEnd > start);
    let end = furthest(slide, flow, start, words);
    const next = words.find((wordEnd) => wordEnd > end);
    flow.show(start, end);
    if (overflows(slide)) {
      // The page is one word, and the word longer than it.
      end = furthest(slide, flow, start, flow.characterEnds(start, end));
    } else if (next !== undefined) {
      // The next word would be longer than a page even on a page of its own.
      flow.show(end, next);
      if (overflows(slide)) {
        end = furthest(slide, flow, start, [
          end,
          ...flow.characterEnds(end, next),
        ]);
      }
    }
    pages.push([start, end]);
    start = end;
  }
  return pages;
}

/** The furthest of `ends` the slide holds its text up to from `start`: at least the first. */
function furthest(
  slide: HTMLElement,
  flow: TextFlow,
  start: number,
  ends: readonly number[],
): number {
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    flow.show(start, ends[middle] ?? flow.length);
    if (overflows(slide)) {
      high = middle - 1;
    } else {
      low = middle;
    }
  }
  return ends[low] ?? flow.length;
}

/**
 * The text of the slide's shown items, its text nodes one after another, that
 * can be shown a part at a time. A part is given by where it starts and ends
 * in the whole text.
 */
interface TextFlow {
  readonly length: number;
  /** Where each word ends, after the space or line break that follows it. */
  readonly wordEnds: readonly number[];
  /** Where each character from `from` up to `to` ends, a character being what a reader sees as one. */
  characterEnds(from: number, to: number): number[];
  /** Shows the text from `from` up to `to`, and takes what holds none of it out of the page. */
  show(from: number, to: number): void;
}

/** Each text node's own text, while a page shows part of it. */
const originals = new WeakMap<Text, string>();

function textNodes(slide: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = slide.ownerDocument.createTreeWalker(
    slide,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** Puts every text back, shows every element and item, and sets the slide at the canvas's unit. */
function restore(slide: HTMLElement, items: readonly HTMLElement[]): void {
  slide.style.removeProperty("--obrf-display-u");
  for (const node of textNodes(slide)) {
    const text = originals.get(node);
    if (text !== undefined && node.data !== text) {
      node.data = text;
    }
  }
  for (const node of Array.from(
    slide.querySelectorAll(`[${ELSEWHERE_ATTRIBUTE}]`),
  )) {
    node.removeAttribute(ELSEWHERE_ATTRIBUTE);
  }
  show(items, 0, items.length);
}

function textFlow(slide: HTMLElement): TextFlow {
  const texts: { node: Text; text: string; first: number }[] = [];
  const wordEnds: number[] = [];
  let whole = "";
  for (const node of textNodes(slide)) {
    if (node.parentElement?.closest("[hidden]") != null) {
      continue;
    }
    const text = originals.get(node) ?? node.data;
    originals.set(node, text);
    // A word ends where the next one starts, so that a page ends after the
    // space or line break that follows its last word.
    const ends = Array.from(
      text.matchAll(/\S+\s*/g),
      (match) => whole.length + match.index + match[0].length,
    );
    if (ends.length > 0) {
      texts.push({ node, text, first: whole.length });
      wordEnds.push(...ends);
      whole += text;
    }
  }
  return {
    length: whole.length,
    wordEnds,
    characterEnds(from, to) {
      const part = whole.slice(from, to);
      if (typeof Intl.Segmenter === "function") {
        return Array.from(
          new Intl.Segmenter().segment(part),
          ({ index, segment }) => from + index + segment.length,
        );
      }
      // A browser without it breaks between two code points.
      const ends: number[] = [];
      let end = from;
      for (const character of part) {
        end += character.length;
        ends.push(end);
      }
      return ends;
    },
    show(from, to) {
      const holding = new Set<Element>();
      const empty = new Set<Element>();
      for (const { node, text, first } of texts) {
        const start = Math.max(from - first, 0);
        const end = Math.min(to - first, text.length);
        const shown = start >= end ? "" : text.slice(start, end);
        node.data = end < text.length ? shown.trimEnd() : shown;
        for (
          let element = node.parentElement;
          element !== null && element !== slide;
          element = element.parentElement
        ) {
          (shown === "" ? empty : holding).add(element);
        }
      }
      for (const element of new Set([...empty, ...holding])) {
        element.toggleAttribute(ELSEWHERE_ATTRIBUTE, !holding.has(element));
      }
    },
  };
}

/**
 * Whether the slide, or a box in it that clips its own text, holds more than
 * it shows.
 */
function overflows(slide: HTMLElement): boolean {
  const boxes = [
    slide,
    ...Array.from(slide.querySelectorAll<HTMLElement>(".obrf-display-copy")),
  ];
  return boxes.some(
    (box) =>
      box.scrollHeight > box.clientHeight + 1 ||
      box.scrollWidth > box.clientWidth + 1,
  );
}
