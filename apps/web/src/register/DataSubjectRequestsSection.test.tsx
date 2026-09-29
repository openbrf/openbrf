import {
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

/**
 * Which actions a request offers, and what closing one takes.
 *
 * Closing is the only thing that lifts a granted restriction or objection, so
 * what this pins down is that it stays on offer after the decision and goes
 * away only with the closure itself - and that it is two presses with a reason
 * rather than one click that cannot be taken back. That the closure clears the
 * person's flag is the API's own test against a real database.
 */

const { closeDataSubjectRequest, decideDataSubjectRequest } = vi.hoisted(
  () => ({
    closeDataSubjectRequest: vi.fn(),
    decideDataSubjectRequest: vi.fn(),
  }),
);

vi.mock("../api/data-protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/data-protection")>()),
  closeDataSubjectRequest,
  decideDataSubjectRequest,
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
) {
  render(
    <DataSubjectRequestsSection
      personId="person-1"
      requests={[request]}
      onChanged={onChanged}
    />,
  );
  return within(screen.getByRole("listitem"));
}

beforeEach(() => {
  closeDataSubjectRequest.mockReset();
  decideDataSubjectRequest.mockReset();
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
