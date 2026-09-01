import { describe, expect, it } from "vitest";

import {
  hasBlock,
  imageReferences,
  isPublishableUrl,
  pageTextParts,
  paragraphsContent,
  readPageContent,
  submittedContent,
  textBlocksOnly,
} from "./page-content";

/**
 * What a page's body may hold, from both directions.
 *
 * The read path is total and drops what it cannot vouch for; the write path
 * refuses it and says so. Those two dispositions are the whole reason there are
 * two functions, so both are asserted here against the same inputs.
 */

describe("a publishable URL", () => {
  it("accepts the four kinds a page may link to", () => {
    expect(isPublishableUrl("https://boverket.se")).toBe(true);
    expect(isPublishableUrl("http://exempel.se/sida")).toBe(true);
    expect(isPublishableUrl("mailto:styrelsen@exempel.se")).toBe(true);
    expect(isPublishableUrl("/om-foreningen")).toBe(true);
  });

  it("refuses a scheme that would run rather than navigate", () => {
    expect(isPublishableUrl("javascript:alert(1)")).toBe(false);
    expect(isPublishableUrl("data:text/html,<script>x()</script>")).toBe(false);
    expect(isPublishableUrl("vbscript:msgbox")).toBe(false);
    expect(isPublishableUrl("file:///etc/passwd")).toBe(false);
  });

  it("refuses an address that reads as a path and resolves elsewhere", () => {
    // Protocol-relative: it looks like a page on this instance and is not.
    expect(isPublishableUrl("//tracker.invalid/pixel")).toBe(false);
    // A browser normalises the backslash to a slash, so a check that accepted
    // it would be checking a different string from the one finally fetched.
    expect(isPublishableUrl("/\\tracker.invalid")).toBe(false);
    expect(isPublishableUrl("java\nscript:alert(1)")).toBe(false);
    expect(isPublishableUrl("")).toBe(false);
  });
});

describe("reading a stored body", () => {
  it("returns nothing rather than throwing on a body that is not one", () => {
    // A page still has a title, and a body nobody can parse is a reason to show
    // a thin page rather than to take the website down.
    for (const value of [null, "hello", 7, [], { blocks: "no" }, undefined]) {
      expect(readPageContent(value).blocks).toEqual([]);
    }
  });

  it("keeps the blocks it knows and drops the rest", () => {
    const content = readPageContent({
      version: 9,
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "embed", src: "https://tracker.invalid/pixel" },
        { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
        { type: "heading", level: 1, runs: [{ text: "Fel niva" }] },
        "not a block",
      ],
    });

    expect(content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Hej." }] },
      { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
    ]);
    // The version is not carried forward: this renderer reports the shape it
    // produced, and a newer number would claim it understood more than it did.
    expect(content.version).toBe(1);
  });

  it("keeps a block carrying a field no block type declares", () => {
    // The write path refuses such a field; this one has never looked at it. A
    // body already in the column - written by hand, or by a version that
    // accepted it - therefore still renders, block for block, as this version
    // understands it.
    expect(
      readPageContent({
        blocks: [
          {
            type: "contactForm",
            intro: [{ text: "Hej." }],
            fields: ["personalIdentityNumber"],
          },
          { type: "newsTeaser", count: 3, audience: "MEMBER" },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        { type: "contactForm", intro: [{ text: "Hej." }] },
        { type: "newsTeaser", count: 3 },
      ],
    });
  });

  it("reads a paragraph written before runs existed", () => {
    expect(
      readPageContent({ blocks: [{ type: "paragraph", text: "Hej." }] }).blocks,
    ).toEqual([{ type: "paragraph", runs: [{ text: "Hej." }] }]);
  });

  it("keeps the words of a run whose link it refuses", () => {
    const content = readPageContent({
      blocks: [
        {
          type: "paragraph",
          runs: [{ text: "Klicka", link: "javascript:steal()" }],
        },
      ],
    });

    // Show what the board wrote; never the address this version will not vouch
    // for.
    expect(content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Klicka" }] },
    ]);
  });

  it("keeps the marks a run carries and nothing else", () => {
    const content = readPageContent({
      blocks: [
        {
          type: "paragraph",
          runs: [
            {
              text: "Hej",
              bold: true,
              italic: "yes",
              underline: true,
              color: "#ff0000",
            },
          ],
        },
      ],
    });

    expect(content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Hej", bold: true }] },
    ]);
  });

  it("drops a text block that has no text left", () => {
    expect(
      readPageContent({
        blocks: [
          { type: "paragraph", runs: [{ text: "" }] },
          { type: "paragraph" },
          { type: "heading", level: 3, runs: [] },
        ],
      }).blocks,
    ).toEqual([]);
  });

  it("reads an image as an id and never as an address", () => {
    const content = readPageContent({
      blocks: [
        {
          type: "image",
          mediaFileId: "file-1",
          alt: "Garden",
          caption: "Varen 2026",
          src: "https://tracker.invalid/pixel.png",
        },
        { type: "image", src: "https://tracker.invalid/pixel.png" },
      ],
    });

    expect(content.blocks).toEqual([
      {
        type: "image",
        mediaFileId: "file-1",
        alt: "Garden",
        caption: "Varen 2026",
      },
    ]);
  });
});

