import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { EventsScreen } from "./EventsScreen";

/**
 * The house's page for events: what is coming, and one's own place at it.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's calendar
 * lists the drafts the association has not announced yet, and the roll-call
 * under it is named residents. Arranging the calendar is the board's page now
 * (ADR 0049), so this file asserts that the house's page never asks for it, for
 * a board member as much as for anybody.
 */

const fetchUpcomingOccurrences = vi.fn();
const fetchEventSeries = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchUpcomingOccurrences: () => fetchUpcomingOccurrences(),
  fetchEventSeries: () => fetchEventSeries(),
}));

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

describe("somebody living here", () => {
  it("is given what is coming up", async () => {
    render(<EventsScreen viewer={viewer(["events:attend"])} />);

    await waitFor(() => {
      expect(screen.getByText("Inget är på gång.")).toBeTruthy();
    });
    expect(screen.getByText("På gång")).toBeTruthy();
  });

  it("is not given the calendar the board keeps", async () => {
    render(<EventsScreen viewer={viewer(["events:attend"])} />);

    await waitFor(() => {
      expect(screen.getByText("Inget är på gång.")).toBeTruthy();
    });
    expect(screen.queryByText("Styrelsens kalender")).toBeNull();
  });

  it("never asks the server for it either", async () => {
    render(<EventsScreen viewer={viewer(["events:attend"])} />);

    await waitFor(() => {
      expect(fetchUpcomingOccurrences).toHaveBeenCalledTimes(1);
    });
    // The board's list carries the drafts the association has not announced yet,
    // which is the answer this seat has nowhere to render and no business asking
    // for.
    expect(fetchEventSeries).not.toHaveBeenCalled();
  });
});

describe("an account that does not live here", () => {
  it("is given the heading and nothing else, and asks for nothing", async () => {
    // The external property manager. They handle the association's issues and do
    // not live in the building, so a place at the cleaning day is not theirs to
    // take.
    render(<EventsScreen viewer={viewer(["issues:handle", "self:manage"])} />);

    expect(screen.getByText("Evenemang")).toBeTruthy();
    expect(screen.queryByText("På gång")).toBeNull();
    expect(screen.queryByText("Styrelsens kalender")).toBeNull();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
    expect(fetchEventSeries).not.toHaveBeenCalled();
  });
});

/**
 * One page, one audience: a board member who lives here reads what is coming
 * from here like anybody else, and arranges the calendar on the board's own
 * page (ADR 0049).
 */
describe("a board member who lives here", () => {
  it("shows no board content to a board member", async () => {
    render(
      <EventsScreen viewer={viewer(["events:attend", "events:manage"])} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Inget är på gång.")).toBeTruthy();
    });
    expect(screen.queryByText("Styrelsens kalender")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(fetchEventSeries).not.toHaveBeenCalled();
  });
});
