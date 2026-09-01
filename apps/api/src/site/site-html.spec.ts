import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import type { SiteMenu } from "./menu.service";
import type { PageBlock } from "./page-content";
import type { SitePage } from "./pages.service";
import type { SiteFormState } from "./site-forms";
import {
  formatNewsDate,
  isoDate,
  renderNotFound,
  renderPage,
  type SiteChrome,
} from "./site-html";

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

/** Chrome carrying a menu, which the renderer is handed already narrowed. */
function withMenu(menu: SiteMenu): SiteChrome {
  return { ...chrome, menu };
}

function page(blocks: PageBlock[]): SitePage {
  return {
    slug: "hem",
    title: "Välkommen",
    content: { version: 1, blocks },
    publiclyReadable: true,
  };
}

/**
 * A page nobody has just submitted anything on, with the public report form
 * open. What the forms do with this is asserted in site-forms.spec.ts; here it
 * is the ordinary case every other assertion renders against.
 */
const FORMS: SiteFormState = {
  pagePath: "/hem",
  publiclyReadable: true,
  sent: null,
  refused: null,
  issueTypes: [{ id: "type-1", name: "Trasig port" }],
};

const PAGE = page([
  { type: "paragraph", runs: [{ text: "Föreningen bildades 1948." }] },
  { type: "paragraph", runs: [{ text: "Styrelsen nås på styrelsen@." }] },
]);

describe("a rendered page", () => {
  it("is a whole document in the visitor's language", () => {
    const html = renderPage(chrome, PAGE, FORMS);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain("<title>Välkommen - Brf Talgoxen</title>");
    expect(html).toContain("Brf Talgoxen");
  });

  it("renders each paragraph the board wrote", () => {
    const html = renderPage(chrome, PAGE, FORMS);

    expect(html).toContain("<p>Föreningen bildades 1948.</p>");
    expect(html).toContain("<p>Styrelsen nås på styrelsen@.</p>");
  });

  it("carries no script of any kind", () => {
    const html = renderPage(chrome, PAGE, FORMS);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    // An inline handler is a script even without the element.
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("carries no address off this instance", () => {
    const html = renderPage(
      chrome,
      page([
        { type: "paragraph", runs: [{ text: "Se https://example.invalid" }] },
      ]),
      FORMS,
    );

    // The visitor's browser fetches nothing from anywhere else. A URL the board
    // typed into a paragraph is text on the page, not a request the browser
    // makes.
    expect(/(?:src|href)="https?:/i.test(html)).toBe(false);
    expect(html).toContain("Se https://example.invalid");
  });

  it("fetches nothing from another host even when a link points at one", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "paragraph",
          runs: [
            { text: "Se " },
            { text: "Boverket", link: "https://boverket.invalid" },
          ],
        },
      ]),
      FORMS,
    );

    /*
     * A link is the one external reference a page may carry: nothing is
     * fetched from the other host while the page is read, and following it is
     * the visitor's own act. What must not appear is a subresource - an image,
     * a stylesheet, a font - pointing anywhere but this instance.
     */
    expect(/src="https?:/i.test(html)).toBe(false);
    expect(html).toContain(
      '<a href="https://boverket.invalid" rel="noopener noreferrer">Boverket</a>',
    );
  });

  it("marks the runs a paragraph is written in", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "paragraph",
          runs: [
            { text: "Stämman " },
            { text: "hålls i maj", bold: true },
            { text: " varje år", italic: true },
          ],
        },
      ]),
      FORMS,
    );

    expect(html).toContain(
      "<p>Stämman <strong>hålls i maj</strong><em> varje år</em></p>",
    );
  });

  it("keeps a page's own headings below its title", () => {
    const html = renderPage(
      chrome,
      page([
        { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
        { type: "heading", level: 3, runs: [{ text: "Sammanträden" }] },
      ]),
      FORMS,
    );

    // One h1 on the page, and it is the title. A heading the board writes is
    // always below it, so the document keeps a single outline.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("<h2>Styrelsen</h2>");
    expect(html).toContain("<h3>Sammanträden</h3>");
  });

  it("serves a picture from this instance's own media route", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "image",
          mediaFileId: "file-7",
          alt: "Gården sedd från porten",
          caption: "Gården, våren 2026",
        },
      ]),
      FORMS,
    );

    expect(html).toContain(
      '<img src="/api/media/file-7" alt="Gården sedd från porten"/>',
    );
    expect(html).toContain("<figcaption>Gården, våren 2026</figcaption>");
  });

  it("links the privacy notice when the association has published one", () => {
    expect(renderPage(chrome, PAGE, FORMS)).not.toContain("Integritetspolicy");

    const html = renderPage(
      { ...chrome, privacyNoticePath: "/integritetspolicy" },
      PAGE,
      FORMS,
    );

    expect(html).toContain(
      '<a href="/integritetspolicy">Integritetspolicy</a>',
    );
  });

  it("shows markup a page's text contains rather than acting on it", () => {
    const html = renderPage(
      chrome,
      {
        ...page([
          {
            type: "paragraph",
            runs: [
              { text: "<script>fetch('https://tracker.invalid')</script>" },
            ],
          },
        ]),
        title: '<img src=x onerror="steal()">',
      },
      FORMS,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the association's mark from this instance's own media route", () => {
    const html = renderPage(
      { ...chrome, logoUrl: "/api/media/file-1" },
      PAGE,
      FORMS,
    );

    expect(html).toContain('src="/api/media/file-1"');
  });

  it("offers the way in to the application", () => {
    const html = renderPage(chrome, PAGE, FORMS);

    expect(html).toContain('href="/app"');
    expect(html).toContain("Logga in");
  });

  it("puts the stylesheet in unescaped", () => {
    // React escapes a text child, and an escaped quotation mark inside a
    // selector would silently break the whole theme.
    const html = renderPage(
      { ...chrome, css: ':root[data-theme="dark"] { color: red; }' },
      PAGE,
      FORMS,
    );

    expect(html).toContain(':root[data-theme="dark"] { color: red; }');
  });
});

