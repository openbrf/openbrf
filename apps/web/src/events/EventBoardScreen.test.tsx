import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { asSupportSession } from "../support/support-fixtures";
import { EventBoardScreen } from "./EventBoardScreen";

/**
 * The board's page for events: the calendar as the board keeps it.
 *
 * The API refuses every call whatever the browser was shown, so hiding the page
 * is courtesy. What is not courtesy is the read behind it: the board's calendar
 * lists the drafts the association has not announced yet, and the roll-call
 * under it is named residents. A page that asked for either on a resident's
 * behalf would be asking the server for things it has nowhere to put. So this
 * file asserts the request as well as the panel.
 */

const fetchUpcomingOccurrences = vi.fn();
const fetchEventSeries = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchUpcomingOccurrences: () => fetchUpcomingOccurrences(),
  fetchEventSeries: () => fetchEventSeries(),
}));

/**
 * What the board's calendar says once its read has landed and found nothing.
 *
 * Waited on rather than the panel's own title, which is rendered before the read
 * comes back: a marker that is already on screen would let a test pass while
 * nothing had been asked for at all.
 */
const BOARD_HALF_IS_EMPTY =
  "Inget evenemang har ett tillfälle i den här perioden. " +
  "Använd tidigare och senare för att titta på en annan.";

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-elin",
    firstName: "Elin",
    lastName: "Hammar",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

beforeEach(() => {
  fetchUpcomingOccurrences.mockReset().mockResolvedValue({
    ok: true,
    value: [],
  });
  fetchEventSeries.mockReset().mockResolvedValue({ ok: true, value: [] });
});

describe("the board", () => {
  const BOARD = ["events:attend", "events:manage"];

  it("is given the page under the board's sign", async () => {
    render(<EventBoardScreen viewer={viewer(BOARD)} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelsen Hantera evenemang",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(BOARD_HALF_IS_EMPTY)).toBeTruthy();
    });
    expect(screen.getByText("Styrelsens kalender")).toBeTruthy();
  });

  it("reads the board's calendar and not what is coming", async () => {
    render(<EventBoardScreen viewer={viewer(BOARD)} />);

    await waitFor(() => {
      expect(fetchEventSeries).toHaveBeenCalledTimes(1);
    });
    // What is coming, with the caller's own place at each date, is the house's
    // page, which a board member who lives here reads like anybody else.
    expect(screen.queryByText("På gång")).toBeNull();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
  });
});

describe("a support session", () => {
  it("is given the board's calendar, read only", async () => {
    // What a support session holds of this module (ADR 0028): events:manage,
    // which opens the board's calendar, and never events:attend.
    render(
      <EventBoardScreen viewer={asSupportSession(viewer(["events:manage"]))} />,
    );

    await waitFor(() => {
      expect(screen.getByText(BOARD_HALF_IS_EMPTY)).toBeTruthy();
    });
    expect(screen.getByText("Styrelsens kalender")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Lägg in evenemanget" }),
    ).toBeNull();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
  });
});

describe("somebody living here who is not on the board", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(<EventBoardScreen viewer={viewer(["events:attend"])} />);

    expect(
      screen.getByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByText("Styrelsens kalender")).toBeNull();
    expect(fetchEventSeries).not.toHaveBeenCalled();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
  });
});
