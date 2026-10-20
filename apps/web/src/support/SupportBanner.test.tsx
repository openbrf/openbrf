import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import i18n from "../i18n";
import { formatMoment } from "../ui/moment";
import { SupportBanner } from "./SupportBanner";

/**
 * The standing banner of a support session (ADR 0028): the sentence is in the
 * UI face, in whichever language the viewer reads, and the time it ends in the
 * data face.
 */

const ENDS_AT = "2026-10-20T18:00:00.000Z";

afterEach(async () => {
  await i18n.changeLanguage("sv");
});

describe("SupportBanner", () => {
  it("sets the end time in the data face inside the Swedish sentence", () => {
    render(<SupportBanner supporter="Kim at the host" endsAt={ENDS_AT} />);

    const time = screen.getByText(formatMoment(ENDS_AT, "sv"));
    expect(time.className).toContain("font-data");
    expect(time.parentElement?.textContent).toBe(
      `Supportåtkomst: Kim at the host tittar på instansen på administratörens uppdrag. Inget kan ändras. Åtkomsten upphör ${formatMoment(ENDS_AT, "sv")}.`,
    );
    expect(time.parentElement?.className ?? "").not.toContain("font-data");
  });

  it("sets the end time in the data face inside the English sentence", async () => {
    await i18n.changeLanguage("en");
    render(<SupportBanner supporter="Kim at the host" endsAt={ENDS_AT} />);

    const time = screen.getByText(formatMoment(ENDS_AT, "en"));
    expect(time.className).toContain("font-data");
    expect(time.parentElement?.textContent).toContain(
      `It ends at ${formatMoment(ENDS_AT, "en")}.`,
    );
  });
});

describe("a supporter's name that looks like markup", () => {
  // The host names its supporter in free text: a closing tag must not end the
  // sentence before it says that nothing can be changed, and a tag must not
  // become one.
  const SENTENCES = {
    sv: (supporter: string, endsAt: string) =>
      `Supportåtkomst: ${supporter} tittar på instansen på administratörens uppdrag. Inget kan ändras. Åtkomsten upphör ${endsAt}.`,
    en: (supporter: string, endsAt: string) =>
      `Support access: ${supporter} is looking at this instance on the administrator's instruction. Nothing can be changed. It ends at ${endsAt}.`,
  };

  for (const locale of ["sv", "en"] as const) {
    for (const supporter of [
      "Kim </0>",
      "Kim <br/> Host",
      "Kim <data>Host</data>",
    ]) {
      it(`keeps ${JSON.stringify(supporter)} literal in the ${locale} sentence`, async () => {
        await i18n.changeLanguage(locale);
        render(<SupportBanner supporter={supporter} endsAt={ENDS_AT} />);

        const time = screen.getByText(formatMoment(ENDS_AT, locale));
        const sentence = time.parentElement as HTMLElement;
        expect(sentence.textContent).toBe(
          SENTENCES[locale](supporter, formatMoment(ENDS_AT, locale)),
        );
        expect(
          [...sentence.querySelectorAll(".font-data")].map(
            (span) => span.textContent,
          ),
        ).toEqual([formatMoment(ENDS_AT, locale)]);
        expect(sentence.querySelector("br")).toBeNull();
      });
    }
  }
});