describe("the menu", () => {
  it("is absent entirely when the board has arranged none", () => {
    expect(renderPage(chrome, PAGE, FORMS)).not.toContain("<nav");
  });

  it("prints the entries it was handed, in order", () => {
    const html = renderPage(
      withMenu([
        { label: "Hem", href: "/hem", external: false, children: [] },
        {
          label: "Om föreningen",
          href: "/om-foreningen",
          external: false,
          children: [{ label: "Stadgar", href: "/stadgar", external: false }],
        },
      ]),
      PAGE,
      FORMS,
    );

    expect(html).toContain('<a href="/hem">Hem</a>');
    expect(html).toContain('<a href="/om-foreningen">Om föreningen</a>');
    expect(html).toContain('<a href="/stadgar">Stadgar</a>');
    expect(html.indexOf("Hem")).toBeLessThan(html.indexOf("Om föreningen"));
  });

  it("renders a dropdown as a nested list and nothing else", () => {
    const html = renderPage(
      withMenu([
        {
          label: "Om föreningen",
          href: "/om-foreningen",
          external: false,
          children: [{ label: "Stadgar", href: "/stadgar", external: false }],
        },
      ]),
      PAGE,
      FORMS,
    );

    // The disclosure is the stylesheet's work. There is nothing here to click
    // but links, so the menu cannot stop working when a script does not run.
    expect(html).toContain('class="site-nav-group"');
    expect(html).toContain('<ul class="site-nav-children">');
    expect(html).not.toContain("<script");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<button");
  });

  it("cannot be told to fetch anything from another host", () => {
    const html = renderPage(
      withMenu([
        {
          label: "Boverket",
          href: "https://boverket.invalid/bostadsratt",
          external: true,
          children: [],
        },
      ]),
      PAGE,
      FORMS,
    );

    /*
     * An external entry is a text anchor and never a subresource. The promise
     * that reading a page discloses a visitor's address to nobody is about
     * what the browser fetches, and a navigation the reader chooses to follow
     * is the one external reference the website allows.
     */
    expect(html).toContain(
      '<a href="https://boverket.invalid/bostadsratt" rel="noopener noreferrer">Boverket</a>',
    );
    expect(/src="https?:/i.test(html)).toBe(false);
    expect(/<link[^>]+https?:/i.test(html)).toBe(false);
  });

  it("shows markup a label contains rather than acting on it", () => {
    const html = renderPage(
      withMenu([
        {
          label: '<img src=x onerror="steal()">',
          href: "/hem",
          external: false,
          children: [],
        },
      ]),
      PAGE,
      FORMS,
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

/**
 * The four blocks that name something the instance already holds.
 *
 * Each is handed its data by the caller rather than reading any, which is the
 * property these assertions are about: a block renders what the renderer was
 * given, so the audience decisions are made where the reading is and cannot be
 * undone here.
 */
describe("the document list block", () => {
  const documents = [
    {
      title: "Stadgar",
      category: "Stadgar",
      url: "/api/media/file-1",
      fileName: "stadgar.pdf",
      byteSize: 240_000,
    },
    {
      title: "Protokoll 2026-01",
      category: "Protokoll",
      url: "/api/media/file-2",
      fileName: "protokoll-2026-01.pdf",
      byteSize: 2_400_000,
    },
    {
      title: "Protokoll 2026-02",
      category: "Protokoll",
      url: "/api/media/file-3",
      fileName: "protokoll-2026-02.pdf",
      byteSize: 600,
    },
  ];

  const withDocuments = (): SiteChrome => ({ ...chrome, documents });

  it("links each document at the address the caller gave it", () => {
    const html = renderPage(
      withDocuments(),
      page([{ type: "documentList" }]),
      FORMS,
    );

    expect(html).toContain('<a href="/api/media/file-1">Stadgar</a>');
    expect(html).toContain("Protokoll 2026-01");
  });

  it("groups by binder when it lists everything", () => {
    const html = renderPage(
      withDocuments(),
      page([{ type: "documentList" }]),
      FORMS,
    );

    expect(html).toContain("<h3>Stadgar</h3>");
    expect(html).toContain("<h3>Protokoll</h3>");
  });

  it("shows one binder under its own name, with no sub-headings", () => {
    const html = renderPage(
      withDocuments(),
      page([{ type: "documentList", category: "Protokoll" }]),
      FORMS,
    );

    expect(html).toContain("<h2>Protokoll</h2>");
    expect(html).not.toContain("<h3>");
    expect(html).not.toContain("Stadgar");
  });

  it("renders as nothing when this reader may see none of them", () => {
    // Nothing, rather than a heading over an empty list: an empty shelf is
    // also how a visitor would learn that the members have documents.
    const html = renderPage(chrome, page([{ type: "documentList" }]), FORMS);

    expect(html).not.toContain("site-documents");
  });

  it("renders as nothing when the binder holds nothing", () => {
    const html = renderPage(
      withDocuments(),
      page([{ type: "documentList", category: "Årsredovisning" }]),
      FORMS,
    );

    expect(html).not.toContain("site-documents");
  });

  it("says how big each file is, in the reader's own language", () => {
    const html = renderPage(
      withDocuments(),
      page([{ type: "documentList" }]),
      FORMS,
    );

    expect(html).toContain("stadgar.pdf, 240 kB");
    // Decimal megabytes, and the Swedish decimal comma.
    expect(html).toContain("protokoll-2026-01.pdf, 2,4 MB");
    // A file of a few hundred bytes exists. "0 kB" would read as a fault.
    expect(html).toContain("protokoll-2026-02.pdf, 1 kB");
  });
});

describe("the board roster block", () => {
  it("prints the names it was handed, with the position beside each", () => {
    const html = renderPage(
      {
        ...chrome,
        roster: [
          { position: "CHAIR", name: "Anna Andersson" },
          { position: "DEPUTY_BOARD_MEMBER", name: "Bo Ek" },
        ],
      },
      page([{ type: "boardRoster" }]),
      FORMS,
    );

    expect(html).toContain("Anna Andersson");
    expect(html).toContain("Ordförande");
    expect(html).toContain("Bo Ek");
    expect(html).toContain("Suppleant");
  });

  it("renders as nothing when nobody may be published", () => {
    // Which is what an association whose board has not been asked for its
    // publication consents gets. A heading with no names under it would read
    // as the board having resigned.
    const html = renderPage(chrome, page([{ type: "boardRoster" }]), FORMS);

    expect(html).not.toContain("site-roster");
  });
});

describe("the association facts block", () => {
  const facts = {
    propertyDesignation: null,
    buildYear: 1948,
    siteLeasehold: null,
    siteLeaseholdNote: null,
    feePolicy: null,
    feeIncludes: null,
    transferFeePolicy: null,
    pledgeFeePolicy: null,
    legalPersonOwners: null,
    legalPersonOwnersNote: null,
    parking: null,
    storage: null,
    renovations: null,
    updatedAt: null,
  };

  it("renders the recorded facts a level below the block's own heading", () => {
    const html = renderPage(
      {
        ...chrome,
        facts: { organizationNumber: "769600-0000", apartmentCount: 24, facts },
      },
      page([{ type: "associationFacts" }]),
      FORMS,
    );

    expect(html).toContain("<h2>Om föreningen</h2>");
    // The groups sit under the block's heading here, where on the broker page
    // they sit directly under the title.
    expect(html).toContain("<h3>Fastigheten</h3>");
    expect(html).toContain("<dd><p>1948</p></dd>");
    expect(html).toContain("769600-0000");
  });

  it("renders as nothing while the board has recorded no facts", () => {
    const html = renderPage(
      {
        ...chrome,
        facts: { organizationNumber: "769600-0000", apartmentCount: 24, facts },
      },
      page([{ type: "associationFacts" }]),
      FORMS,
    );

    const nothingRecorded = renderPage(
      {
        ...chrome,
        facts: {
          organizationNumber: "769600-0000",
          apartmentCount: 24,
          facts: { ...facts, buildYear: null },
        },
      },
      page([{ type: "associationFacts" }]),
      FORMS,
    );

    expect(html).toContain("site-facts-block");
    expect(nothingRecorded).not.toContain("site-facts-block");
  });

  it("renders as nothing on a page nothing was read for", () => {
    expect(
      renderPage(chrome, page([{ type: "associationFacts" }]), FORMS),
    ).not.toContain("site-facts-block");
  });
});

describe("the FAQ block", () => {
  const faq = page([
    {
      type: "faq",
      items: [
        {
          question: "Var finns tvättstugan?",
          answer: [
            { text: "I källaren. " },
            { text: "Boka i porten", link: "https://exempel.se/boka" },
          ],
        },
      ],
    },
  ]);

  it("is a description list of the board's own questions and answers", () => {
    const html = renderPage(chrome, faq, FORMS);

    expect(html).toContain("<h2>Vanliga frågor</h2>");
    expect(html).toContain("<dt>Var finns tvättstugan?</dt>");
    expect(html).toContain("I källaren.");
  });

  it("carries a marked answer through the one renderer that escapes it", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "faq",
          items: [
            {
              question: "Vad gäller <script>?",
              answer: [{ text: "Ingenting.", bold: true }],
            },
          ],
        },
      ]),
      FORMS,
    );

    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>Ingenting.</strong>");
  });

  it("sends a link that leaves this origin without a referrer", () => {
    expect(renderPage(chrome, faq, FORMS)).toContain(
      '<a href="https://exempel.se/boka" rel="noopener noreferrer">',
    );
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

describe("a published date", () => {
  /*
   * The association is in Sweden, and the two halves of a date used to be read
   * against different calendars: one shown in Stockholm, one marked up in UTC.
   * They only disagree for the couple of hours a day that fall either side of
   * midnight, which is exactly when a notice put up in the evening is dated.
   */
  it("marks up the same day it shows, on an evening the two zones disagree", () => {
    const halfPastMidnightInStockholm = new Date("2026-08-31T22:30:00.000Z");

    expect(isoDate(halfPastMidnightInStockholm)).toBe("2026-09-01");
    expect(formatNewsDate(halfPastMidnightInStockholm, "sv")).toContain(
      "1 september",
    );
  });

  it("is the plain calendar date the rest of the day", () => {
    const middayInStockholm = new Date("2026-08-31T10:00:00.000Z");

    expect(isoDate(middayInStockholm)).toBe("2026-08-31");
  });
});
