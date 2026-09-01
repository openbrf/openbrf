import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import type { AssociationFactsView } from "./association-facts.service";
import { type BrokerPageInput, renderBrokerPage } from "./site-broker";
import type { SiteChrome } from "./site-html";

/**
 * The broker information page, as a document.
 *
 * Two rules carry this page and both are asserted here rather than described.
 * A fact the board has not recorded is not on the page at all - no label, no
 * dash, no empty row - because the person reading it cannot go and fill it in.
 * And the page exists before a single fact does: a housing cooperative that
 * claimed its instance this morning has an address a broker can be sent to,
 * carrying the association's name and organisation number, rather than a 404
 * that starts answering halfway through the board's first session.
 */

const i18n = new I18nService();
let chrome: SiteChrome;

const NOTHING_RECORDED: AssociationFactsView = {
  propertyDesignation: null,
  buildYear: null,
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

function input(overrides: Partial<BrokerPageInput> = {}): BrokerPageInput {
  return {
    organizationNumber: "769600-0000",
    apartmentCount: 24,
    facts: NOTHING_RECORDED,
    ...overrides,
  };
}

function withFacts(facts: Partial<AssociationFactsView>): BrokerPageInput {
  return input({ facts: { ...NOTHING_RECORDED, ...facts } });
}

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
    // The broker page carries the same chrome every other page does, menu
    // included. What the menu holds is the caller's business and not this
    // renderer's, so the unit under test is given an empty one. The same goes
    // for the news a teaser block would show: this page carries no such block.
    menu: [],
    newsTeasers: [],
    eventDates: [],
    documents: [],
    roster: [],
    facts: null,
  };
});

describe("the page an association has before it has recorded anything", () => {
  it("names the association and its organisation number", () => {
    const html = renderBrokerPage(chrome, input());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Mäklarinformation - Brf Talgoxen</title>");
    expect(html).toContain("Brf Talgoxen");
    expect(html).toContain("769600-0000");
  });

  it("states how many apartments the association has", () => {
    // A count, and the only value on the page the board did not type. Anything
    // per-apartment would be register content and is out by the boundary.
    expect(renderBrokerPage(chrome, input())).toContain("<dd><p>24</p></dd>");
  });

  it("leaves out a count of nothing", () => {
    // An instance whose apartments have not been entered yet must not tell a
    // broker the cooperative has none.
    const html = renderBrokerPage(chrome, input({ apartmentCount: 0 }));

    expect(html).not.toContain("Antal lägenheter");
  });

  it("raises none of the questions it cannot answer", () => {
    const html = renderBrokerPage(chrome, input());

    for (const label of [
      "Fastighetsbeteckning",
      "Byggår",
      "Marken",
      "Avgiften",
      "Överlåtelseavgift",
      "Juridisk person som medlem",
    ]) {
      expect(html, label).not.toContain(label);
    }
  });

  it("prints no heading for a group with nothing under it", () => {
    const html = renderBrokerPage(chrome, input());

    expect(html).not.toContain("Fastigheten");
    expect(html).not.toContain("Avgifter");
    expect(html).not.toContain("Medlemskap");
  });
});

describe("a recorded fact", () => {
  it("is printed under its own name", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({ propertyDesignation: "Talgoxen 4", buildYear: 1948 }),
    );

    expect(html).toContain("Fastigheten");
    expect(html).toContain("<dt>Fastighetsbeteckning</dt>");
    expect(html).toContain("<dd><p>Talgoxen 4</p></dd>");
    expect(html).toContain("<dt>Byggår</dt>");
    expect(html).toContain("<dd><p>1948</p></dd>");
  });

  it("brings only its own group's heading with it", () => {
    const html = renderBrokerPage(chrome, withFacts({ parking: "Ingen." }));

    expect(html).toContain("Fastigheten");
    expect(html).not.toContain("Avgifter");
    expect(html).not.toContain("Medlemskap");
  });

  it("says what a yes or a no means rather than printing one", () => {
    // "Tomträtt: Ja" is a row a reader has to interpret. The value states the
    // fact, so it stands on its own wherever it is copied to.
    expect(
      renderBrokerPage(chrome, withFacts({ siteLeasehold: true })),
    ).toContain("Föreningen innehar marken med tomträtt");
    expect(
      renderBrokerPage(chrome, withFacts({ siteLeasehold: false })),
    ).toContain("Föreningen äger marken");
    expect(
      renderBrokerPage(chrome, withFacts({ legalPersonOwners: false })),
    ).toContain("Godkänns inte");
  });

  it("carries the leasehold terms only where there is a leasehold", () => {
    // The two questions are answered separately, so a note can outlive the
    // answer that made it true. Printed against owned land it would read as
    // leasehold terms for a leasehold that does not exist, on the one page a
    // broker takes at face value.
    const note = "Avgälden är 45 000 kr och omförhandlas 2031.";

    expect(
      renderBrokerPage(
        chrome,
        withFacts({ siteLeasehold: true, siteLeaseholdNote: note }),
      ),
    ).toContain(note);

    for (const siteLeasehold of [false, null]) {
      const html = renderBrokerPage(
        chrome,
        withFacts({ siteLeasehold, siteLeaseholdNote: note }),
      );
      expect(html, String(siteLeasehold)).not.toContain(note);
      expect(html, String(siteLeasehold)).not.toContain(
        "Villkor för tomträtten",
      );
    }
  });

  it("keeps the line breaks the board typed", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({ renovations: "Stammar 2019\nFasad 2023" }),
    );

    expect(html).toContain("<p>Stammar 2019</p>");
    expect(html).toContain("<p>Fasad 2023</p>");
  });

  it("is shown as the characters it was written with", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({ feePolicy: "<script>alert(1)</script> & mer" }),
    );

    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; mer");
  });
});

describe("what the page may not do", () => {
  it("carries no script of any kind", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({ feeIncludes: "Värme och vatten." }),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("names no host but this one", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({ storage: "Källarförråd till varje lägenhet." }),
    );

    expect(/(?:src|href)="https?:/i.test(html)).toBe(false);
  });

  it("is written in the language it is handed, not the visitor's", () => {
    /*
     * The renderer takes one translator and the caller decides whose it is.
     * That is what lets the page be answered in the association's own language
     * beside stored text that is never translated - a Swedish fee policy under
     * an English question would be a page whose lang attribute is wrong about
     * half of it.
     */
    const english: SiteChrome = {
      ...chrome,
      t: i18n.translatorFor("en"),
      locale: "en",
    };
    const html = renderBrokerPage(english, withFacts({ buildYear: 1948 }));

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<dt>Year built</dt>");
    expect(html).not.toContain("Byggår");
  });
});