describe("reading a submitted body", () => {
  it("stores the blocks the editor sent", () => {
    const content = submittedContent({
      blocks: [
        { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
        {
          type: "paragraph",
          runs: [
            { text: "Skriv till " },
            { text: "styrelsen", link: "mailto:styrelsen@exempel.se" },
          ],
        },
        { type: "image", mediaFileId: "file-1", alt: "" },
      ],
    });

    expect(content.version).toBe(1);
    expect(content.blocks).toHaveLength(3);
  });

  it("refuses a link this platform will not publish", () => {
    // The board typed this, so it is told rather than quietly given a page with
    // the link missing.
    expect(() =>
      submittedContent({
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Klicka", link: "javascript:steal()" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses a block type no renderer knows", () => {
    expect(() =>
      submittedContent({
        blocks: [{ type: "embed", src: "https://tracker.invalid" }],
      }),
    ).toThrow();
  });

  it("refuses a field no block type declares", () => {
    // Stripping it would accept the body, answer that it was saved, and store
    // less than the board sent. The write path is the one that can say so.
    expect(() =>
      submittedContent({
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Hej.", colour: "red" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      submittedContent({
        blocks: [{ type: "paragraph", runs: [], align: "center" }],
      }),
    ).toThrow();
    expect(() => submittedContent({ blocks: [], version: 2 })).toThrow();
  });

  it("refuses a heading level the page outline has no room for", () => {
    expect(() =>
      submittedContent({
        blocks: [{ type: "heading", level: 1, runs: [{ text: "Hej" }] }],
      }),
    ).toThrow();
  });

  it("drops the empty paragraph an editor leaves behind", () => {
    const content = submittedContent({
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "paragraph", runs: [] },
        { type: "paragraph", runs: [{ text: "" }] },
      ],
    });

    expect(content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Hej." }] },
    ]);
  });
});

describe("what a body puts in front of a reader", () => {
  it("names every block's own text with its position", () => {
    const content = submittedContent({
      blocks: [
        { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
        {
          type: "paragraph",
          runs: [{ text: "Hej " }, { text: "alla", bold: true }],
        },
        {
          type: "image",
          mediaFileId: "file-1",
          alt: "Garden",
          caption: "Varen",
        },
      ],
    });

    // The image's alternative text and caption are in here too: they are
    // published prose whatever they describe, so the guardrails scan them.
    expect(pageTextParts(content)).toEqual([
      { index: 0, text: "Styrelsen" },
      { index: 1, text: "Hej alla" },
      { index: 2, text: "Garden Varen" },
    ]);
  });

  it("names the stored files a body refers to, with their blocks", () => {
    const content = submittedContent({
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "image", mediaFileId: "file-1", alt: "" },
        { type: "image", mediaFileId: "file-2", alt: "" },
      ],
    });

    expect(imageReferences(content)).toEqual([
      { index: 1, mediaFileId: "file-1" },
      { index: 2, mediaFileId: "file-2" },
    ]);
  });
});

describe("a body built from plain paragraphs", () => {
  it("is runs like every other body, and skips the blank lines", () => {
    expect(paragraphsContent(["Hej.", "  ", "Da."])).toEqual({
      version: 1,
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "paragraph", runs: [{ text: "Da." }] },
      ],
    });
  });
});

