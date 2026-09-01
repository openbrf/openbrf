import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import { readPageContent } from "./page-content";
import type { SitePage } from "./pages.service";
import type { SiteFormState } from "./site-forms";
import { renderPage, type SiteChrome } from "./site-html";
import { renderNewsArticle, renderNewsIndex } from "./site-news";
import { type SiteNewsArticle, teaserOf } from "./site-news.service";

/**
 * The association's news, on its own website.
 *
 * Three things are asserted here and nowhere else: that a news page is the same
 * document a page is - the same shell, the same escaping, no script - that the
 * teaser block shows the items the reader was handed and never any others, and
 * that a teaser is the opening of the body rather than a second copy of it.
 *
 * What a reader may see is not decided here at all. The filtering is the
 * service's, and a member-only item never reaches this file for somebody with
 * no session, which is why the refusal is the same not-found document a missing
 * address produces.
 */

const i18n = new I18nService();
let chrome: SiteChrome;

const ARTICLE: SiteNewsArticle = {
  slug: "tvattstugan",
  title: "Nya tider i tvättstugan",
  publishedAt: new Date("2026-09-01T08:00:00.000Z"),
  content: readPageContent({
    blocks: [
      { type: "paragraph", runs: [{ text: "Från måndag gäller nya tider." }] },
      { type: "heading", level: 2, runs: [{ text: "Boka så här" }] },
    ],
  }),
};

beforeAll(async () => {
  await i18n.init();
  chrome = {
    t: i18n.translatorFor("sv"),
    locale: "sv",
    associationName: "Brf Talgoxen",
    logoUrl: null,
    css: ":root { --obrf-surface-page: #EFEDE7; }",
    mediaUrl: (mediaFileId) => `/api/media/${mediaFileId}`,
    privacyNoticePath: null,
    menu: [],
    newsTeasers: [],
    eventDates: [],
    documents: [],
    roster: [],
    facts: null,
  };
});

describe("the news index", () => {
  it("is a whole document listing what the reader may see", () => {
    const html = renderNewsIndex(chrome, [ARTICLE]);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain("Nya tider i tvättstugan");
    expect(html).toContain('href="/nyheter/tvattstugan"');
    expect(html.includes("<script")).toBe(false);
  });

  it("says so plainly when nothing has been written", () => {
    const html = renderNewsIndex(chrome, []);

    expect(html).toContain("Inget är skrivet än.");
  });

  it("escapes what the board typed, like every other page", () => {
    const html = renderNewsIndex(chrome, [
      { ...ARTICLE, title: "<script>alert(1)</script>" },
    ]);

    expect(html.includes("<script")).toBe(false);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("one news article", () => {
  it("carries its date and its body", () => {
    const html = renderNewsArticle(chrome, ARTICLE);

    // The attribute as this renderer writes it. HTML attribute names are
    // case-insensitive, so a browser reads it as datetime either way.
    expect(html).toContain('<time dateTime="2026-09-01">');
    expect(html).toContain("1 september 2026");
    expect(html).toContain("<p>Från måndag gäller nya tider.</p>");
    expect(html).toContain("<h2>Boka så här</h2>");
    // Back to the index, on a page with no navigation of its own yet.
    expect(html).toContain('href="/nyheter"');
  });
});

describe("a page carrying a news teaser", () => {
  const page = (count: number): SitePage => ({
    slug: "hem",
    title: "Välkommen",
    content: readPageContent({ blocks: [{ type: "newsTeaser", count }] }),
    publiclyReadable: true,
  });

  /**
   * A page nobody has just submitted anything on and which carries no form.
   * The teaser is what is under assertion here; the forms have their own tests
   * in site-forms.spec.ts.
   */
  const forms: SiteFormState = {
    pagePath: "/hem",
    publiclyReadable: true,
    sent: null,
    refused: null,
    issueTypes: null,
  };

  const teasers = [
    {
      slug: "tvattstugan",
      title: "Nya tider i tvättstugan",
      publishedAt: new Date("2026-09-01T08:00:00.000Z"),
      teaser: "Från måndag gäller nya tider.",
    },
    {
      slug: "garden",
      title: "Städdag",
      publishedAt: new Date("2026-08-20T08:00:00.000Z"),
      teaser: "Vi träffas på gården.",
    },
  ];

  it("shows the items it was handed, newest first", () => {
    const html = renderPage(
      { ...chrome, newsTeasers: teasers },
      page(3),
      forms,
    );

    expect(html).toContain("Senaste nytt");
    expect(html).toContain('href="/nyheter"');
    expect(html).toContain("Nya tider i tvättstugan");
    expect(html).toContain("Städdag");
    expect(html.indexOf("tvattstugan")).toBeLessThan(html.indexOf("garden"));
  });

  it("shows no more than the block asked for", () => {
    const html = renderPage(
      { ...chrome, newsTeasers: teasers },
      page(1),
      forms,
    );

    expect(html).toContain("Nya tider i tvättstugan");
    expect(html.includes("Städdag")).toBe(false);
  });

  it("renders as nothing at all when there is no news to show", () => {
    // A page must not announce a news section the association has not started
    // writing.
    const html = renderPage(chrome, page(3), forms);

    expect(html.includes("Senaste nytt")).toBe(false);
  });
});

describe("the opening of a body, as a teaser", () => {
  it("is the first paragraph when it is short enough", () => {
    expect(teaserOf(ARTICLE.content)).toBe("Från måndag gäller nya tider.");
  });

  it("stops on a word and says that it stopped", () => {
    const long = readPageContent({
      blocks: [{ type: "paragraph", runs: [{ text: "ord ".repeat(80) }] }],
    });

    const teaser = teaserOf(long);
    expect(teaser.endsWith("...")).toBe(true);
    expect(teaser.length).toBeLessThan(200);
    expect(teaser.includes("or...")).toBe(false);
  });

  it("is empty when the item opens with a heading", () => {
    const headingFirst = readPageContent({
      blocks: [{ type: "heading", level: 2, runs: [{ text: "Rubrik" }] }],
    });

    expect(teaserOf(headingFirst)).toBe("");
  });
});
