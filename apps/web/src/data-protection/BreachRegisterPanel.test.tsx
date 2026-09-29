import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BreachView } from "../api/data-protection";
import { BreachRegisterPanel } from "./BreachRegisterPanel";

/**
 * The decision a board records on a personal data breach.
 *
 * What this file pins down is the reading of the one field the browser hands
 * back in a shape the API does not take. A datetime-local control holds
 * "2026-09-06T13:00" - the reader's own wall clock, no seconds and no zone -
 * and the endpoint takes an instant. Sending the string as written is refused
 * by the server, and refused as a generic failure, so the board reads "the
 * decision could not be saved" about a form with nothing visibly wrong with it.
 *
 * The conversion is also the only place that knows what the string means: the
 * moment is the board member's own, in their own zone, and a server elsewhere
 * cannot recover that from the text.
 */

const decideBreach = vi.fn();
const updateBreach = vi.fn();

vi.mock("../api/data-protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/data-protection")>()),
  decideBreach: (breachId: string, input: unknown) =>
    decideBreach(breachId, input),
  updateBreach: (breachId: string, input: unknown) =>
    updateBreach(breachId, input),
}));

/** Discovered a week ago, so anything notified today is past the bound. */
const DISCOVERED_AT = "2026-08-30T09:00:00.000Z";
const NOTIFY_BY = "2026-09-02T09:00:00.000Z";

const BREACH: BreachView = {
  breachId: "breach-1",
  title: "Utskick till fel mottagare",
  description: "Ett utskick gick till en lista som inte var foreningens.",
  occurredAt: null,
  discoveredAt: DISCOVERED_AT,
  imyNotifyBy: NOTIFY_BY,
  personalDataCategories: ["name"],
  dataSubjectCategories: ["member"],
  dataDescription: "Namn och adresser.",
  affectedCount: null,
  effects: "Mottagaren kunde lasa namn och adresser.",
  measures: "Utskicket aterkallades.",
  risk: null,
  imyNotificationRequired: null,
  imyDecisionGround: null,
  imyNotifiedAt: null,
  imyReference: null,
  delayReasons: null,
  subjectsInformationRequired: null,
  subjectsDecisionGround: null,
  subjectsInformedAt: null,
  decidedAt: null,
  closedAt: null,
  recordedByPersonId: "board-1",
  decidedByPersonId: null,
  closedByPersonId: null,
  remindAt: NOTIFY_BY,
  state: "overdue",
  // Discovered a week ago, so the bound is behind it.
  hoursLeft: -96,
  subjects: [],
};

beforeEach(() => {
  decideBreach.mockReset().mockResolvedValue({ ok: true, value: BREACH });
  updateBreach.mockReset().mockResolvedValue({ ok: true, value: BREACH });
});

/** Opens the decision form on the one breach the panel is given. */
function openTheDecision(): void {
  render(<BreachRegisterPanel breaches={[BREACH]} onDecided={() => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: `Fatta beslut om ${BREACH.title}` }),
  );
}

