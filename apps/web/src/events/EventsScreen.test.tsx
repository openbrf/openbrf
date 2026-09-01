import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import { EventsScreen } from "./EventsScreen";

/**
 * Which half of the event screen a seat is given.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's half lists
 * the drafts the association has not announced yet, and the roll-call under it is
 * named residents. A screen that asked for either on a resident's behalf would be
 * asking the server for things it has nowhere to put. So this file asserts the
 * request as well as the panel.
 */

const fetchUpcomingOccurrences = vi.fn();
const fetchEventSeries = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchUpcomingOccurrences: () => fetchUpcomingOccurrences(),
  fetchEventSeries: () => fetchEventSeries(),
}));

/**
 * What the board's half says once its read has landed and found nothing.
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

describe("the board", () => {
  const BOARD = ["events:attend", "events:manage"];

  it("is given both halves", async () => {
    render(<EventsScreen viewer={viewer(BOARD)} />);

    await waitFor(() => {
      expect(screen.getByText(BOARD_HALF_IS_EMPTY)).toBeTruthy();
    });
    expect(screen.getByText("På gång")).toBeTruthy();
    expect(screen.getByText("Styrelsens kalender")).toBeTruthy();
  });

  it("reads each half from its own endpoint", async () => {
    render(<EventsScreen viewer={viewer(BOARD)} />);

    await waitFor(() => {
      expect(fetchEventSeries).toHaveBeenCalledTimes(1);
    });
    // Two reads and not one shared answer: neither can stand in for the other,
    // because one carries the caller's own place at published dates and the other
    // carries every series including the drafts.
    expect(fetchUpcomingOccurrences).toHaveBeenCalledTimes(1);
  });
});

describe("a seat that arranges the calendar without attending it", () => {
  it("is given the board's half alone", async () => {
    // No seat grants this today. The screen must not rely on that: an entry
    // gated the other way round would hide the whole module from it.
    render(<EventsScreen viewer={viewer(["events:manage"])} />);

    await waitFor(() => {
      expect(screen.getByText(BOARD_HALF_IS_EMPTY)).toBeTruthy();
    });
    expect(screen.queryByText("På gång")).toBeNull();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
  });
});

describe("an account with neither capability", () => {
  it("is given the heading and nothing else, and asks for nothing", async () => {
    // The external property manager. They handle the association's issues and do
    // not live in the building, so a place at the cleaning day is not theirs to
    // take and its dates are not theirs to arrange.
    render(<EventsScreen viewer={viewer(["issues:handle", "self:manage"])} />);

    expect(screen.getByText("Evenemang")).toBeTruthy();
    expect(screen.queryByText("På gång")).toBeNull();
    expect(screen.queryByText("Styrelsens kalender")).toBeNull();
    expect(fetchUpcomingOccurrences).not.toHaveBeenCalled();
    expect(fetchEventSeries).not.toHaveBeenCalled();
  });
});
