import { beforeAll, describe, expect, it } from "vite-plus/test";

import { I18nService } from "../i18n/i18n.service";
import type { ReporterLinkPageView } from "../issues/issue-reporter-link.service";
import { renderIssueLinkPage } from "./site-issue-link";
import type { SiteChrome } from "./site-html";

/**
 * The facts at the top of the reporter's link page: the status shows where the
 * issue stands, the date label names the day it was filed. For an English
 * visitor the two once read the same word, "Received", so the page said
 * "Status Received" above "Received 10 November 2026".
 */

const i18n = new I18nService();

const VIEW: ReporterLinkPageView = {
  typeName: "Störning",
  meaning: "NEW",
  createdAt: new Date("2026-11-10T08:00:00.000Z"),
  acceptsMessages: true,
  reopensOnMessage: false,
  messageLimitReached: false,
  messages: [],
};

beforeAll(async () => {
  await i18n.init();
});

function chromeFor(locale: "en" | "sv"): SiteChrome {
  return {
    t: i18n.translatorFor(locale),
    locale,
    associationName: "Brf Talgoxen",
    logoUrl: null,
    css: "",
    mediaUrl: (mediaFileId) => `/api/media/${mediaFileId}`,
    privacyNoticePath: null,
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
}

/**
 * The text of the `<dt>` and `<dd>` pairs of the page's facts, in order. The
 * only markup inside a `<dd>` is the `<time>` around the date, which the
 * pattern steps over, so no tag is stripped from the text.
 */
function facts(html: string): [string, string][] {
  const list =
    /<dl class="site-issue-facts">(.*?)<\/dl>/s.exec(html)?.[1] ?? "";
  return [
    ...list.matchAll(
      /<dt>([^<]*)<\/dt><dd>(?:<time[^>]*>)?([^<]*)(?:<\/time>)?<\/dd>/g,
    ),
  ].map(([, term, value]) => [term ?? "", value ?? ""]);
}

describe("the reporter's link page's facts", () => {
  it("labels the date the issue was filed apart from the status in English", () => {
    const html = renderIssueLinkPage(chromeFor("en"), VIEW, null, "/x");
    const rows = facts(html);

    expect(rows.map(([label]) => label)).toEqual(["Type", "Status", "Filed"]);
    expect(rows[1]?.[1]).toBe("Received");
    const labels = rows.map(([label]) => label);
    expect(labels).not.toContain(rows[1]?.[1]);
  });

  it("keeps the Swedish labels", () => {
    const rows = facts(renderIssueLinkPage(chromeFor("sv"), VIEW, null, "/x"));

    expect(rows.map(([label]) => label)).toEqual(["Typ", "Status", "Inkom"]);
    expect(rows[1]?.[1]).toBe("Mottaget");
  });
});