describe("the date a notification was made", () => {
  it("is sent as an instant rather than as the wall clock the field holds", async () => {
    openTheDecision();

    fireEvent.change(screen.getByLabelText("Skäl för beslutet om IMY"), {
      target: { value: "Hög risk för de registrerade." },
    });
    fireEvent.change(screen.getByLabelText("Underrättad till IMY"), {
      target: { value: "2026-09-06T13:00" },
    });
    // Past the bound, so the reasons for the delay are asked for on the screen.
    fireEvent.change(screen.getByLabelText("Skäl för dröjsmålet (art. 33.1)"), {
      target: { value: "Styrelsen kunde inte sammanträda förrän nu." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spara beslutet" }));

    await waitFor(() => {
      expect(decideBreach).toHaveBeenCalledTimes(1);
    });

    const sent = decideBreach.mock.calls[0]?.[1] as { imyNotifiedAt: string };
    // The same moment the board member picked, said in a way a server in
    // another zone reads the same: what makes this an instant and not a label.
    expect(sent.imyNotifiedAt).toBe(new Date("2026-09-06T13:00").toISOString());
  });

  it("stays absent when the board has not notified IMY yet", async () => {
    /*
     * The empty field is not a moment, and an empty string is not a date. A
     * decision can be recorded before the notification goes out - the two are
     * separate acts, which is why the record holds them separately.
     */
    openTheDecision();

    fireEvent.change(screen.getByLabelText("Skäl för beslutet om IMY"), {
      target: { value: "Incidenten medför en risk." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spara beslutet" }));

    await waitFor(() => {
      expect(decideBreach).toHaveBeenCalledTimes(1);
    });

    const sent = decideBreach.mock.calls[0]?.[1] as {
      imyNotifiedAt: string | null;
    };
    expect(sent.imyNotifiedAt).toBeNull();
  });
});

describe("a breach decided with IMY still owed", () => {
  /** Decided a week ago that IMY is to be notified, and not notified since. */
  const OWED: BreachView = {
    ...BREACH,
    risk: "LIKELY",
    imyNotificationRequired: true,
    imyDecisionGround: "Uppgifterna nådde en obehörig mottagare.",
    subjectsInformationRequired: false,
    decidedAt: "2026-08-30T12:00:00.000Z",
    decidedByPersonId: "board-1",
    state: "overdue",
  };

  it("keeps its clock on the row and offers to record the notification", () => {
    render(<BreachRegisterPanel breaches={[OWED]} onDecided={() => {}} />);

    expect(screen.getByText("Över tiden")).toBeTruthy();
    expect(
      screen.getByText("-96 timmar kvar till 72-timmarsgränsen."),
    ).toBeTruthy();
    // The decision is made, so the act offered is the notification, not a
    // second decision the API would refuse.
    expect(
      screen.queryByRole("button", { name: `Fatta beslut om ${OWED.title}` }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `Anteckna underrättelsen till IMY om ${OWED.title}`,
      }),
    ).toBeTruthy();
  });

  it("reads as owed rather than decided while it is inside the bound", () => {
    render(
      <BreachRegisterPanel
        breaches={[{ ...OWED, state: "notificationOwed", hoursLeft: 30 }]}
        onDecided={() => {}}
      />,
    );

    expect(screen.getByText("Väntar på underrättelse till IMY")).toBeTruthy();
    expect(screen.queryByText("Beslutad")).toBeNull();
  });

  it("records when IMY was notified, as an instant, with the reasons for a late one", async () => {
    const onDecided = vi.fn();
    render(<BreachRegisterPanel breaches={[OWED]} onDecided={onDecided} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Anteckna underrättelsen till IMY om ${OWED.title}`,
      }),
    );
    fireEvent.change(screen.getByLabelText("Underrättad till IMY"), {
      target: { value: "2026-09-06T13:00" },
    });
    fireEvent.change(screen.getByLabelText("IMY:s diarienummer (frivilligt)"), {
      target: { value: "IMY-2026-1234" },
    });
    // Past the bound, so the reasons for the delay are asked for here too.
    fireEvent.change(screen.getByLabelText("Skäl för dröjsmålet (art. 33.1)"), {
      target: { value: "Styrelsen kunde inte sammanträda förrän nu." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Spara underrättelsen" }),
    );

    await waitFor(() => {
      expect(updateBreach).toHaveBeenCalledTimes(1);
    });
    expect(updateBreach).toHaveBeenCalledWith(OWED.breachId, {
      imyNotifiedAt: new Date("2026-09-06T13:00").toISOString(),
      imyReference: "IMY-2026-1234",
      delayReasons: "Styrelsen kunde inte sammanträda förrän nu.",
    });
    // The screen re-reads, which is what takes the row off the clock.
    await waitFor(() => {
      expect(onDecided).toHaveBeenCalledTimes(1);
    });
  });

  /** Opens the notification form on one owed breach. */
  function openTheNotification(breach: BreachView): void {
    render(<BreachRegisterPanel breaches={[breach]} onDecided={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Anteckna underrättelsen till IMY om ${breach.title}`,
      }),
    );
  }

  it("offers no moment before the discovery or after now", () => {
    /*
     * The server refuses both, and a notified-at in the future would take the
     * breach off the clock with IMY still told nothing. The control says so
     * before the board member picks one.
     */
    vi.useFakeTimers({ now: new Date("2026-09-06T12:00:30.000Z") });
    try {
      openTheNotification({
        ...OWED,
        discoveredAt: "2026-08-30T09:00:30.000Z",
      });

      const field = screen.getByLabelText("Underrättad till IMY");
      // The first whole minute not before the discovery, and the minute now.
      expect(field.getAttribute("min")).toBe(
        toWallClockForTest(new Date("2026-08-30T09:01:00.000Z")),
      );
      expect(field.getAttribute("max")).toBe(
        toWallClockForTest(new Date("2026-09-06T12:00:00.000Z")),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the reference already recorded when only the date is saved", async () => {
    /*
     * The form opens on the reference the record holds, and a save that does
     * not change it leaves it out of the request - sending null for an empty
     * field would clear a reference IMY gave.
     */
    openTheNotification({ ...OWED, imyReference: "IMY-2026-1234" });

    expect(
      (
        screen.getByLabelText(
          "IMY:s diarienummer (frivilligt)",
        ) as HTMLInputElement
      ).value,
    ).toBe("IMY-2026-1234");

    fireEvent.change(screen.getByLabelText("Underrättad till IMY"), {
      target: { value: "2026-09-06T13:00" },
    });
    fireEvent.change(screen.getByLabelText("Skäl för dröjsmålet (art. 33.1)"), {
      target: { value: "Styrelsen kunde inte sammanträda förrän nu." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Spara underrättelsen" }),
    );

    await waitFor(() => {
      expect(updateBreach).toHaveBeenCalledTimes(1);
    });
    const sent = updateBreach.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("imyReference");
  });

  it("says why a date outside the breach is refused", async () => {
    updateBreach.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "notified-out-of-range" },
    });
    openTheNotification(OWED);

    fireEvent.change(screen.getByLabelText("Underrättad till IMY"), {
      target: { value: "2026-09-06T13:00" },
    });
    fireEvent.change(screen.getByLabelText("Skäl för dröjsmålet (art. 33.1)"), {
      target: { value: "Styrelsen kunde inte sammanträda förrän nu." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Spara underrättelsen" }),
    );

    expect(
      await screen.findByText(
        "Datumet då IMY underrättades ska ligga efter att incidenten upptäcktes och kan inte ligga i framtiden.",
      ),
    ).toBeTruthy();
  });
});

/** The wall clock a datetime-local control holds, in the test's own zone. */
function toWallClockForTest(instant: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(instant.getFullYear())}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}
