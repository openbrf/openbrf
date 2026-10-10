import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { DataSubjectRequestView } from "../api/data-protection";
import { DataSubjectRequestsSection } from "./DataSubjectRequestsSection";
import type { ErasureWaitingOn } from "./register-api";

/**
 * Which actions a request offers, and what closing one takes.
 *
 * Closing is the only thing that lifts a granted restriction or objection, so
 * what this pins down is that it stays on offer after the decision and goes
 * away only with the closure itself - and that it is two presses with a reason
 * rather than one click that cannot be taken back. That the closure clears the
 * person's flag is the API's own test against a real database.
 */

const {
  closeDataSubjectRequest,
  decideDataSubjectRequest,
  extendDataSubjectRequest,
} = vi.hoisted(() => ({
  closeDataSubjectRequest: vi.fn(),
  decideDataSubjectRequest: vi.fn(),
  extendDataSubjectRequest: vi.fn(),
}));

vi.mock("../api/data-protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/data-protection")>()),
  closeDataSubjectRequest,
  decideDataSubjectRequest,
  extendDataSubjectRequest,
}));

function aRequest(
  overrides: Partial<DataSubjectRequestView> = {},
): DataSubjectRequestView {
  return {
    requestId: "request-1",
    personId: "person-1",
    kind: "RESTRICTION",
    requestedOn: "2026-09-01",
    dueOn: "2026-10-01",
    extendedOn: null,
    extensionReason: null,
    ground: "Jag bestrider att uppgifterna stämmer.",
    erasureGround: null,
    issueId: null,
    decision: null,
    erasureException: null,
    decisionGround: null,
    decidedAt: null,
    decidedByPersonId: null,
    executedAt: null,
    closedAt: null,
    closeReason: null,
    recordedByPersonId: "board-1",
    state: "open",
    ...overrides,
  };
}

const GRANTED_RESTRICTION = aRequest({
  decision: "GRANTED",
  decisionGround: "Styrelsen bifaller begäran.",
  decidedAt: "2026-09-02T10:00:00.000Z",
  decidedByPersonId: "board-1",
  state: "granted",
});

function renderSection(
  request: DataSubjectRequestView,
  onChanged: () => void = vi.fn(),
  erasureWaitingOn: ErasureWaitingOn | null = null,
) {
  render(
    <DataSubjectRequestsSection
      personId="person-1"
      requests={[request]}
      erasureWaitingOn={erasureWaitingOn}
      onChanged={onChanged}
    />,
  );
  // The row itself, not the lists inside it.
  return within(screen.getAllByRole("listitem")[0] as HTMLElement);
}

beforeEach(() => {
  closeDataSubjectRequest.mockReset();
  decideDataSubjectRequest.mockReset();
  extendDataSubjectRequest.mockReset();
});

describe("a request's actions", () => {
  it("offers Decide and Close on an open, undecided request", () => {
    const row = renderSection(aRequest());

    expect(row.getByRole("button", { name: "Fatta beslut" })).not.toBeNull();
    expect(row.getByRole("button", { name: "Avsluta" })).not.toBeNull();
  });

  it("offers Close on a granted restriction, and no second decision", () => {
    const row = renderSection(GRANTED_RESTRICTION);

    expect(row.getByRole("button", { name: "Avsluta" })).not.toBeNull();
    expect(row.queryByRole("button", { name: "Fatta beslut" })).toBeNull();
  });

  it("offers neither on a request closed without a decision", () => {
    const row = renderSection(
      aRequest({
        closedAt: "2026-09-03T10:00:00.000Z",
        closeReason: "Personen återkallade begäran.",
        state: "closed",
      }),
    );

    expect(row.queryByRole("button", { name: "Fatta beslut" })).toBeNull();
    expect(row.queryByRole("button", { name: "Avsluta" })).toBeNull();
  });

  it("offers neither on a decided request that has been closed", () => {
    const row = renderSection({
      ...GRANTED_RESTRICTION,
      closedAt: "2026-09-03T10:00:00.000Z",
      closeReason: "Begränsningen hävdes.",
      state: "closed",
    });

    expect(row.queryByRole("button", { name: "Fatta beslut" })).toBeNull();
    expect(row.queryByRole("button", { name: "Avsluta" })).toBeNull();
  });
});

