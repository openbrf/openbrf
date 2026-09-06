import { describe, expect, it } from "vitest";

import {
  BREACH_NOTIFICATION_HOURS,
  BREACH_REMINDER_HOURS_LEFT,
  breachState,
  computeBreachDeadline,
  computeBreachReminderAt,
  hoursLeft,
} from "./breach-deadline";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/** A breach clock with nothing decided, so the state functions have a row. */
function clock(
  discoveredAt: Date,
  overrides: { decidedAt?: Date | null; closedAt?: Date | null } = {},
): { discoveredAt: Date; decidedAt: Date | null; closedAt: Date | null } {
  return {
    discoveredAt,
    decidedAt: overrides.decidedAt ?? null,
    closedAt: overrides.closedAt ?? null,
  };
}

describe("computeBreachDeadline", () => {
  it("bounds the notification at 72 hours after the association became aware", () => {
    const discoveredAt = new Date("2026-09-07T08:30:00.000Z");

    expect(computeBreachDeadline(discoveredAt)).toEqual(
      new Date("2026-09-10T08:30:00.000Z"),
    );
  });

  it("adds the hours on the instant and not on the calendar", () => {
    /*
     * The night Europe/Stockholm leaves summer time, 2026-10-25, is 25 hours
     * long. Calendar-field arithmetic would put the bound at the same wall
     * clock time three days later, which is 73 hours of real time - an hour
     * more of statutory window than art. 33(1) gives.
     */
    const discoveredAt = new Date("2026-10-24T12:00:00.000Z");

    const bound = computeBreachDeadline(discoveredAt);

    expect(bound.getTime() - discoveredAt.getTime()).toBe(
      BREACH_NOTIFICATION_HOURS * MILLISECONDS_PER_HOUR,
    );
    expect(bound).toEqual(new Date("2026-10-27T12:00:00.000Z"));
  });
});

describe("computeBreachReminderAt", () => {
  it("leaves exactly the reminder window before the bound", () => {
    const discoveredAt = new Date("2026-09-07T08:30:00.000Z");

    const reminderAt = computeBreachReminderAt(discoveredAt);

    expect(
      computeBreachDeadline(discoveredAt).getTime() - reminderAt.getTime(),
    ).toBe(BREACH_REMINDER_HOURS_LEFT * MILLISECONDS_PER_HOUR);
    expect(reminderAt).toEqual(new Date("2026-09-09T08:30:00.000Z"));
  });

  it("returns an instant in the past for a breach discovered days ago", () => {
    // Not an error: a board that is already out of time should be reminded at
    // once rather than never, and the queue runs a past instant immediately.
    const discoveredAt = new Date("2026-09-01T08:00:00.000Z");

    expect(computeBreachReminderAt(discoveredAt).getTime()).toBeLessThan(
      new Date("2026-09-07T08:00:00.000Z").getTime(),
    );
  });
});

describe("hoursLeft", () => {
  it("counts down towards the bound", () => {
    const discoveredAt = new Date("2026-09-07T08:00:00.000Z");

    expect(hoursLeft(discoveredAt, new Date("2026-09-07T08:00:00.000Z"))).toBe(
      72,
    );
    expect(hoursLeft(discoveredAt, new Date("2026-09-09T08:00:00.000Z"))).toBe(
      24,
    );
  });

  it("goes negative once the bound has passed", () => {
    const discoveredAt = new Date("2026-09-07T08:00:00.000Z");

    expect(hoursLeft(discoveredAt, new Date("2026-09-10T14:00:00.000Z"))).toBe(
      -6,
    );
  });

  it("does not round, so a breach with minutes left does not read as having none", () => {
    const discoveredAt = new Date("2026-09-07T08:00:00.000Z");

    expect(
      hoursLeft(discoveredAt, new Date("2026-09-10T07:56:00.000Z")),
    ).toBeCloseTo(0.0667, 3);
  });
});

describe("breachState", () => {
  const now = new Date("2026-09-08T08:00:00.000Z");
  const discoveredAt = new Date("2026-09-07T08:00:00.000Z");

  it("awaits a decision while the bound is ahead", () => {
    expect(breachState(clock(discoveredAt), now)).toBe("awaitingDecision");
  });

  it("is overdue once the bound has passed with no decision", () => {
    expect(
      breachState(clock(discoveredAt), new Date("2026-09-10T09:00:00.000Z")),
    ).toBe("overdue");
  });

  it("is decided whatever the bound says, because the lateness is on the row", () => {
    /*
     * A notification made after 72 hours carries the reasons for the delay
     * (art. 33(1)), which is where the lateness is recorded. Leaving such a
     * breach reading "overdue" for ever would say the board still owed an act
     * it has made.
     */
    const decided = clock(discoveredAt, {
      decidedAt: new Date("2026-09-11T09:00:00.000Z"),
    });

    expect(breachState(decided, new Date("2026-09-12T09:00:00.000Z"))).toBe(
      "decided",
    );
  });

  it("is closed once the board has closed it, which requires a decision", () => {
    const closed = clock(discoveredAt, {
      decidedAt: new Date("2026-09-08T09:00:00.000Z"),
      closedAt: new Date("2026-09-09T09:00:00.000Z"),
    });

    expect(breachState(closed, now)).toBe("closed");
  });
});
