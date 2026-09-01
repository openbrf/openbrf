import type { ReactElement } from "react";

import type {
  NewsArticleBlock,
  NewsArticleContent,
  NewsArticleRun,
} from "../api/news-reader";

/**
 * A news item's body, as the people who live in the house read it.
 *
 * Blocks and runs, never markup. What is stored is a block list, so nothing the
 * board typed can carry an element or an attribute into this page: a run is the
 * smallest stretch of text whose marks are uniform, and the marks are the three
 * the platform has. That is the same reason the association's website renders
 * from blocks, and it is why this component can be as short as it is.
 *
 * The link's address is rendered as an address. It is checked against the
 * schemes this platform publishes when it is written and again when it is read
 * back, which is where such a check belongs - one that ran here as well would be
 * a second opinion in the one place where a wrong answer is a rendered anchor,
 * and the browser would resolve whichever of the two let it through.
 *
 * `rel` says noopener and noreferrer on every link, and the target is left alone.
 * A board writing about the local authority's page has no reason to hand that
 * site the address the reader came from, and nothing here opens a window the
 * reader did not ask for.
 */
export function NewsBody({
  content,
}: {
  content: NewsArticleContent;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {content.blocks.map((block, index) => (
        <Block
          // The index, because a block has no identity of its own: the body is
          // one stored value that arrives and is replaced whole, so there is
          // nothing for a key to be stable against and nothing that reorders.
          key={index}
          block={block}
        />
      ))}
    </div>
  );
}

function Block({ block }: { block: NewsArticleBlock }): ReactElement {
  if (block.type === "heading") {
    /*
     * The item's own title is the h2 on the card above this, so a heading the
     * board wrote sits below it and the document keeps one outline. Level 3 is
     * the deepest the stored body can be, and both levels render as h3 rather
     * than an h4 being introduced for a nesting this screen does not show.
     */
    return (
      <h3 className="text-body font-semibold">
        <Runs runs={block.runs} />
      </h3>
    );
  }
  return (
    <p className="text-body">
      <Runs runs={block.runs} />
    </p>
  );
}

function Runs({ runs }: { runs: readonly NewsArticleRun[] }): ReactElement {
  return (
    <>
      {runs.map((run, index) => (
        <Run key={index} run={run} />
      ))}
    </>
  );
}

function Run({ run }: { run: NewsArticleRun }): ReactElement {
  let text: ReactElement = <>{run.text}</>;
  if (run.bold === true) {
    text = <strong className="font-semibold">{text}</strong>;
  }
  if (run.italic === true) {
    text = <em>{text}</em>;
  }
  if (run.link === undefined) {
    return text;
  }
  return (
    <a
      href={run.link}
      rel="noopener noreferrer"
      className="text-ink underline decoration-line-strong underline-offset-2"
    >
      {text}
    </a>
  );
}
