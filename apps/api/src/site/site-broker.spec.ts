import { beforeAll, describe, expect, it } from "vite-plus/test";

import { I18nService } from "../i18n/i18n.service";
import type { AssociationFactsView } from "./association-facts.service";
import {
  BROKER_UPDATE_REQUEST_PATH,
  type BrokerPageInput,
  type BrokerUpdateRequestOffer,
  brokerUpdateRequestAnswerPath,
  brokerUpdateRequestState,
  renderBrokerPage,
} from "./site-broker";
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
  confirmedAt: null,
  staleAfterMonths: 3,
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
    controllerContact: null,
    pagePaths: new Map(),
    pluginBlocks: new Map(),
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

describe("when the board last confirmed the facts", () => {
  it("is said under the title, as a day in the association's language", () => {
    const html = renderBrokerPage(
      chrome,
      withFacts({
        buildYear: 1948,
        confirmedAt: "2026-03-14T10:00:00.000Z",
      }),
    );

    expect(html).toContain(
      'Styrelsen bekräftade senast uppgifterna den <time dateTime="2026-03-14">14 mars 2026</time>.',
    );
    // Before the facts, so a broker reads how current they are first.
    expect(html.indexOf("bekräftade senast")).toBeLessThan(
      html.indexOf("Byggår"),
    );
  });

  it("is the day it was here, not the day it was in UTC", () => {
    // Half past midnight in Stockholm is still the evening before in UTC.
    const html = renderBrokerPage(
      chrome,
      withFacts({
        buildYear: 1948,
        confirmedAt: "2026-03-13T23:30:00.000Z",
      }),
    );

    expect(html).toContain('<time dateTime="2026-03-14">14 mars 2026</time>');
  });

  it("is not said over a page with no answers on it", () => {
    // A board that saved every field empty has a confirmation date and nothing
    // it confirmed. "Confirmed in March" over the association's name alone
    // would read as an answer to the questions the page leaves out.
    const html = renderBrokerPage(
      chrome,
      withFacts({ confirmedAt: "2026-03-14T10:00:00.000Z" }),
    );

    expect(html).not.toContain("bekräftade senast");
    expect(html).not.toContain("<time");
  });

  it("is not said while nothing is recorded", () => {
    expect(renderBrokerPage(chrome, input())).not.toContain(
      "bekräftade senast",
    );
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

describe("the update request", () => {
  const stale = withFacts({
    feePolicy: "Avgiften höjdes senast 2025.",
    confirmedAt: "2026-01-19T10:00:00.000Z",
  });

  function offer(
    overrides: Partial<BrokerUpdateRequestOffer> = {},
  ): BrokerUpdateRequestOffer {
    return {
      requestable: true,
      staleAfterMonths: 3,
      state: null,
      ...overrides,
    };
  }

  it("is not offered over facts that are current", () => {
    const html = renderBrokerPage(chrome, stale, offer({ requestable: false }));

    expect(html).not.toContain("<form");
    expect(html).not.toContain("Be styrelsen se över uppgifterna");
  });

  it("renders the page exactly as before when nothing is offered", () => {
    // The default is the page every association had before the form existed.
    expect(renderBrokerPage(chrome, stale)).toBe(
      renderBrokerPage(chrome, stale, offer({ requestable: false })),
    );
  });

  it("is a plain form posting to its fixed address once the facts are stale", () => {
    const html = renderBrokerPage(chrome, stale, offer());

    expect(html).toContain(
      `<form action="${BROKER_UPDATE_REQUEST_PATH}" method="post">`,
    );
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="apartment"');
    expect(html).toContain('<textarea name="note" rows="3" maxLength="280">');
    // The decoy, rendered as every public form renders it.
    expect(html).toContain('name="website"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<script");
  });

  it("names the board's own threshold above the form", () => {
    expect(
      renderBrokerPage(chrome, stale, offer({ staleAfterMonths: 1 })),
    ).toContain("för mer än 1 månad sedan");
    expect(
      renderBrokerPage(chrome, stale, offer({ staleAfterMonths: 6 })),
    ).toContain("för mer än 6 månader sedan");
  });

  it("says who asks, why, on what ground and for how long, beside the button", () => {
    const html = renderBrokerPage(chrome, stale, offer());

    expect(html).toContain("Brf Talgoxen ber om din adress");
    expect(html).toContain("berättigade intresse");
    expect(html).toContain("30 dagar efter att styrelsen har svarat");
    expect(html).toContain("senast 90 dagar");
    // No privacy notice published, so nothing to link to.
    expect(html).not.toContain("Så hanterar föreningen personuppgifter");

    const withNotice = renderBrokerPage(
      { ...chrome, privacyNoticePath: "/integritet" },
      stale,
      offer(),
    );
    expect(withNotice).toContain(
      '<a href="/integritet">Så hanterar föreningen personuppgifter</a>',
    );
  });

  it("asks for an address and no phone number", () => {
    const html = renderBrokerPage(chrome, stale, offer());

    expect(html).toMatch(
      /<input type="email"[^>]*required=""[^>]*name="email"/,
    );
    expect(html).not.toContain('name="phone"');
    expect(html).not.toContain('type="tel"');
    // The name and the apartment are the broker's to give or not.
    expect(html).not.toMatch(/required=""[^>]*name="name"/);
    expect(html).not.toMatch(/required=""[^>]*name="apartment"/);
  });

  it("confirms a request in place of the form, even once the facts are current", () => {
    for (const requestable of [true, false]) {
      const html = renderBrokerPage(
        chrome,
        stale,
        offer({ requestable, state: "sent" }),
      );
      expect(html).toContain("Förfrågan har nått styrelsen");
      expect(html).not.toContain("<form");
    }
  });

  it("keeps the form under a refusal, so the broker can send it again", () => {
    const refused = renderBrokerPage(
      chrome,
      stale,
      offer({ state: "refused" }),
    );
    expect(refused).toContain("Förfrågan kunde inte läsas");
    expect(refused).toContain("<form");

    const limited = renderBrokerPage(
      chrome,
      stale,
      offer({ state: "limited" }),
    );
    expect(limited).toContain("För många förfrågningar");
    expect(limited).toContain("<form");
  });

  it("says the facts are current only when they are", () => {
    expect(
      renderBrokerPage(
        chrome,
        stale,
        offer({ requestable: false, state: "current" }),
      ),
    ).toContain("Styrelsen har bekräftat uppgifterna sedan du öppnade sidan");
    // A query typed by hand over stale facts gets the form, not the sentence.
    const handTyped = renderBrokerPage(
      chrome,
      stale,
      offer({ state: "current" }),
    );
    expect(handTyped).not.toContain("sedan du öppnade sidan");
    expect(handTyped).toContain("<form");
  });
});

describe("what the update request endpoint answers with", () => {
  it("reads back exactly the four outcomes it writes", () => {
    for (const state of ["sent", "refused", "limited", "current"] as const) {
      const value = new URL(
        brokerUpdateRequestAnswerPath(state),
        "http://instance.test",
      ).searchParams.get("uppdatering");
      expect(brokerUpdateRequestState(value ?? undefined)).toBe(state);
    }
  });

  it("reads anything else as nothing having been sent", () => {
    expect(brokerUpdateRequestState(undefined)).toBeNull();
    expect(brokerUpdateRequestState("")).toBeNull();
    expect(brokerUpdateRequestState("<b>skickad</b>")).toBeNull();
  });

  it("always answers on the page's own Swedish address", () => {
    expect(brokerUpdateRequestAnswerPath("sent")).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
  });
});
