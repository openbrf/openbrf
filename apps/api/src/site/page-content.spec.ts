import { describe, expect, it } from "vitest";

import {
  hasBlock,
  imageReferences,
  isPublishableUrl,
  pageTextParts,
  paragraphsContent,
  readPageContent,
  submittedContent,
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

  it("carries no configuration beyond that sentence", () => {
    // Whatever else is sent is stripped rather than stored. What the forms ask
    // for is fixed by the platform: a form whose fields could be edited per
    // page would be a form that could ask a stranger for a personnummer.
    expect(
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
    ).toEqual({
      version: 1,
      blocks: [{ type: "contactForm", intro: [{ text: "Hej." }] }],
    });
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
