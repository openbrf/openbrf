import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import type { DataProtectionOverview } from "../api/data-protection";
import { OverviewStrip } from "./OverviewStrip";

/**
 * What the board reads before it reads anything else.
 *
 * Sentences rather than a row of numbers, and every count reads as a word when
 * it is zero. A board with nothing waiting should be told so: an empty strip
 * looks like a screen that has not finished loading, which is the one message
 * this strip must never send.
 */

/** The moment the counts were read; the strip says what was true then. */
const READ_AT = new Date("2026-09-06T12:00:00.000Z");

const QUIET: DataProtectionOverview = {
  breaches: { awaitingDecision: 0, overdue: 0, nearestDeadline: null },
  requests: { open: 0, overdue: 0 },
  processors: { notRecorded: 0, pending: 0 },
  notice: { missingHeadings: 0, published: true },
};

describe("when nothing is waiting", () => {
  it("says so in every sentence rather than leaving a blank", () => {
    render(<OverviewStrip overview={QUIET} readAt={READ_AT} />);

    expect(
      screen.getByText("Ingen personuppgiftsincident väntar på beslut."),
    ).toBeTruthy();
    expect(screen.getByText("Ingen begäran väntar på svar.")).toBeTruthy();
    expect(
      screen.getByText("Alla mottagare av personuppgifter är klassificerade."),
    ).toBeTruthy();
    expect(
      screen.getByText("Integritetspolicyn svarar på allt art. 13 kräver."),
    ).toBeTruthy();
  });
});

describe("when something is waiting", () => {
  it("names an overdue breach ahead of one still inside its bound", () => {
    // Overdue first, because a breach past 72 hours is the thing the board
    // needs to act on today - and the notification is still owed.
    render(
      <OverviewStrip
        readAt={READ_AT}
        overview={{
          ...QUIET,
          breaches: {
            awaitingDecision: 2,
            overdue: 1,
            nearestDeadline: "2026-09-01T00:00:00.000Z",
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "1 personuppgiftsincident har passerat 72-timmarsgränsen utan beslut.",
      ),
    ).toBeTruthy();
  });

  it("says how long is left on the nearest bound", () => {
    const inTwelveHours = new Date(
      READ_AT.getTime() + 12 * 60 * 60 * 1000,
    ).toISOString();

    render(
      <OverviewStrip
        readAt={READ_AT}
        overview={{
          ...QUIET,
          breaches: {
            awaitingDecision: 1,
            overdue: 0,
            nearestDeadline: inTwelveHours,
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "1 personuppgiftsincident väntar på beslut, 12 timmar kvar.",
      ),
    ).toBeTruthy();
  });

  it("says the notice is unpublished before it counts its headings", () => {
    /*
     * An unpublished notice answers nobody, whatever it contains: a visitor
     * with no account cannot read it, which is who art. 13 is owed to.
     */
    render(
      <OverviewStrip
        readAt={READ_AT}
        overview={{
          ...QUIET,
          notice: { missingHeadings: 4, published: false },
        }}
      />,
    );

    expect(
      screen.getByText("Integritetspolicyn är inte publicerad."),
    ).toBeTruthy();
  });

  it("counts the recipients nobody has classified", () => {
    render(
      <OverviewStrip
        readAt={READ_AT}
        overview={{ ...QUIET, processors: { notRecorded: 3, pending: 1 } }}
      />,
    );

    expect(
      screen.getByText(
        "3 mottagare av personuppgifter är ännu inte klassificerade.",
      ),
    ).toBeTruthy();
  });
});
