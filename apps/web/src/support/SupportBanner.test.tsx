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
