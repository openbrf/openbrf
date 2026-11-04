import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import type { QueuedIssue } from "../api/issues";
import type {
  ContractorChoice,
  IssueWorkOrders as IssueWorkOrdersData,
  WorkOrder,
  WorkOrderPreview,
} from "../api/work-orders";
import { useIssueRedaction } from "./IssueRedaction";
import { IssueWorkOrders } from "./IssueWorkOrders";

/**
 * The work orders on one issue (decision 23 of the issue module's plan).
 *
 * The case worth having is that what is sent is what was previewed: the send
 * is offered only beside a preview, carries the draft the preview was made
 * from with the preview's token, and a changed draft drops the preview. A
 * work order on its way is read again until it settles, and a failure says
 * what is known. And a ring-fenced issue offers no work order at all. A
 * work order's text is removed where it is listed, asked twice, and the record
 * is read again after it (ADR 0057).
 */

const fetchIssueWorkOrders = vi.fn();
const fetchContractorChoices = vi.fn();
const previewWorkOrder = vi.fn();
const sendWorkOrder = vi.fn();

vi.mock("../api/work-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/work-orders")>()),
  fetchIssueWorkOrders: (id: string) => fetchIssueWorkOrders(id),
  fetchContractorChoices: () => fetchContractorChoices(),
  previewWorkOrder: (input: unknown) => previewWorkOrder(input),
  sendWorkOrder: (input: unknown) => sendWorkOrder(input),
}));

const redactIssue = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  redactIssue: (input: unknown) => redactIssue(input),
}));

const PLUMBER: ContractorChoice = {
  id: "c-ror",
  name: "Rörfirman",
  trade: "Rörmokare",
  phone: "08-123 45 67",
  email: "ror@firma.test",
};
const PHONE_ONLY: ContractorChoice = {
  id: "c-tel",
  name: "Telefonfirman",
  trade: "Snickare",
  phone: "070-123 45 67",
  email: null,
};

const ISSUE = {
  id: "issue-1",
  typeName: "Vatten",
  reporter: { kind: "resident", personId: "p-1", name: "Rune Boende" },
} as QueuedIssue;

function orders(
  overrides: Partial<IssueWorkOrdersData> = {},
): IssueWorkOrdersData {
  return { ringFenced: false, closed: false, workOrders: [], ...overrides };
}

function preview(body: string): WorkOrderPreview {
  return {
    recipient: { name: PLUMBER.name, email: PLUMBER.email ?? "" },
    subject: "Arbetsorder från Brf Eksemplet",
    text: `Hej Rörfirman,\n\n${body}`,
    mailConfigured: true,
    previewToken: `token-${body}`,
  };
}

const SENT: WorkOrder = {
  id: "wo-1",
  contractorId: PLUMBER.id,
  recipientName: PLUMBER.name,
  recipientEmail: PLUMBER.email ?? "",
  body: "Byt packningen.",
  redactedAt: null,
  sentBy: { kind: "person", personId: "p-board", name: "Bea Styrelse" },
  sentAt: "2026-11-03T09:00:00.000Z",
  deliveryStatus: "FAILED",
  deliveryFailure: "send-failed",
};

beforeEach(() => {
  fetchIssueWorkOrders.mockReset().mockResolvedValue({
    ok: true,
    value: orders(),
  });
  fetchContractorChoices
    .mockReset()
    .mockResolvedValue({ ok: true, value: [PLUMBER, PHONE_ONLY] });
  previewWorkOrder.mockReset();
  sendWorkOrder.mockReset();
  redactIssue.mockReset().mockResolvedValue({ ok: true, value: undefined });
});

/** The record with the removal offered, as the queue mounts it. */
function WithRedaction({
  of,
  onChanged,
}: {
  of: QueuedIssue;
  onChanged: () => void;
}): ReactElement {
  const control = useIssueRedaction(of, onChanged);
  return <IssueWorkOrders issue={of} redaction={control} />;
}

const UNHELD = { ...ISSUE, legalHoldAt: null } as QueuedIssue;

afterEach(() => {
  vi.useRealTimers();
});

async function writeDraft(body: string): Promise<void> {
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText("Vatten: entreprenör"),
    PLUMBER.id,
  );
  await user.type(screen.getByLabelText("Vatten: arbetsorder"), body);
}

