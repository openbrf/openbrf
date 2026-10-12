import { describe, expect, it } from "vitest";

import {
  canExtend,
  dueOn,
  isPastDue,
  requestState,
  toDataSubjectRequestView,
  type DataSubjectRequestRow,
} from "./data-subject-request";

function row(
  overrides: Partial<DataSubjectRequestRow> = {},
): DataSubjectRequestRow {
  return {
    id: "req_1",
    personId: "per_1",
    kind: "ERASURE",
    requestedOn: new Date("2026-09-01T00:00:00.000Z"),
    ground: "Jag har flyttat och vill inte finnas kvar.",
    erasureGround: "NO_LONGER_NECESSARY",
    issueId: null,
    decision: null,
    erasureException: null,
    decisionGround: null,
    decidedAt: null,
    decidedByPersonId: null,
    extendedAt: null,
    extensionReason: null,
    executedAt: null,
    closedAt: null,
    closeReason: null,
    closedByPersonId: null,
    recordedByPersonId: "per_board",
    ...overrides,
  };
}

describe("dueOn", () => {
  it("gives the association one calendar month to answer", () => {
    expect(dueOn(new Date("2026-09-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("lands on the last day of February for a 31 January request", () => {
    /*
     * There is no 31 February to answer on. Clamping to the end of the month
     * keeps the answer inside the month art. 12(3) gives rather than spilling
     * into March, which counting 30 or 31 days would do.
     */
    expect(dueOn(new Date("2026-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("uses the real length of February in a leap year", () => {
    expect(dueOn(new Date("2028-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("clamps a 31st into any shorter month", () => {
    expect(dueOn(new Date("2026-03-31T00:00:00.000Z")).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(dueOn(new Date("2026-12-15T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });

  it("counts calendar months rather than a fixed number of days", () => {
    // February is short and March is long; both give one month, which counting
    // days could not do with a single constant.
    const february = dueOn(new Date("2026-02-01T00:00:00.000Z"));
    const march = dueOn(new Date("2026-03-01T00:00:00.000Z"));

    expect(february.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(march.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("an extension (art. 12(3))", () => {
  it("adds two further months to the first", () => {
    expect(
      dueOn(new Date("2026-09-01T00:00:00.000Z"), true).toISOString(),
    ).toBe("2026-12-01T00:00:00.000Z");
  });

  it("counts them from the end of the first month, clamped in a short one", () => {
    // 31 January is due on 28 February, and extended on 28 April.
    expect(
      dueOn(new Date("2026-01-31T00:00:00.000Z"), true).toISOString(),
    ).toBe("2026-04-28T00:00:00.000Z");
  });

  it("keeps a request open past the first month, and overdue after the third", () => {
    const extended = row({ extendedAt: new Date("2026-09-20T10:00:00.000Z") });

    expect(requestState(extended, new Date("2026-11-15T10:00:00.000Z"))).toBe(
      "open",
    );
    expect(requestState(extended, new Date("2026-12-02T10:00:00.000Z"))).toBe(
      "overdue",
    );
    // The same request, not extended, is long overdue by then.
    expect(requestState(row(), new Date("2026-11-15T10:00:00.000Z"))).toBe(
      "overdue",
    );
  });

  it("is still due all of the extended due day, on the association's calendar", () => {
    const extended = row({ extendedAt: new Date("2026-09-20T10:00:00.000Z") });

    expect(isPastDue(extended, new Date("2026-12-01T22:30:00.000Z"))).toBe(
      false,
    );
    expect(isPastDue(extended, new Date("2026-12-01T23:30:00.000Z"))).toBe(
      true,
    );
  });

  it("can be recorded on an undecided request until the end of its first due day", () => {
    expect(canExtend(row(), new Date("2026-09-20T10:00:00.000Z"))).toBe(true);
    // The first due day is 1 October, which is still inside the month.
    expect(canExtend(row(), new Date("2026-10-01T21:30:00.000Z"))).toBe(true);
    expect(canExtend(row(), new Date("2026-10-01T22:30:00.000Z"))).toBe(false);
  });

  it("cannot be recorded twice, or on a request that is decided or closed", () => {
    const now = new Date("2026-09-20T10:00:00.000Z");

    expect(canExtend(row({ extendedAt: now }), now)).toBe(false);
    expect(canExtend(row({ decision: "REFUSED" }), now)).toBe(false);
    expect(canExtend(row({ closedAt: now }), now)).toBe(false);
  });

  it("is stated on the view with its due date, and the reason the person was told", () => {
    const view = toDataSubjectRequestView(
      row({
        extendedAt: new Date("2026-09-20T10:00:00.000Z"),
        extensionReason: "Begäran gäller många system.",
      }),
      new Date("2026-09-21T10:00:00.000Z"),
    );

    expect(view.dueOn).toBe("2026-12-01");
    expect(view.extendedOn).toBe("2026-09-20");
    expect(view.extensionReason).toBe("Begäran gäller många system.");
    expect(view.state).toBe("open");
  });
});

describe("requestState", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("is open while the month is running and nothing is decided", () => {
    expect(requestState(row(), now)).toBe("open");
  });

  it("is overdue once the art. 12(3) month has passed with no decision", () => {
    expect(requestState(row(), new Date("2026-10-02T00:00:00.000Z"))).toBe(
      "overdue",
    );
  });

  it("is still open all of its due day, on the association's calendar", () => {
    // Due on 1 October. 02:00 there is past the day's first UTC instant, and
    // the month has not run out.
    expect(requestState(row(), new Date("2026-10-01T00:00:00.000Z"))).toBe(
      "open",
    );
    expect(requestState(row(), new Date("2026-10-01T21:30:00.000Z"))).toBe(
      "open",
    );
    // 00:30 on 2 October there, still 1 October in UTC.
    expect(requestState(row(), new Date("2026-10-01T22:30:00.000Z"))).toBe(
      "overdue",
    );
  });

  it("is granted once the board has granted it and before the purge runs", () => {
    expect(
      requestState(
        row({ decision: "GRANTED", decidedAt: new Date("2026-09-05") }),
        now,
      ),
    ).toBe("granted");
  });

  it("is refused, whatever the month says, because a refusal is a final answer", () => {
    expect(
      requestState(
        row({ decision: "REFUSED", decidedAt: new Date("2026-09-05") }),
        new Date("2026-11-01T00:00:00.000Z"),
      ),
    ).toBe("refused");
  });

  it("is executed the night the purge carries a grant out", () => {
    expect(
      requestState(
        row({
          decision: "GRANTED",
          decidedAt: new Date("2026-09-05"),
          executedAt: new Date("2026-09-09"),
        }),
        now,
      ),
    ).toBe("executed");
  });

  it("is closed once there is nothing left to do", () => {
    expect(
      requestState(
        row({
          decision: "GRANTED",
          decidedAt: new Date("2026-09-05"),
          executedAt: new Date("2026-09-09"),
          closedAt: new Date("2026-09-09"),
          closeReason: "purged",
        }),
        now,
      ),
    ).toBe("closed");
  });

  it("reads a withdrawn objection as closed rather than as still open", () => {
    expect(
      requestState(
        row({
          kind: "OBJECTION",
          erasureGround: null,
          closedAt: new Date("2026-09-08"),
        }),
        now,
      ),
    ).toBe("closed");
  });
});

describe("toDataSubjectRequestView", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("states the derived due date beside the request date", () => {
    const view = toDataSubjectRequestView(row(), now);

    expect(view.requestedOn).toBe("2026-09-01");
    expect(view.dueOn).toBe("2026-10-01");
    expect(view.state).toBe("open");
  });

  it("carries the art. 17(1) ground and the art. 17(3) assessment", () => {
    const view = toDataSubjectRequestView(
      row({
        erasureGround: "CONSENT_WITHDRAWN",
        decision: "REFUSED",
        erasureException: "LEGAL_OBLIGATION_TO_KEEP",
        decisionGround: "Medlemsforteckningen far inte gallras.",
        decidedAt: new Date("2026-09-08T10:00:00.000Z"),
      }),
      now,
    );

    expect(view.erasureGround).toBe("CONSENT_WITHDRAWN");
    expect(view.erasureException).toBe("LEGAL_OBLIGATION_TO_KEEP");
    expect(view.decisionGround).toBe("Medlemsforteckningen far inte gallras.");
    expect(view.state).toBe("refused");
  });

  it("carries the issue a request about a description names", () => {
    const view = toDataSubjectRequestView(row({ issueId: "iss_7" }), now);

    expect(view.issueId).toBe("iss_7");
  });

  it("tells the purge closing a request from the board closing it", () => {
    // closedByPersonId null is what says the purge did it: the board's own
    // close carries the person who decided.
    const purged = toDataSubjectRequestView(
      row({
        decision: "GRANTED",
        executedAt: new Date("2026-09-09"),
        closedAt: new Date("2026-09-09"),
        closeReason: "purged",
        closedByPersonId: null,
      }),
      now,
    );

    const byBoard = toDataSubjectRequestView(
      row({
        closedAt: new Date("2026-09-09"),
        closeReason: "withdrawn",
        closedByPersonId: "person-board",
      }),
      now,
    );

    expect(purged.closeReason).toBe("purged");
    expect(purged.closedByPersonId).toBeNull();
    // Both closed, and told apart by who closed them.
    expect(byBoard.state).toBe(purged.state);
    expect(byBoard.closedByPersonId).toBe("person-board");
  });

  it("states the day a decision, an execution and a closing fall on here", () => {
    /*
     * 22:30 UTC on the 21st of June is half past midnight on the 22nd here, and
     * these three are plain `DateTime` rather than `@db.Date`: what they record
     * is a moment, and the day a moment fell on is read on the association's
     * own calendar. The request date beside them is a column and stays the day
     * it was written with.
     */
    const view = toDataSubjectRequestView(
      row({
        decision: "GRANTED",
        decidedAt: new Date("2026-06-21T22:30:00.000Z"),
        executedAt: new Date("2026-06-21T22:35:00.000Z"),
        closedAt: new Date("2026-12-21T23:30:00.000Z"),
      }),
      now,
    );

    expect(view.decidedAt).toBe("2026-06-22");
    expect(view.executedAt).toBe("2026-06-22");
    expect(view.closedAt).toBe("2026-12-22");
    expect(view.requestedOn).toBe("2026-09-01");
  });

  it("leaves an absent decision, execution and closing absent", () => {
    const view = toDataSubjectRequestView(row(), now);

    expect(view.decidedAt).toBeNull();
    expect(view.executedAt).toBeNull();
    expect(view.closedAt).toBeNull();
  });
});
