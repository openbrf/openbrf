import { describe, expect, it } from "vitest";

import {
  documentFromParagraphs,
  paragraphsFromDocument,
} from "./prosemirror-runs";

/**
 * The mapping between what the board edits and what the association stores.
 *
 * This is the editor's whole contract with the platform, and the reason it is
 * a pure function: what can possibly be stored is decided here rather than by
 * whichever editing library the client happens to use.
 */

describe("reading the editor's document", () => {
  it("returns one array of runs per paragraph", () => {
    expect(
      paragraphsFromDocument({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Ett." }] },
          { type: "paragraph", content: [{ type: "text", text: "Tva." }] },
        ],
      }),
    ).toEqual([[{ text: "Ett." }], [{ text: "Tva." }]]);
  });

  it("keeps bold, italic and a link, and nothing else", () => {
    expect(
      paragraphsFromDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Fet", marks: [{ type: "bold" }] },
              { type: "text", text: "Kursiv", marks: [{ type: "italic" }] },
              {
                type: "text",
                text: "Lank",
                marks: [
                  { type: "link", attrs: { href: "https://exempel.se" } },
                ],
              },
              {
                type: "text",
                text: "Rod",
                marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        { text: "Fet", bold: true },
        { text: "Kursiv", italic: true },
        { text: "Lank", link: "https://exempel.se" },
        { text: "Rod" },
      ],
    ]);
  });

  it("drops a node that is not text and a paragraph that is not one", () => {
    // The editor's schema has no headings or images in it, so this is the
    // second place a pasted one is dropped rather than the first. It is the
    // place that would still hold if the editor were replaced.
    expect(
      paragraphsFromDocument({
        type: "doc",
        content: [
          { type: "heading", content: [{ type: "text", text: "Rubrik" }] },
          {
            type: "paragraph",
            content: [
              { type: "image", text: undefined },
              { type: "text", text: "" },
              { type: "text", text: "Hej." },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Hej." }]]);
  });

  it("survives a document with nothing in it", () => {
    expect(paragraphsFromDocument({ type: "doc" })).toEqual([]);
  });
});

describe("giving the editor a document to start from", () => {
  it("writes one paragraph per array of runs, with its marks", () => {
    expect(
      documentFromParagraphs([
        [{ text: "Hej ", bold: true }, { text: "alla" }],
      ]),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hej ", marks: [{ type: "bold" }] },
            { type: "text", text: "alla" },
          ],
        },
      ],
    });
  });

  it("writes an empty paragraph with no content key at all", () => {
    // A paragraph holding an empty text node is invalid in the editor's schema
    // and is rejected when the document is loaded.
    expect(documentFromParagraphs([[]])).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(documentFromParagraphs([])).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("round-trips a paragraph through both directions unchanged", () => {
    const runs = [
      { text: "Se " },
      { text: "Boverket", link: "https://boverket.se" },
      { text: " for mer", italic: true },
    ];

    expect(paragraphsFromDocument(documentFromParagraphs([runs]))).toEqual([
      runs,
    ]);
  });
});
