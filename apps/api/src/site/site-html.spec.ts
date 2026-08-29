import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import { renderNotFound, renderPage, type SiteChrome } from "./site-html";

/**
 * What the association's website may and may not contain.
 *
 * These are the assertions that make three claims in the module's own doc
 * comment checkable rather than aspirational: no script, no third-party
 * address, and a not-found page that is the same document however a visitor
 * arrived at it. Each of the three is a promise made to people who read a
 * housing cooperative's website without having any account with it.
 */

const i18n = new I18nService();
let chrome: SiteChrome;

beforeAll(async () => {
  await i18n.init();
  chrome = {
    t: i18n.translatorFor("sv"),
    locale: "sv",
    associationName: "Brf Talgoxen",
    logoUrl: null,
    css: ":root { --obrf-surface-page: #EFEDE7; }",
  };
});

const PAGE = {
  slug: "hem",
  title: "Välkommen",
  content: {
    version: 1 as const,
    blocks: [
      { type: "paragraph" as const, text: "Föreningen bildades 1948." },
      { type: "paragraph" as const, text: "Styrelsen nås på styrelsen@." },
    ],
  },
};

describe("a rendered page", () => {
  it("is a whole document in the visitor's language", () => {
    const html = renderPage(chrome, PAGE);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain("<title>Välkommen - Brf Talgoxen</title>");
    expect(html).toContain("Brf Talgoxen");
  });

  it("renders each paragraph the board wrote", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).toContain("<p>Föreningen bildades 1948.</p>");
    expect(html).toContain("<p>Styrelsen nås på styrelsen@.</p>");
  });

  it("carries no script of any kind", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    // An inline handler is a script even without the element.
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("carries no address off this instance", () => {
    const html = renderPage(chrome, {
      ...PAGE,
      content: {
        version: 1,
        blocks: [{ type: "paragraph", text: "Se https://example.invalid" }],
      },
    });

    // The visitor's browser fetches nothing from anywhere else. A URL the board
    // typed into a paragraph is text on the page, not a request the browser
    // makes.
    expect(/(?:src|href)="https?:/i.test(html)).toBe(false);
    expect(html).toContain("Se https://example.invalid");
  });

  it("shows markup a page's text contains rather than acting on it", () => {
    const html = renderPage(chrome, {
      ...PAGE,
      title: '<img src=x onerror="steal()">',
      content: {
        version: 1,
        blocks: [
          {
            type: "paragraph",
            text: "<script>fetch('https://tracker.invalid')</script>",
          },
        ],
      },
    });

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the association's mark from this instance's own media route", () => {
    const html = renderPage({ ...chrome, logoUrl: "/api/media/file-1" }, PAGE);

    expect(html).toContain('src="/api/media/file-1"');
  });

  it("offers the way in to the application", () => {
    const html = renderPage(chrome, PAGE);

    expect(html).toContain('href="/app"');
    expect(html).toContain("Logga in");
  });

  it("puts the stylesheet in unescaped", () => {
    // React escapes a text child, and an escaped quotation mark inside a
    // selector would silently break the whole theme.
    const html = renderPage(
      { ...chrome, css: ':root[data-theme="dark"] { color: red; }' },
      PAGE,
    );

    expect(html).toContain(':root[data-theme="dark"] { color: red; }');
  });
});

describe("the not-found page", () => {
  it("is the same document every time it is asked for", () => {
    // This is the whole of the member-only guarantee. A page a visitor may not
    // read is answered with exactly this, so it must not vary with anything the
    // request carried.
    expect(renderNotFound(chrome)).toBe(renderNotFound(chrome));
  });

  it("says what happened in the visitor's language", () => {
    expect(renderNotFound(chrome)).toContain("Sidan finns inte");
    expect(
      renderNotFound({ ...chrome, t: i18n.translatorFor("en"), locale: "en" }),
    ).toContain("The page does not exist");
  });

  it("carries no script either", () => {
    expect(renderNotFound(chrome)).not.toContain("<script");
  });
});