describe("extending the month", () => {
  it("is offered on an undecided request inside its first month", () => {
    const row = renderSection(aRequest());

    expect(
      row.getByRole("button", { name: "Förläng med två månader" }),
    ).not.toBeNull();
  });

  it.each([
    ["one that is past its month", aRequest({ state: "overdue" })],
    [
      "one that is already extended",
      aRequest({
        extendedOn: "2026-09-20",
        extensionReason: "Flera system.",
        dueOn: "2026-12-01",
      }),
    ],
    ["one that is decided", GRANTED_RESTRICTION],
  ])("is not offered on %s", (_name, request) => {
    const row = renderSection(request);

    expect(
      row.queryByRole("button", { name: "Förläng med två månader" }),
    ).toBeNull();
  });

  it("says what was told and when, on an extended request", () => {
    const row = renderSection(
      aRequest({
        extendedOn: "2026-09-20",
        extensionReason: "Begäran gäller flera system.",
        dueOn: "2026-12-01",
      }),
    );

    // The date is a register value and the reason is the board's own writing.
    const date = row.getByText("2026-09-20");
    expect(date.className).toContain("font-data");
    expect(date.parentElement?.textContent).toBe(
      "Förlängd 2026-09-20: Begäran gäller flera system.",
    );
    expect(date.parentElement?.className ?? "").not.toContain("font-data");
    expect(row.getByText("2026-12-01")).not.toBeNull();
  });

  it("asks for the reason, sends nothing without one, and sends it trimmed", async () => {
    extendDataSubjectRequest.mockResolvedValue({
      ok: true,
      value: aRequest({ extendedOn: "2026-09-20", dueOn: "2026-12-01" }),
    });
    const onChanged = vi.fn();
    const row = renderSection(aRequest(), onChanged);

    await userEvent.click(
      row.getByRole("button", { name: "Förläng med två månader" }),
    );
    expect(extendDataSubjectRequest).not.toHaveBeenCalled();

    await userEvent.click(row.getByRole("button", { name: "Förläng begäran" }));
    expect(extendDataSubjectRequest).not.toHaveBeenCalled();
    expect(row.getByRole("alert").textContent).toContain(
      "Skriv skälet som personen fick höra",
    );

    await userEvent.type(
      row.getByLabelText("Varför månaden förlängs"),
      "  Begäran gäller flera system.  ",
    );
    await userEvent.click(row.getByRole("button", { name: "Förläng begäran" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(extendDataSubjectRequest).toHaveBeenCalledWith("request-1", {
      reason: "Begäran gäller flera system.",
    });
  });

  it("says why when the API refuses, as the first month having run out", async () => {
    extendDataSubjectRequest.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "extension-too-late" },
    });
    const row = renderSection(aRequest());

    await userEvent.click(
      row.getByRole("button", { name: "Förläng med två månader" }),
    );
    await userEvent.type(row.getByLabelText("Varför månaden förlängs"), "Skäl");
    await userEvent.click(row.getByRole("button", { name: "Förläng begäran" }));

    await waitFor(() => {
      expect(row.getByText(/Den första månaden har gått ut/)).not.toBeNull();
    });
  });
});