describe("IssueWorkOrders", () => {
  it("sends exactly the draft it previewed", async () => {
    previewWorkOrder.mockImplementation((input: { body: string }) =>
      Promise.resolve({ ok: true, value: preview(input.body) }),
    );
    sendWorkOrder.mockResolvedValue({
      ok: true,
      value: { ...SENT, deliveryStatus: "PENDING", deliveryFailure: null },
    });
    const user = userEvent.setup();
    const onSent = vi.fn();
    render(<IssueWorkOrders issue={ISSUE} onSent={onSent} />);

    await writeDraft("Byt packningen.");
    // No send before a preview.
    expect(screen.queryByRole("button", { name: /^Skicka till/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));

    expect(await screen.findByText(/Hej Rörfirman/)).toBeTruthy();
    expect(screen.getByText("ror@firma.test")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Skicka till Rörfirman" }),
    );

    await waitFor(() => {
      expect(sendWorkOrder).toHaveBeenCalledWith({
        issueId: "issue-1",
        contractorId: PLUMBER.id,
        body: "Byt packningen.",
        previewToken: "token-Byt packningen.",
      });
    });
    expect(
      await screen.findByText(
        "Arbetsordern till Rörfirman är sparad. Loggen nedan visar om mejlet gick iväg.",
      ),
    ).toBeTruthy();
    // The record is read again after the send, and the issue's timeline is
    // told to read its new step.
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("drops the preview when the draft changes, so nothing unread is sent", async () => {
    previewWorkOrder.mockImplementation((input: { body: string }) =>
      Promise.resolve({ ok: true, value: preview(input.body) }),
    );
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await writeDraft("Byt packningen.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(
      await screen.findByRole("button", { name: "Skicka till Rörfirman" }),
    ).toBeTruthy();

    await user.type(screen.getByLabelText("Vatten: arbetsorder"), " Snart.");
    expect(
      screen.queryByRole("button", { name: "Skicka till Rörfirman" }),
    ).toBeNull();
    expect(sendWorkOrder).not.toHaveBeenCalled();
  });

  it("offers a contractor with no address but will not mail them", async () => {
    render(<IssueWorkOrders issue={ISSUE} />);
    const option = await screen.findByRole("option", {
      name: "Telefonfirman (Snickare), ingen adress på listan",
    });
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });

  it("offers no work order on a ring-fenced issue, and still lists what was sent", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ ringFenced: true, workOrders: [SENT] }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(
        "Inget om ett ärende av den här typen får nå en entreprenör, så ingen arbetsorder kan skickas.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Vatten: arbetsorder")).toBeNull();
    // The record says it did not go out, and why, in words.
    expect(
      screen.getByText(/^Obekräftad: e-postservern svarade med ett fel/),
    ).toBeTruthy();
  });

  it("offers no work order on a closed issue, and still lists what was sent", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ closed: true, workOrders: [SENT] }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(
        "Ärendet är avslutat, så ingen arbetsorder erbjuds. Öppna det igen för att skriva en.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Vatten: arbetsorder")).toBeNull();
    expect(screen.getByText("Byt packningen.")).toBeTruthy();
  });

  it("offers the form again when a closed issue is reopened while the disclosure is open", async () => {
    fetchIssueWorkOrders.mockResolvedValueOnce({
      ok: true,
      value: orders({ closed: true, workOrders: [SENT] }),
    });
    const { rerender } = render(
      <IssueWorkOrders
        issue={{ ...ISSUE, meaning: "DONE" as const } as QueuedIssue}
      />,
    );
    await screen.findByText(
      "Ärendet är avslutat, så ingen arbetsorder erbjuds. Öppna det igen för att skriva en.",
    );

    // Reopening changes the issue's meaning and nothing else the screen reads.
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ closed: false, workOrders: [SENT] }),
    });
    rerender(
      <IssueWorkOrders
        issue={{ ...ISSUE, meaning: "IN_PROGRESS" as const } as QueuedIssue}
      />,
    );

    expect(await screen.findByLabelText("Vatten: arbetsorder")).toBeTruthy();
  });

  it("warns that a protected reporter's name and home stay out of the work order", async () => {
    render(
      <IssueWorkOrders
        issue={{ ...ISSUE, reporter: { kind: "protected" } } as QueuedIssue}
      />,
    );
    expect(
      await screen.findByText(/Den som anmälde har skyddade personuppgifter/),
    ).toBeTruthy();
  });

  it("says why a refused preview was refused", async () => {
    previewWorkOrder.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "work-order-identity-number" },
    });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await writeDraft("19811228-9874 släpper in.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(
      await screen.findByText(
        "Arbetsordern innehåller ett personnummer. Skriv den utan.",
      ),
    ).toBeTruthy();
  });

  it("reads a work order on its way again until it settles, and then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          { ...SENT, deliveryStatus: "PENDING", deliveryFailure: null },
        ],
      }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);
    expect(await screen.findByText("På väg till e-postservern.")).toBeTruthy();

    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          {
            ...SENT,
            deliveryStatus: "FAILED",
            deliveryFailure: "delivery-unconfirmed",
          },
        ],
      }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    // Unconfirmed, not "not sent": the mail may have gone out.
    expect(
      await screen.findByText(
        /^Obekräftad: sändningen avbröts, och det går inte att veta om den kom fram/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Inte skickad/)).toBeNull();

    const settled = fetchIssueWorkOrders.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(settled);
  });

  it("drops the preview and reads again when the contractor changed since it", async () => {
    previewWorkOrder.mockImplementation((input: { body: string }) =>
      Promise.resolve({ ok: true, value: preview(input.body) }),
    );
    sendWorkOrder.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "work-order-preview-stale" },
    });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await writeDraft("Byt packningen.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(
      await screen.findByRole("button", { name: "Skicka till Rörfirman" }),
    );

    expect(
      await screen.findByText(
        /Entreprenörens uppgifter eller texten har ändrats sedan förhandsvisningen/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Skicka till Rörfirman" }),
    ).toBeNull();
    await waitFor(() => {
      expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);
    });
  });

  it("lists a work order whose contractor was removed, and one whose text was erased", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          {
            ...SENT,
            contractorId: null,
            recipientName: null,
            recipientEmail: null,
            deliveryStatus: "SENT",
            deliveryFailure: null,
          },
          { ...SENT, id: "wo-2", body: null, deliveryStatus: "SENT" },
        ],
      }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(
        "En entreprenör som sedan tagits bort från listan",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Texten raderades när ärendets lagringstid gick ut."),
    ).toBeTruthy();
  });
});

