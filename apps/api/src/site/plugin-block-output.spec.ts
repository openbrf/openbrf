import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_BLOCK_OUTPUT_LIMITS,
  readPluginBlockOutput,
} from "./plugin-block-output";

/**
 * What a plugin's block renders is somebody else's code's answer, and this is
 * where it is decided what of it a visitor's browser receives. Each case is a
 * way an answer could carry something the website does not print.
 */

describe("reading what a plugin's block rendered", () => {
  it("keeps text and the elements on the list", () => {
    expect(
      readPluginBlockOutput([
        { tag: "h2", children: ["Tvättstugan"] },
        {
          tag: "ul",
          children: [
            {
              tag: "li",
              children: ["Måndag ", { tag: "strong", children: ["ledig"] }],
            },
          ],
        },
      ]),
    ).toEqual({
      ok: true,
      nodes: [
        { tag: "h2", children: ["Tvättstugan"] },
        {
          tag: "ul",
          children: [
            {
              tag: "li",
              children: ["Måndag ", { tag: "strong", children: ["ledig"] }],
            },
          ],
        },
      ],
    });
  });

  it("reads nothing as nothing", () => {
    expect(readPluginBlockOutput(null)).toEqual({ ok: true, nodes: [] });
    expect(readPluginBlockOutput(undefined)).toEqual({ ok: true, nodes: [] });
  });

  it("strips a script, with everything inside it", () => {
    expect(
      readPluginBlockOutput([
        { tag: "p", children: ["Hej"] },
        { tag: "script", children: ["alert(document.cookie)"] },
        {
          tag: "div",
          children: [
            { tag: "script", attributes: { src: "https://evil.example/x.js" } },
          ],
        },
      ]),
    ).toEqual({
      ok: true,
      nodes: [
        { tag: "p", children: ["Hej"] },
        { tag: "div", children: [] },
      ],
    });
  });

  it.each([
    "style",
    "iframe",
    "img",
    "object",
    "embed",
    "link",
    "form",
    "svg",
    "template",
  ])("strips a %s element", (tag) => {
    expect(
      readPluginBlockOutput({
        tag: "div",
        children: [{ tag, children: ["x"] }],
      }),
    ).toEqual({ ok: true, nodes: [{ tag: "div", children: [] }] });
  });

  it("strips event handlers, styles, classes and every attribute not listed", () => {
    expect(
      readPluginBlockOutput({
        tag: "p",
        attributes: {
          onclick: "alert(1)",
          onmouseover: "alert(2)",
          style: "background:url(https://tracker.example/pixel)",
          class: "admin",
          id: "x",
          href: "https://example.org/",
        },
        children: ["Hej"],
      }),
    ).toEqual({ ok: true, nodes: [{ tag: "p", children: ["Hej"] }] });
  });

  it("keeps a link the website would publish, and nothing else as one", () => {
    const link = (href: string) =>
      readPluginBlockOutput({
        tag: "a",
        attributes: { href },
        children: ["Läs"],
      });

    expect(link("https://example.org/tvatt")).toEqual({
      ok: true,
      nodes: [
        { tag: "a", href: "https://example.org/tvatt", children: ["Läs"] },
      ],
    });
    expect(link("/nyheter")).toMatchObject({ nodes: [{ href: "/nyheter" }] });
    for (const refused of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "//evil.example/",
    ]) {
      expect(link(refused)).toEqual({
        ok: true,
        nodes: [{ tag: "a", children: ["Läs"] }],
      });
    }
  });

  it("keeps a date on a time element, and a scope on a header cell", () => {
    expect(
      readPluginBlockOutput([
        {
          tag: "time",
          attributes: { dateTime: "2026-10-18" },
          children: ["18 oktober"],
        },
        { tag: "th", attributes: { scope: "col" }, children: ["Dag"] },
        { tag: "th", attributes: { scope: "javascript:x" }, children: ["Tid"] },
        {
          tag: "time",
          attributes: { dateTime: '"><script>' },
          children: ["?"],
        },
      ]),
    ).toEqual({
      ok: true,
      nodes: [
        { tag: "time", dateTime: "2026-10-18", children: ["18 oktober"] },
        { tag: "th", scope: "col", children: ["Dag"] },
        { tag: "th", children: ["Tid"] },
        { tag: "time", children: ["?"] },
      ],
    });
  });

  it("gives a line break no children", () => {
    expect(readPluginBlockOutput({ tag: "br", children: ["x"] })).toEqual({
      ok: true,
      nodes: [{ tag: "br", children: [] }],
    });
  });

  it("leaves out what is neither text nor an element", () => {
    expect(
      readPluginBlockOutput([
        42,
        true,
        ["nested"],
        { children: ["no tag"] },
        "kept",
      ]),
    ).toEqual({ ok: true, nodes: ["kept"] });
  });

  it("reads a getter once, and an answer that cannot be copied as unreadable", () => {
    const cyclic: Record<string, unknown> = { tag: "p" };
    cyclic["children"] = [cyclic];
    expect(readPluginBlockOutput(cyclic)).toEqual({
      ok: false,
      refusal: "unreadable",
    });

    const throwing = {
      tag: "p",
      get children(): string[] {
        throw new Error("no");
      },
    };
    expect(readPluginBlockOutput(throwing)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
    expect(readPluginBlockOutput(10n)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
  });

  it("refuses an answer larger or deeper than a block may render", () => {
    expect(
      readPluginBlockOutput("x".repeat(PLUGIN_BLOCK_OUTPUT_LIMITS.bytes)),
    ).toEqual({ ok: false, refusal: "too-large" });

    let deep: unknown = "bottom";
    for (let level = 0; level < 40; level += 1) {
      deep = { tag: "div", children: [deep] };
    }
    expect(readPluginBlockOutput(deep)).toEqual({
      ok: false,
      refusal: "too-deep",
    });
  });

  it("refuses a block carrying a personal identity number, in words or in a link", () => {
    expect(
      readPluginBlockOutput({ tag: "p", children: ["Kontakt: 19121212-1212"] }),
    ).toEqual({ ok: false, refusal: "personal-identity-number" });
    // Split over two pieces of text, as a reader still reads it.
    expect(
      readPluginBlockOutput({ tag: "p", children: ["19121212", "-1212"] }),
    ).toEqual({ ok: false, refusal: "personal-identity-number" });
    expect(
      readPluginBlockOutput({
        tag: "a",
        attributes: {
          href: "mailto:board@example.org?subject=19121212%2D1212",
        },
        children: ["Mejla"],
      }),
    ).toEqual({ ok: false, refusal: "personal-identity-number" });
  });

  it("refuses a block carrying a personal identity number in an attribute it prints", () => {
    // Shaped like a date, so the time element keeps it, and printed on the page.
    expect(
      readPluginBlockOutput({
        tag: "time",
        attributes: { dateTime: "19121212-1212" },
        children: ["An event"],
      }),
    ).toEqual({ ok: false, refusal: "personal-identity-number" });
    expect(
      readPluginBlockOutput({
        tag: "p",
        children: [
          "Next meeting: ",
          {
            tag: "time",
            attributes: { dateTime: "191212121212" },
            children: ["soon"],
          },
        ],
      }),
    ).toEqual({ ok: false, refusal: "personal-identity-number" });
  });
});
