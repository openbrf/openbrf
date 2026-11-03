import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { QueuedIssue } from "../api/issues";
import type {
  ContractorChoice,
  IssueWorkOrders as IssueWorkOrdersData,
  WorkOrder,
  WorkOrderPreview,
} from "../api/work-orders";
import { IssueWorkOrders } from "./IssueWorkOrders";

/**
 * The work orders on one issue (decision 23 of the issue module's plan).
 *
 * The case worth having is that what is sent is what was previewed: the send
 * is offered only beside a preview, carries the draft the preview was made
 * from, and a changed draft drops the preview. And a ring-fenced issue offers
 * no work order at all.
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
  return { ringFenced: false, workOrders: [], ...overrides };
}

function preview(body: string): WorkOrderPreview {
  return {
    recipient: { name: PLUMBER.name, email: PLUMBER.email ?? "" },
    subject: "Arbetsorder från Brf Eksemplet",
    text: `Hej Rörfirman,\n\n${body}`,
    mailConfigured: true,
  };
}

const SENT: WorkOrder = {
  id: "wo-1",
  contractorId: PLUMBER.id,
  recipientName: PLUMBER.name,
  recipientEmail: PLUMBER.email ?? "",
  body: "Byt packningen.",
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
    render(<IssueWorkOrders issue={ISSUE} />);

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
      });
    });
    expect(
      await screen.findByText(
        "Arbetsordern till Rörfirman är sparad och på väg.",
      ),
    ).toBeTruthy();
    // The record is read again after the send.
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);
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
      screen.getByText("Inte skickad: e-postservern tog inte emot den."),
    ).toBeTruthy();
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
});
