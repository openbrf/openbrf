/**
 * Fitting a slide to the canvas.
 *
 * The contract lets a slide hold more than one canvas can show at a size read
 * from across a stairwell: eight events, twelve resources, an agenda of forty
 * items, sixty table rows, a hundred and twenty doors, two thousand characters
 * of news. Nothing a slide holds is cut off. A slide's list is shown a page at
 * a time, each page as many of its items as the canvas holds whole, and a
 * slide still too tall, such as a long news item, is set smaller, down to
 * `MIN_SCALE` of its size.
 *
 * It measures the slide in the page, so it does nothing where nothing is laid
 * out: before the element has a size, and under a DOM without layout.
 */

/** The attribute on a slide's list that may be shown a page at a time. */
export const PAGED_LIST_ATTRIBUTE = "data-obrf-display-paged";

/** The smallest a slide is set, as a share of its size. */
const MIN_SCALE = 0.6;

const SCALE_STEP = 0.05;

/** Which page of the slide is shown, of how many, and whether it fits. */
export interface SlideFit {
  page: number;
  pages: number;
  /** False when the slide is still too tall at `MIN_SCALE`. */
  fits: boolean;
}

/**
 * Fits a slide that is on the stage, showing page `page` of its list (the last
 * page when it has fewer). `unit` is the canvas's unit in pixels, a hundredth
 * of its shorter side, or 0 when it has no size.
 */
export function fitSlide(
  slide: HTMLElement,
  unit: number,
  page: number,
): SlideFit {
  slide.style.removeProperty("--obrf-display-u");
  const list = slide.querySelector(`[${PAGED_LIST_ATTRIBUTE}]`);
  const items =
    list === null
      ? []
      : Array.from(list.children as HTMLCollectionOf<HTMLElement>);
  show(items, 0, items.length);
  if (unit <= 0 || !overflows(slide)) {
    return { page: 0, pages: 1, fits: true };
  }
  let paging = { page: 0, pages: 1 };
  if (items.length > 1) {
    const starts: number[] = [];
    for (let start = 0; start < items.length;) {
      starts.push(start);
      start += fitting(slide, items, start);
    }
    const shown = Math.min(Math.max(0, page), starts.length - 1);
    show(items, starts[shown] ?? 0, starts[shown + 1] ?? items.length);
    paging = { page: shown, pages: starts.length };
  }
  // One item, or a slide without a list, still too tall: set it smaller.
  for (
    let scale = 1 - SCALE_STEP;
    overflows(slide) && scale >= MIN_SCALE - SCALE_STEP / 2;
    scale -= SCALE_STEP
  ) {
    slide.style.setProperty("--obrf-display-u", `${unit * scale}px`);
  }
  return { ...paging, fits: !overflows(slide) };
}

/** Shows the items from `from` up to `to`, and hides the rest. */
function show(items: readonly HTMLElement[], from: number, to: number): void {
  items.forEach((item, index) => {
    item.hidden = index < from || index >= to;
  });
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