describe("the form blocks", () => {
  it("takes a form with nothing above it, and one with a sentence", () => {
    expect(
      submittedContent({
        blocks: [
          { type: "contactForm" },
          {
            type: "issueReportForm",
            intro: [{ text: "Anmäl fel i huset här." }],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        // A form with no intro is still a form, unlike a paragraph with no
        // words in it: the block is the form, and the intro is decoration.
        { type: "contactForm" },
        {
          type: "issueReportForm",
          intro: [{ text: "Anmäl fel i huset här." }],
        },
      ],
    });
  });

  it("refuses a field that would configure what a form asks for", () => {
    // What the forms ask for is fixed by the platform: a form whose fields
    // could be edited per page would be a form that could ask a stranger for a
    // personnummer. Refused rather than stripped - a body accepted without the
    // part that was sent is the one answer a write path must not give.
    expect(() =>
      submittedContent({
        blocks: [
          {
            type: "contactForm",
            intro: [{ text: "Hej." }],
            fields: ["personalIdentityNumber"],
            action: "https://tracker.invalid",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      submittedContent({
        blocks: [{ type: "issueReportForm", issueTypes: ["water"] }],
      }),
    ).toThrow();
  });

  it("refuses an intro linking somewhere this platform will not publish", () => {
    expect(() =>
      submittedContent({
        blocks: [
          {
            type: "contactForm",
            intro: [{ text: "Klicka", link: "javascript:alert(1)" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("reads a stored form back, and keeps the text of a refused link", () => {
    expect(
      readPageContent({
        version: 1,
        blocks: [
          { type: "contactForm" },
          {
            type: "issueReportForm",
            intro: [
              { text: "Läs mer", link: "javascript:alert(1)" },
              { text: "" },
            ],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        { type: "contactForm" },
        // The words the board wrote, never the address this version refuses to
        // vouch for.
        { type: "issueReportForm", intro: [{ text: "Läs mer" }] },
      ],
    });
  });

  it("puts a form's own sentence in front of the guardrail scanner", () => {
    const content = submittedContent({
      blocks: [
        { type: "contactForm", intro: [{ text: "Skriv till oss" }] },
        { type: "issueReportForm" },
      ],
    });

    // The intro is published prose like any other. The labels and the button
    // are chrome, translated rather than written by the board, so they are not
    // the board's text to be scanned or held against them.
    expect(pageTextParts(content)).toEqual([
      { index: 0, text: "Skriv till oss" },
      { index: 1, text: "" },
    ]);
  });

  it("answers which forms a page carries", () => {
    const content = submittedContent({
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "contactForm" },
      ],
    });

    expect(hasBlock(content, "contactForm")).toBe(true);
    expect(hasBlock(content, "issueReportForm")).toBe(false);
  });
});

describe("the news teaser block", () => {
  it("stores a count the parser recognises", () => {
    expect(
      submittedContent({ blocks: [{ type: "newsTeaser", count: 3 }] }),
    ).toEqual({
      version: 1,
      blocks: [{ type: "newsTeaser", count: 3 }],
    });
  });

  it("refuses a count outside what a page may ask for", () => {
    expect(() =>
      submittedContent({ blocks: [{ type: "newsTeaser", count: 0 }] }),
    ).toThrow();
    expect(() =>
      submittedContent({ blocks: [{ type: "newsTeaser", count: 99 }] }),
    ).toThrow();
    expect(() =>
      submittedContent({ blocks: [{ type: "newsTeaser", count: 2.5 }] }),
    ).toThrow();
  });

  it("refuses a field it has no rendering for", () => {
    // Strict, like the rest of the write path. How many items to show is the
    // whole of this block: a field deciding which ones would be a second place
    // to decide what a page discloses, and the first stored page carrying it
    // would put a member-only headline in a public body.
    expect(() =>
      submittedContent({
        blocks: [{ type: "newsTeaser", count: 3, audience: "MEMBER" }],
      }),
    ).toThrow();
  });

  it("drops a stored one whose count it does not recognise", () => {
    // Not clamped to the nearest allowed number: a block this parser cannot
    // read is one it must not guess the meaning of.
    expect(
      readPageContent({
        blocks: [
          { type: "newsTeaser", count: "3" },
          { type: "newsTeaser", count: 999 },
          { type: "newsTeaser", count: 2 },
        ],
      }),
    ).toEqual({ version: 1, blocks: [{ type: "newsTeaser", count: 2 }] });
  });

  it("carries no text of its own to be scanned", () => {
    // What a teaser shows is each news item's own title and opening, and those
    // are scanned where they are written rather than on every page that links
    // to them.
    expect(
      pageTextParts(
        readPageContent({ blocks: [{ type: "newsTeaser", count: 3 }] }),
      ),
    ).toEqual([{ index: 0, text: "" }]);
  });
});

describe("the event calendar block", () => {
  it("stores a count the parser recognises", () => {
    expect(
      submittedContent({ blocks: [{ type: "eventCalendar", count: 3 }] }),
    ).toEqual({
      version: 1,
      blocks: [{ type: "eventCalendar", count: 3 }],
    });
  });

  it("refuses a count outside what a page may ask for", () => {
    expect(() =>
      submittedContent({ blocks: [{ type: "eventCalendar", count: 0 }] }),
    ).toThrow();
    expect(() =>
      submittedContent({ blocks: [{ type: "eventCalendar", count: 99 }] }),
    ).toThrow();
    expect(() =>
      submittedContent({ blocks: [{ type: "eventCalendar", count: 2.5 }] }),
    ).toThrow();
  });

  it("refuses a field it has no rendering for", () => {
    // Strict, like the rest of the write path: a body quietly stripped of part
    // of itself is the one answer a write path must not give. There is nothing
    // on this block that could name a person, and this is what keeps it that
    // way.
    expect(() =>
      submittedContent({
        blocks: [{ type: "eventCalendar", count: 3, attendees: true }],
      }),
    ).toThrow();
  });

  it("drops a stored one whose count it does not recognise", () => {
    expect(
      readPageContent({
        blocks: [
          { type: "eventCalendar", count: "3" },
          { type: "eventCalendar", count: 999 },
          { type: "eventCalendar", count: 2 },
        ],
      }),
    ).toEqual({ version: 1, blocks: [{ type: "eventCalendar", count: 2 }] });
  });

  it("carries no text of its own to be scanned", () => {
    // What the block shows is each event's own title and location, scanned
    // where they are written rather than on every page that lists them.
    expect(
      pageTextParts(
        readPageContent({ blocks: [{ type: "eventCalendar", count: 3 }] }),
      ),
    ).toEqual([{ index: 0, text: "" }]);
  });
});

describe("the document list block", () => {
  it("stores a binder, or the absence of one", () => {
    expect(
      submittedContent({
        blocks: [
          { type: "documentList" },
          { type: "documentList", category: "Protokoll" },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        { type: "documentList" },
        { type: "documentList", category: "Protokoll" },
      ],
    });
  });

  it("reads a binder cleared back to nothing as no binder", () => {
    // Not a binder named "", which would list nothing at all - the opposite of
    // what a board that emptied the field asked for.
    expect(
      submittedContent({ blocks: [{ type: "documentList", category: "  " }] }),
    ).toEqual({ version: 1, blocks: [{ type: "documentList" }] });
    expect(
      readPageContent({ blocks: [{ type: "documentList", category: "" }] }),
    ).toEqual({ version: 1, blocks: [{ type: "documentList" }] });
  });

  it("carries no audience for a board to set", () => {
    // Who may read a document is a property of the document, decided once in
    // the archive. A block that could name an audience would be a second place
    // to decide it, on a page anybody can open.
    expect(() =>
      submittedContent({
        blocks: [{ type: "documentList", audience: "BOARD" }],
      }),
    ).toThrow();
  });
});

describe("the board roster block", () => {
  it("carries nothing at all", () => {
    expect(submittedContent({ blocks: [{ type: "boardRoster" }] })).toEqual({
      version: 1,
      blocks: [{ type: "boardRoster" }],
    });
    expect(readPageContent({ blocks: [{ type: "boardRoster" }] })).toEqual({
      version: 1,
      blocks: [{ type: "boardRoster" }],
    });
  });

  it("refuses a stored roster of names", () => {
    // The names are resolved against each person's own publication consent
    // when the page is rendered. A stored roster would publish a name for as
    // long as the page stood, whatever the person later said.
    expect(() =>
      submittedContent({
        blocks: [{ type: "boardRoster", names: ["Anna Andersson"] }],
      }),
    ).toThrow();
  });
});

describe("the association facts block", () => {
  it("carries nothing at all", () => {
    expect(
      submittedContent({ blocks: [{ type: "associationFacts" }] }),
    ).toEqual({ version: 1, blocks: [{ type: "associationFacts" }] });
  });
});

describe("the FAQ block", () => {
  it("carries the board's own questions and answers", () => {
    expect(
      submittedContent({
        blocks: [
          {
            type: "faq",
            items: [
              {
                question: "Var finns tvättstugan?",
                answer: [{ text: "I källaren, ", bold: true }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        {
          type: "faq",
          items: [
            {
              question: "Var finns tvättstugan?",
              answer: [{ text: "I källaren, ", bold: true }],
            },
          ],
        },
      ],
    });
  });

  it("drops an entry missing either half, and the block when none is left", () => {
    expect(
      readPageContent({
        blocks: [
          {
            type: "faq",
            items: [
              { question: "Utan svar?", answer: [] },
              { question: "  ", answer: [{ text: "Utan fråga." }] },
              { question: "Med båda?", answer: [{ text: "Ja." }] },
            ],
          },
          { type: "faq", items: [{ question: "Ensam?", answer: [] }] },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        {
          type: "faq",
          items: [{ question: "Med båda?", answer: [{ text: "Ja." }] }],
        },
      ],
    });
  });

  it("drops a link in an answer that this version will not publish", () => {
    expect(
      readPageContent({
        blocks: [
          {
            type: "faq",
            items: [
              {
                question: "Var står stadgarna?",
                answer: [{ text: "Här", link: "javascript:alert(1)" }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        {
          type: "faq",
          items: [
            { question: "Var står stadgarna?", answer: [{ text: "Här" }] },
          ],
        },
      ],
    });
  });

  it("drops a question whose answer is nothing but spaces", () => {
    // A blank question is already dropped above; an answer holding only spaces
    // is the same absence and has to go the same way, or the page renders a
    // question with nothing under it.
    expect(
      readPageContent({
        blocks: [
          {
            type: "faq",
            items: [
              { question: "Var står stadgarna?", answer: [{ text: "   " }] },
              { question: "Vem sköter trädgården?", answer: [{ text: "Vi." }] },
            ],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      blocks: [
        {
          type: "faq",
          items: [
            { question: "Vem sköter trädgården?", answer: [{ text: "Vi." }] },
          ],
        },
      ],
    });
  });

  it("refuses an answer carrying a link this platform will not publish", () => {
    // The read path drops such a link; the write path has to refuse it. Without
    // this, a regression that stripped it on save would pass the suite, and the
    // board would be told the page was saved with the link they typed.
    expect(() =>
      submittedContent({
        blocks: [
          {
            type: "faq",
            items: [
              {
                question: "Var står stadgarna?",
                answer: [{ text: "Klicka", link: "javascript:steal()" }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("puts both halves in front of the guardrail scan", () => {
    // A question is as good a place to paste a personal identity number into
    // as an answer, and both are published.
    expect(
      pageTextParts(
        readPageContent({
          blocks: [
            {
              type: "faq",
              items: [
                { question: "Vem är ordförande?", answer: [{ text: "Anna." }] },
              ],
            },
          ],
        }),
      ),
    ).toEqual([{ index: 0, text: "Vem är ordförande? Anna." }]);
  });
});

describe("the blocks that name what the instance already holds", () => {
  it("carry no text of their own to be scanned", () => {
    expect(
      pageTextParts(
        readPageContent({
          blocks: [
            { type: "documentList", category: "Protokoll" },
            { type: "boardRoster" },
            { type: "associationFacts" },
          ],
        }),
      ),
    ).toEqual([
      { index: 0, text: "" },
      { index: 1, text: "" },
      { index: 2, text: "" },
    ]);
  });
});

describe("a body narrowed to its prose", () => {
  it("keeps the paragraphs and headings and drops everything else", () => {
    const content = readPageContent({
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "image", mediaFileId: "file-1", alt: "" },
        { type: "heading", level: 2, runs: [{ text: "Tider" }] },
        { type: "newsTeaser", count: 3 },
      ],
    });

    expect(textBlocksOnly(content)).toEqual({
      version: 1,
      blocks: [
        { type: "paragraph", runs: [{ text: "Hej." }] },
        { type: "heading", level: 2, runs: [{ text: "Tider" }] },
      ],
    });
  });
});