describe("removing a work order's text", () => {
  it("is asked twice, names the work order, and reads the record and the issue again", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={onChanged} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    expect(redactIssue).not.toHaveBeenCalled();
    expect(screen.getByText(/Det går inte att ångra/)).toBeTruthy();

    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          { ...SENT, body: null, redactedAt: "2026-11-04T08:00:00.000Z" },
        ],
      }),
    });
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));

    await waitFor(() => {
      expect(redactIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        redaction: { target: "workOrder", id: "wo-1" },
      });
    });
    // Read as removed by a handler, not as erased by the clock, and the
    // work order stays with whom it went to.
    expect(
      await screen.findByText(/^Borttaget av en handläggare/),
    ).toBeTruthy();
    expect(screen.queryByText("Byt packningen.")).toBeNull();
    expect(screen.getByText("Rörfirman")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    ).toBeNull();
  });

  it("drops the text on screen when the read after a removal fails", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    fetchIssueWorkOrders.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));

    await waitFor(() => {
      expect(screen.queryByText("Byt packningen.")).toBeNull();
    });
  });

  it("drops the text on screen at once, while the read after a removal is still out", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    // The read that follows never answers within the test.
    fetchIssueWorkOrders.mockReturnValue(new Promise(() => undefined));
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));

    await waitFor(() => {
      expect(screen.queryByText("Byt packningen.")).toBeNull();
    });
  });

  it("offers no removal while a legal hold stands, nor for a text already gone", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    const { unmount } = render(
      <WithRedaction
        of={
          { ...ISSUE, legalHoldAt: "2026-11-01T08:00:00.000Z" } as QueuedIssue
        }
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText("Byt packningen.")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    ).toBeNull();
    unmount();

    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [{ ...SENT, body: null }] }),
    });
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);
    expect(
      await screen.findByText(
        "Texten raderades när ärendets lagringstid gick ut.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    ).toBeNull();
  });

  it("says why when a hold was placed meanwhile, and reads the record again", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={onChanged} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));

    expect(await screen.findByText(/bevarandekrav/)).toBeTruthy();
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
      expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);
    });
  });

  it("says a send that succeeds after a refused removal, not the refusal", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    previewWorkOrder.mockImplementation((input: { body: string }) =>
      Promise.resolve({ ok: true, value: preview(input.body) }),
    );
    sendWorkOrder.mockResolvedValue({
      ok: true,
      value: { ...SENT, deliveryStatus: "PENDING", deliveryFailure: null },
    });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));
    expect(await screen.findByText(/bevarandekrav/)).toBeTruthy();

    await writeDraft("Byt packningen.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(
      await screen.findByRole("button", { name: "Skicka till Rörfirman" }),
    );

    expect(
      await screen.findByText(
        "Arbetsordern till Rörfirman är sparad. Loggen nedan visar om mejlet gick iväg.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/bevarandekrav/)).toBeNull();
  });

  it("says a read that failed after a refused removal, not the refusal", async () => {
    fetchIssueWorkOrders.mockResolvedValueOnce({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    fetchIssueWorkOrders.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));

    expect(
      await screen.findByText(
        "Arbetsorder eller entreprenörer gick inte att läsa just nu. Stäng och öppna igen.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/bevarandekrav/)).toBeNull();
  });

  it("keeps a refused preview's notice gone once a later removal was refused", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    previewWorkOrder.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "work-order-identity-number" },
    });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "redaction-target-not-found" },
    });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    await writeDraft("19811228-9874 släpper in.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    const refusedPreview =
      "Arbetsordern innehåller ett personnummer. Skriv den utan.";
    expect(await screen.findByText(refusedPreview)).toBeTruthy();

    const remove = {
      name: /^Ta bort texten i arbetsordern till Rörfirman från/,
    };
    await user.click(screen.getByRole("button", remove));
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));
    await waitFor(() => {
      expect(screen.queryByText(refusedPreview)).toBeNull();
    });

    // Asking the next removal lets go of the refusal; the preview's older
    // refusal does not come back in its place.
    await user.click(await screen.findByRole("button", remove));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(refusedPreview)).toBeNull();
  });

  it("names a work order whose contractor was removed by when it went alone", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [{ ...SENT, recipientName: null, recipientEmail: null }],
      }),
    });
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: /^Ta bort texten i arbetsordern från/,
      }),
    ).toBeTruthy();
  });
});
