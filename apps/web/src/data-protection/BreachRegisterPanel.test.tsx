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

vi.mock("../api/data-protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/data-protection")>()),
  decideBreach: (breachId: string, input: unknown) =>
    decideBreach(breachId, input),
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