describe("closing a request", () => {
  it("asks first, says what is lifted, and sends nothing on the first press", async () => {
    const row = renderSection(GRANTED_RESTRICTION);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));

    expect(closeDataSubjectRequest).not.toHaveBeenCalled();
    expect(row.getByText(/Begränsningen hävs/)).not.toBeNull();
    expect(row.getByText(/Underrätta personen innan/)).not.toBeNull();
    expect(row.getByRole("button", { name: "Avsluta begäran" })).not.toBeNull();
  });

  it("will not close without a reason", async () => {
    const row = renderSection(GRANTED_RESTRICTION);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(row.getByLabelText("Varför begäran avslutas"), "   ");
    await userEvent.click(row.getByRole("button", { name: "Avsluta begäran" }));

    expect(closeDataSubjectRequest).not.toHaveBeenCalled();
    expect(row.getByRole("alert").textContent).toContain(
      "Skriv varför begäran avslutas",
    );
    const field = row.getByLabelText("Varför begäran avslutas");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(
      row.getByRole("alert").id,
    );
  });

  it("can be cancelled without sending anything", async () => {
    const row = renderSection(GRANTED_RESTRICTION);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.click(row.getByRole("button", { name: "Avbryt" }));

    expect(closeDataSubjectRequest).not.toHaveBeenCalled();
    expect(row.queryByRole("button", { name: "Avsluta begäran" })).toBeNull();
  });

  it("closes a granted restriction with the reason, and reloads the person", async () => {
    closeDataSubjectRequest.mockResolvedValue({
      ok: true,
      value: {
        ...GRANTED_RESTRICTION,
        closedAt: "2026-09-03T10:00:00.000Z",
        closeReason: "Personen återkallade begäran.",
        state: "closed",
      },
    });
    const onChanged = vi.fn();
    const row = renderSection(GRANTED_RESTRICTION, onChanged);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(
      row.getByLabelText("Varför begäran avslutas"),
      "  Personen återkallade begäran.  ",
    );
    await userEvent.click(row.getByRole("button", { name: "Avsluta begäran" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(closeDataSubjectRequest).toHaveBeenCalledWith("request-1", {
      reason: "Personen återkallade begäran.",
    });
  });

  it("sends one closure however often it is pressed", async () => {
    let answer: (value: unknown) => void = () => undefined;
    closeDataSubjectRequest.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const onChanged = vi.fn();
    const row = renderSection(GRANTED_RESTRICTION, onChanged);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(
      row.getByLabelText("Varför begäran avslutas"),
      "Upphävd.",
    );
    const confirm = row.getByRole("button", { name: "Avsluta begäran" });
    await userEvent.dblClick(confirm);
    await userEvent.click(confirm);

    // Busy while it is in flight, so the board can see it was taken.
    const busy = row.getByRole("button", { name: "Sparar..." });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(closeDataSubjectRequest).toHaveBeenCalledTimes(1);

    answer({ ok: true, value: { ...GRANTED_RESTRICTION, state: "closed" } });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(closeDataSubjectRequest).toHaveBeenCalledTimes(1);
  });

  it("sends one closure when the form is submitted twice before it renders again", async () => {
    closeDataSubjectRequest.mockReturnValue(new Promise(() => undefined));
    const row = renderSection(GRANTED_RESTRICTION);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(
      row.getByLabelText("Varför begäran avslutas"),
      "Upphävd.",
    );
    // Straight at the form, past the disabled button: what is left to stop the
    // second POST is the form's own record that one is already on its way.
    const form = row.getByLabelText("Varför begäran avslutas").closest("form");
    if (form === null) {
      throw new Error("the close form is not rendered");
    }
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(closeDataSubjectRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the form up while the closure is in flight, and shows its failure", async () => {
    let answer: (value: unknown) => void = () => undefined;
    closeDataSubjectRequest.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const onChanged = vi.fn();
    const row = renderSection(aRequest(), onChanged);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(
      row.getByLabelText("Varför begäran avslutas"),
      "Personen återkallade begäran.",
    );
    await userEvent.click(row.getByRole("button", { name: "Avsluta begäran" }));

    // Neither toggle can take the form away while the answer is outstanding.
    const toggle = row.getByRole("button", { name: "Avsluta" });
    const decide = row.getByRole("button", { name: "Fatta beslut" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect((decide as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(toggle);
    await userEvent.click(decide);

    answer({ ok: false, failure: { status: 403, reason: "forbidden" } });

    expect(
      await row.findByText("Ditt konto får inte ändra detta."),
    ).not.toBeNull();
    expect(
      (row.getByLabelText("Varför begäran avslutas") as HTMLTextAreaElement)
        .value,
    ).toBe("Personen återkallade begäran.");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    // A refusal that says nothing about the row leaves the list as it is.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("says why when the closure is refused, and reloads the closed row", async () => {
    closeDataSubjectRequest.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-closed" },
    });
    const onChanged = vi.fn();
    const row = renderSection(GRANTED_RESTRICTION, onChanged);

    await userEvent.click(row.getByRole("button", { name: "Avsluta" }));
    await userEvent.type(
      row.getByLabelText("Varför begäran avslutas"),
      "Upphävd.",
    );
    await userEvent.click(row.getByRole("button", { name: "Avsluta begäran" }));

    expect(await row.findByText("Begäran är redan avslutad.")).not.toBeNull();
    // Someone else closed it, so the list is reloaded to show that closure.
    expect(onChanged).toHaveBeenCalledTimes(1);
    // And the form is back to a press that can be retried.
    expect(
      (
        row.getByRole("button", {
          name: "Avsluta begäran",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe("what a granted erasure request is waiting on", () => {
  /*
   * The purge's log line was the only place that said why a granted erasure
   * stayed open, so the row read "granted" for as long as a hold, an open
   * matter or a running letting kept it. What is pinned down here is that the
   * row says which, and the day a letting holds it to - and that nothing of
   * it shows on any other request.
   */
  const GRANTED_ERASURE = aRequest({
    kind: "ERASURE",
    erasureGround: "NO_LONGER_NECESSARY",
    decision: "GRANTED",
    erasureException: "NONE",
    decisionGround: "Styrelsen bifaller begäran.",
    decidedAt: "2026-09-02T10:00:00.000Z",
    decidedByPersonId: "board-1",
    state: "granted",
  });

  function waitingOn(
    overrides: Partial<ErasureWaitingOn> = {},
  ): ErasureWaitingOn {
    return {
      requestId: GRANTED_ERASURE.requestId,
      status: "blocked",
      refusal: null,
      domains: [{ domain: "subletApplications", owed: 0, kept: 1 }],
      lettingLastDay: "2027-03-31",
      ...overrides,
    };
  }

  it("names a consented letting holding the request, and its last day", () => {
    const row = renderSection(GRANTED_ERASURE, vi.fn(), waitingOn());

    expect(row.getByText("Vad raderingen väntar på")).not.toBeNull();
    expect(row.getByText(/^Hålls öppen\./)).not.toBeNull();
    expect(
      row.getByText("Ansökningar om andrahandsupplåtelse").closest("li")
        ?.textContent,
    ).toContain("1 sparas");
    expect(
      row.getByText(/löper till och med 2027-03-31/).textContent,
    ).toContain("anteckna dess sista dag");
  });

  it("names the rule that refuses the purge, beside what the domains still owe", () => {
    const row = renderSection(
      GRANTED_ERASURE,
      vi.fn(),
      waitingOn({
        refusal: "on-legal-hold",
        domains: [
          { domain: "bookings", owed: 2, kept: 0 },
          { domain: "motions", owed: 1, kept: 1 },
        ],
        lettingLastDay: null,
      }),
    );

    expect(
      row.getByText(
        "Ett rättsligt bevarandekrav gäller för personen (art. 17.3 e).",
      ),
    ).not.toBeNull();
    expect(row.getByText("Bokningar").closest("li")?.textContent).toBe(
      "Bokningar: 2 inte raderade än",
    );
    expect(row.getByText("Motioner").closest("li")?.textContent).toContain(
      "1 inte raderad än, 1 sparas",
    );
    expect(row.queryByText(/löper till och med/)).toBeNull();
  });

  it("says the purge has not got through yet, rather than that something holds it", () => {
    const row = renderSection(
      GRANTED_ERASURE,
      vi.fn(),
      waitingOn({
        status: "incomplete",
        domains: [{ domain: "chat", owed: 4, kept: 0 }],
        lettingLastDay: null,
      }),
    );

    expect(row.getByText(/^Inte klar än\./)).not.toBeNull();
    expect(row.queryByText(/^Hålls öppen/)).toBeNull();
  });

  it("says the next run closes it where nothing is left", () => {
    const row = renderSection(
      GRANTED_ERASURE,
      vi.fn(),
      waitingOn({ status: "incomplete", domains: [], lettingLastDay: null }),
    );

    expect(row.getByText(/^Inget återstår att radera\./)).not.toBeNull();
  });

  it("shows nothing on a request it is not about, or once the erasure is carried out", () => {
    const other = renderSection(
      GRANTED_RESTRICTION,
      vi.fn(),
      waitingOn({ requestId: "another-request" }),
    );
    expect(other.queryByText("Vad raderingen väntar på")).toBeNull();
    cleanup();

    // Carried out and not yet closed is the window of a single night, and it
    // is waiting on nothing.
    const executed = renderSection(
      { ...GRANTED_ERASURE, executedAt: "2026-09-03", state: "executed" },
      vi.fn(),
      waitingOn(),
    );
    expect(executed.queryByText("Vad raderingen väntar på")).toBeNull();
  });
});
