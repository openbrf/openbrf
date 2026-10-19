import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { scannableRuns } from "../../scannable-text.ts";
import { defineBlock } from "../definition.ts";
import {
  isRecord,
  keptRuns,
  readRunList,
  runsSchema,
  type TextRun,
} from "../text-runs.ts";

const LIMITS = PAGE_CONTENT_LIMITS;

/** One question the association answers, and its answer. */
export interface FaqItem {
  /**
   * The question, as plain text.
   *
   * Not runs, unlike an answer. A question is a label on the answer below it -
   * the markup is a description list - and emphasis or a link inside a label
   * is formatting nobody reads and one more shape for the parser to be wrong
   * about.
   */
  question: string;
  /** The answer, as one paragraph carrying its marks. */
  answer: TextRun[];
}

/**
 * The questions the association is asked, with the board's answers.
 *
 * The one block among those that show the association's own matters that
 * carries its own content rather than naming something the instance already
 * holds. That is deliberate and it is why this needs no feature of its own: a
 * FAQ is the board's own writing about its own house, with no second screen to
 * maintain it on and nothing to publish separately - the page it sits on is the
 * thing that is published.
 *
 * An answer is one paragraph. An answer that needs several is a page, and the
 * board can write one and link it from here.
 */
export interface FaqBlock {
  type: "faq";
  items: FaqItem[];
}

/**
 * The questions a stored FAQ block holds.
 *
 * An entry missing either half is dropped rather than repaired. A question
 * with no answer under it is the page asking the reader something, and an
 * answer with no question is a paragraph that has lost what it was about -
 * neither is a thing this renderer can vouch for having been meant.
 */
function readFaqItems(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items: FaqItem[] = [];
  for (const entry of raw.slice(0, LIMITS.faqItems)) {
    if (!isRecord(entry)) {
      continue;
    }
    const question = entry["question"];
    if (typeof question !== "string" || question.trim() === "") {
      continue;
    }
    const answer = readRunList(entry["answer"]);
    // Nothing visible under the question is the same as no answer, exactly as
    // a blank question above is the same as no question. A run holding only
    // spaces would otherwise render a heading with an empty space beneath it.
    if (answer.every((run) => run.text.trim() === "")) {
      continue;
    }
    items.push({
      question: question.trim().slice(0, LIMITS.faqQuestion),
      answer,
    });
  }
  return items;
}

/** Whether an entry has both halves, as the read path decides it. */
function isAnswered(item: FaqItem): boolean {
  return (
    item.question.trim() !== "" &&
    item.answer.some((run) => run.text.trim() !== "")
  );
}

export const faqBlock = defineBlock<FaqBlock>()({
  type: "faq",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("faq"),
      items: zod
        .array(
          zod.strictObject({
            question: zod.string().max(LIMITS.faqQuestion),
            answer: runsSchema(zod),
          }),
        )
        .max(LIMITS.faqItems),
    }),
  read: (stored) => {
    const items = readFaqItems(stored["items"]);
    return items.length === 0 ? null : { type: "faq", items };
  },
  normalize: (block) => {
    const items = block.items
      .map((item) => ({
        question: item.question.trim(),
        answer: keptRuns(item.answer),
      }))
      .filter((item) => isAnswered(item));
    // A question with no answer is a question the page asks the reader, so
    // an entry needs both halves to survive - and a block left with no
    // entries is the empty paragraph case: a gap in the page. An answer of
    // nothing but spaces is no answer, exactly as the read path decides: kept
    // here, it would be saved and echoed back and then vanish on the next
    // read.
    return items.length === 0 ? null : { type: "faq", items };
  },
  text: (block) => {
    // Both halves, because both are the board's own writing published on the
    // page. A question is as good a place to paste a personal identity number
    // into as an answer. Every item's words come before any address, so an
    // offset into a later item is not moved by a link in an earlier one.
    const items = block.items.map((item) => ({
      question: item.question,
      answer: scannableRuns(item.answer),
    }));
    return {
      words: items
        .map((item) => [item.question, item.answer.words].join(" "))
        .join(" ")
        .trim(),
      addresses: items.flatMap((item) => item.answer.addresses),
      unreadableAddress: items.some((item) => item.answer.unreadableAddress),
    };
  },
  editor: {
    label: "siteAdmin.editor.blocks.faq",
    insert: "siteAdmin.editor.add.faq",
    icon: "questions",
    category: "text",
    nestable: false,
    // One empty question, so the board is looking at the pair of fields it
    // came here to fill in rather than at a button that produces them.
    create: () => ({ type: "faq", items: [{ question: "", answer: [] }] }),
    // At least one question with an answer under it: the API drops the empty
    // entries anyway, and a block left with none of them is a gap in the page.
    // The same rule normalize keeps entries by, so an answer of only spaces
    // does not send a block the write path then drops.
    ready: (block) => block.items.some((item) => isAnswered(item)),
  },
});
