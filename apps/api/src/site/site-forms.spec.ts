import { beforeAll, describe, expect, it } from "vitest";

import { HONEYPOT_FIELD } from "../http/honeypot";
import { I18nService } from "../i18n/i18n.service";
import type { PageBlock } from "./page-content";
import type { SitePage } from "./pages.service";
import type { SiteFormState } from "./site-forms";
import { renderPage, type SiteChrome } from "./site-html";

/**
 * The two forms, as HTML.
 *
 * Everything asserted here is a promise to somebody with no account who is
 * standing in a stairwell with a telephone: the form works with no JavaScript,
 * it sends what they typed to this instance and to nobody else, and nothing
 * they wrote is ever shown back to them by a page.
 *
 * The rules about WHEN a form appears are the other half, and they are the ones
 * that would leak something if they were wrong: a form on a page nobody may
 * read, or a report form on an association that has closed public reporting,
 * would both be a form whose submission the endpoint refuses.
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
    // The menu is the board's arrangement of the site and has nothing to do
    // with the forms on a page. Empty here so these assertions are about the
    // forms alone; the menu has its own tests in site-html.spec.ts.
    menu: [],
  };
});

function page(blocks: PageBlock[], publiclyReadable = true): SitePage {
  return {
    slug: "kontakta-oss",
    title: "Kontakta oss",
    content: { version: 1, blocks },
    publiclyReadable,
  };
}

function state(overrides: Partial<SiteFormState> = {}): SiteFormState {
  return {
    pagePath: "/kontakta-oss",
    publiclyReadable: true,
    sent: null,
    refused: null,
    issueTypes: [{ id: "type-1", name: "Trasig port" }],
    ...overrides,
  };
}

describe("the contact form", () => {
  it("is a plain form that posts back to the page it is on", () => {
    const html = renderPage(chrome, page([{ type: "contactForm" }]), state());

    expect(html).toContain(
      '<form action="/kontakta-oss/kontakt" method="post">',
    );
    expect(html).toContain('name="email"');
    expect(html).toContain('name="message"');
    expect(html).toContain("Skriv till styrelsen");
    // The whole point of the design: nothing runs, and nothing has to.
    expect(html.includes("<script")).toBe(false);
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("carries the decoy, hidden three ways over", () => {
    const html = renderPage(chrome, page([{ type: "contactForm" }]), state());

    expect(html).toContain(`name="${HONEYPOT_FIELD}"`);
    // Out of sight, out of the accessibility tree, out of the tab order. A
    // resident using a screen reader must never be offered it: they would fill
    // it in honestly and have their message dropped without a word.
    expect(html).toContain('<div class="site-hidden" aria-hidden="true">');
    expect(html).toContain('tabindex="-1"');
  });

  it("shows the board's own sentence above it", () => {
    const html = renderPage(
      chrome,
      page([
        {
          type: "contactForm",
          intro: [{ text: "Styrelsen läser detta varje vecka." }],
        },
      ]),
      state(),
    );

    expect(html).toContain("<p>Styrelsen läser detta varje vecka.</p>");
  });

  it("becomes a confirmation once something has been sent", () => {
    const html = renderPage(
      chrome,
      page([{ type: "contactForm" }]),
      state({ sent: "contact" }),
    );

    expect(html).toContain("Meddelandet har nått styrelsen");
    // The form is gone, so the page cannot be submitted a second time by a
    // reload, and the confirmation repeats nothing that was written.
    expect(html.includes('name="message"')).toBe(false);
  });

  it("says so when the form could not read what was sent", () => {
    const html = renderPage(
      chrome,
      page([{ type: "contactForm" }]),
      state({ refused: "contact" }),
    );

    expect(html).toContain("Meddelandet kunde inte läsas.");
    // And the form is still there to try again with.
    expect(html).toContain('name="message"');
  });

  it("is absent from a page an anonymous visitor may not read", () => {
    // A form there would be a form whose submission the endpoint refuses: it
    // resolves the page as an anonymous visitor, so that a page nobody may read
    // stays indistinguishable from one that was never written.
    const html = renderPage(
      chrome,
      page([{ type: "contactForm" }], false),
      state({ publiclyReadable: false }),
    );

    expect(html.includes("<form")).toBe(false);
    expect(html.includes("Skriv till styrelsen")).toBe(false);
  });
});

describe("the issue report form", () => {
  it("offers the types the association put in front of the public", () => {
    const html = renderPage(
      chrome,
      page([{ type: "issueReportForm" }]),
      state({
        issueTypes: [
          { id: "type-1", name: "Trasig port" },
          { id: "type-2", name: "Klotter" },
        ],
      }),
    );

    expect(html).toContain(
      '<form action="/kontakta-oss/felanmalan" method="post">',
    );
    expect(html).toContain('<option value="type-1">Trasig port</option>');
    expect(html).toContain('<option value="type-2">Klotter</option>');
    // The warning the law research asks for, beside the field rather than in a
    // policy elsewhere.
    expect(html).toContain("Utelämna uppgifter om hälsa");
  });

  it("takes text and never a file", () => {
    const html = renderPage(
      chrome,
      page([{ type: "issueReportForm" }]),
      state(),
    );

    // An anonymous upload surface is a place to put files on somebody else's
    // server, and a passer-by reporting a broken door does not need one.
    expect(html.includes('type="file"')).toBe(false);
    expect(html.includes("multipart/form-data")).toBe(false);
  });

  it("is absent while the association takes no public reports", () => {
    // Null is the switch being off. The block stays where the board put it and
    // reappears when reporting is opened again: a page survives the switch.
    const html = renderPage(
      chrome,
      page([{ type: "issueReportForm" }]),
      state({ issueTypes: null }),
    );

    expect(html.includes("<form")).toBe(false);
    expect(html.includes("Anmäl ett fel")).toBe(false);
  });

  it("is absent when reporting is open and no type is offered", () => {
    // A form whose only choice is empty cannot be filled in.
    const html = renderPage(
      chrome,
      page([{ type: "issueReportForm" }]),
      state({ issueTypes: [] }),
    );

    expect(html.includes("<form")).toBe(false);
  });

  it("confirms its own submission and not the other form's", () => {
    const html = renderPage(
      chrome,
      page([{ type: "contactForm" }, { type: "issueReportForm" }]),
      state({ sent: "issue" }),
    );

    expect(html).toContain("Anmälan har nått föreningen.");
    // The contact form on the same page is untouched by it.
    expect(html).toContain('action="/kontakta-oss/kontakt"');
    expect(html.includes('action="/kontakta-oss/felanmalan"')).toBe(false);
  });
});
