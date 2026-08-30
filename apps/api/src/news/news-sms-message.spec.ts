import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import { composeNewsSms, MAX_SMS_CHARACTERS } from "./news-sms-message";

/**
 * What a member reads, and what survives the message being too long.
 *
 * The address is the whole point of the message, so the cases below hold the
 * composer to cutting the headline and never the link.
 */

const t = ((key: string, values: Record<string, string>) =>
  `${values.association}: ${values.title}`) as unknown as TFunction;

const URL = "https://brf.example/nyheter/tvattstugan";

describe("composing a news text message", () => {
  it("carries the association, the headline and the address", () => {
    expect(
      composeNewsSms({
        t,
        association: "BRF Ekhagen",
        title: "Nya tider i tvattstugan",
        articleUrl: URL,
      }),
    ).toBe(`BRF Ekhagen: Nya tider i tvattstugan\n${URL}`);
  });

  it("cuts a long headline and leaves the address whole", () => {
    const message = composeNewsSms({
      t,
      association: "BRF Ekhagen",
      title: "x".repeat(500),
      articleUrl: URL,
    });

    expect(message.length).toBeLessThanOrEqual(MAX_SMS_CHARACTERS);
    expect(message.endsWith(`\n${URL}`)).toBe(true);
    expect(message).toContain("...");
  });

  it("keeps the address when it alone is longer than the budget", () => {
    // Nothing here can shorten a URL without breaking it, so the bound is the
    // one thing that gives way: a message with a working link beats a short one
    // with a broken one.
    const long = `https://brf.example/nyheter/${"a".repeat(400)}`;

    expect(
      composeNewsSms({
        t,
        association: "BRF Ekhagen",
        title: "Nya tider",
        articleUrl: long,
      }),
    ).toBe(long);
  });
});
