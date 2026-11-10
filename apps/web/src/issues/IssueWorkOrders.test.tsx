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
const issueWorkOrderLink = vi.fn();
const revokeWorkOrderLink = vi.fn();
const chooseWorkOrderPhotos = vi.fn();

vi.mock("../api/work-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/work-orders")>()),
  fetchIssueWorkOrders: (id: string) => fetchIssueWorkOrders(id),
  fetchContractorChoices: () => fetchContractorChoices(),
  previewWorkOrder: (input: unknown) => previewWorkOrder(input),
  sendWorkOrder: (input: unknown) => sendWorkOrder(input),
  issueWorkOrderLink: (input: unknown) => issueWorkOrderLink(input),
  revokeWorkOrderLink: (input: unknown) => revokeWorkOrderLink(input),
  chooseWorkOrderPhotos: (input: unknown) => chooseWorkOrderPhotos(input),
}));

const fetchViewer = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: () => fetchViewer(),
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
const ELECTRICIAN: ContractorChoice = {
  id: "c-el",
  name: "Elfirman",
  trade: "Elektriker",
  phone: null,
  email: "el@firma.test",
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
  return {
    ringFenced: false,
    closed: false,
    linksEnabled: false,
    choosablePhotos: [],
    protectedHousehold: false,
    workOrders: [],
    ...overrides,
  };
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

const NO_LINK: WorkOrder["contractorLink"] = {
  link: { state: "none", expiresAt: null },
  answer: null,
  answeredAt: null,
  chosenFileIds: [],
  notes: [],
  files: [],
};

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
  contractorLink: NO_LINK,
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
  issueWorkOrderLink.mockReset();
  revokeWorkOrderLink.mockReset();
  chooseWorkOrderPhotos.mockReset();
  fetchViewer.mockReset().mockResolvedValue({
    ok: true,
    value: { housingCooperative: { name: "Brf Eksemplet" } },
  });
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
        "Arbetsordern till Rörfirman är sparad. Listan med arbetsorder nedan visar om mejlet gick iväg.",
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

  it("drops the preview when the contractor changes, so it is not sent to the one previewed", async () => {
    fetchContractorChoices.mockResolvedValue({
      ok: true,
      value: [PLUMBER, ELECTRICIAN, PHONE_ONLY],
    });
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

    await user.selectOptions(
      screen.getByLabelText("Vatten: entreprenör"),
      ELECTRICIAN.id,
    );
    expect(screen.queryByRole("button", { name: /^Skicka till/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Förhandsgranska" }),
    ).toBeTruthy();
    expect(sendWorkOrder).not.toHaveBeenCalled();
  });

  it("shows the record while the contractors to choose from are still being read", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ workOrders: [SENT] }),
    });
    // The list of contractors never answers within the test.
    fetchContractorChoices.mockReturnValue(new Promise(() => undefined));
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(await screen.findByText("Byt packningen.")).toBeTruthy();
    expect(screen.queryByText("Hämtar arbetsorder...")).toBeNull();
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
      screen.getByText(
        /^Inte skickad: meddelandet kunde inte förberedas, eller e-postservern gick inte att nå/,
      ),
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

  it("says a work order must wait for the privacy notice to be published, before and after it was queued", async () => {
    previewWorkOrder.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "work-order-privacy-notice-unpublished" },
    });
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          { ...SENT, deliveryFailure: "privacy-notice-unpublished" },
        ],
      }),
    });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    // The one queued before the notice was taken down is recorded as not sent.
    expect(
      await screen.findByText(
        /^Inte skickad: den skulle länka till föreningens integritetspolicy/,
      ),
    ).toBeTruthy();

    await writeDraft("Byt packningen.");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(
      await screen.findByText(
        /måste länka till föreningens integritetspolicy, och integritetspolicyn är inte publicerad/,
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

  it("says so when the address of a listed work order cannot be read", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        workOrders: [
          {
            ...SENT,
            recipientEmail: null,
            deliveryStatus: "SENT",
            deliveryFailure: null,
          },
        ],
      }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(await screen.findByText(PLUMBER.name)).toBeTruthy();
    expect(screen.getByText("Adressen kunde inte läsas.")).toBeTruthy();
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

  it("keeps the text removed when a read asked before the removal answers after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onWay: WorkOrder = {
      ...SENT,
      deliveryStatus: "PENDING",
      deliveryFailure: null,
    };
    let answerPoll: (value: unknown) => void = () => undefined;
    fetchIssueWorkOrders
      .mockResolvedValueOnce({
        ok: true,
        value: orders({ workOrders: [onWay] }),
      })
      // The poll's read, held until after the removal.
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerPoll = resolve;
        }),
      )
      .mockResolvedValue({
        ok: true,
        value: orders({
          workOrders: [
            {
              ...SENT,
              body: null,
              redactedAt: "2026-11-04T08:00:00.000Z",
              deliveryStatus: "SENT",
              deliveryFailure: null,
            },
          ],
        }),
      });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);
    expect(await screen.findByText("Byt packningen.")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);

    await user.click(
      screen.getByRole("button", {
        name: /^Ta bort texten i arbetsordern till Rörfirman från/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));
    expect(
      await screen.findByText(/^Borttaget av en handläggare/),
    ).toBeTruthy();

    // The poll's answer, asked before the removal, carries the old text.
    await act(async () => {
      answerPoll({ ok: true, value: orders({ workOrders: [onWay] }) });
      await Promise.resolve();
    });
    expect(screen.queryByText("Byt packningen.")).toBeNull();
    expect(screen.getByText(/^Borttaget av en handläggare/)).toBeTruthy();
  });

  it("drops an answer asked before a stale refusal when it arrives in the same step", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    previewWorkOrder.mockImplementation((input: { body: string }) =>
      Promise.resolve({ ok: true, value: preview(input.body) }),
    );
    const onWay: WorkOrder = {
      ...SENT,
      deliveryStatus: "PENDING",
      deliveryFailure: null,
    };
    let answerPoll: (value: unknown) => void = () => undefined;
    let refuseSend: (value: unknown) => void = () => undefined;
    fetchIssueWorkOrders
      .mockResolvedValueOnce({
        ok: true,
        value: orders({ workOrders: [onWay] }),
      })
      // The poll's read, held until the refusal has been taken.
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerPoll = resolve;
        }),
      )
      // The read the refusal asks for never answers, so what is on screen is
      // what the poll's answer left there.
      .mockReturnValue(new Promise(() => undefined));
    sendWorkOrder.mockReturnValue(
      new Promise((resolve) => {
        refuseSend = resolve;
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<IssueWorkOrders issue={ISSUE} />);
    expect(await screen.findByText("Byt packningen.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);

    await user.selectOptions(
      screen.getByLabelText("Vatten: entreprenör"),
      PLUMBER.id,
    );
    await user.type(
      screen.getByLabelText("Vatten: arbetsorder"),
      "Dra om rören.",
    );
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(
      await screen.findByRole("button", { name: "Skicka till Rörfirman" }),
    );

    // Both answers are given before React has rendered anything: the refusal
    // first, then the poll's, which was asked before it. The refusal has moved
    // the reads on by the time the poll's answer is looked at, so the answer
    // is dropped, not shown until the read after the refusal replaces it.
    await act(async () => {
      refuseSend({
        ok: false,
        failure: { status: 409, reason: "work-order-preview-stale" },
      });
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
      answerPoll({
        ok: true,
        value: orders({ workOrders: [{ ...onWay, body: "Gammal text." }] }),
      });
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.queryByText("Gammal text.")).toBeNull();
    expect(screen.getByText("Byt packningen.")).toBeTruthy();
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
        "Arbetsordern till Rörfirman är sparad. Listan med arbetsorder nedan visar om mejlet gick iväg.",
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

/**
 * The contractor's link to a work order (ADR 0055), behind the instance's
 * switch. Off, nothing of it is offered and what came through a link earlier
 * still stands on the record. On, the address is shown once, in the answer to
 * issuing it, and gone when the record is read again.
 */
describe("a contractor's link", () => {
  const DELIVERED: WorkOrder = {
    ...SENT,
    deliveryStatus: "SENT",
    deliveryFailure: null,
  };
  const ANSWERED: WorkOrder = {
    ...DELIVERED,
    contractorLink: {
      link: { state: "ended", expiresAt: null },
      answer: "DONE",
      answeredAt: "2026-11-04T10:00:00.000Z",
      chosenFileIds: [],
      notes: [
        {
          id: "note-1",
          body: "Packningen bytt, kranen tät.",
          redactedAt: null,
          createdAt: "2026-11-04T09:30:00.000Z",
        },
      ],
      files: [
        {
          id: "file-1",
          url: "/api/media/file-1",
          fileName: "kranen.jpg",
          width: 800,
          height: 600,
          createdAt: "2026-11-04T09:40:00.000Z",
        },
      ],
    },
  };
  const PHOTOS = [
    {
      fileId: "f-1",
      url: "/api/media/f-1",
      fileName: "IMG_1.jpg",
      source: "report" as const,
    },
    {
      fileId: "f-2",
      url: "/api/media/f-2",
      fileName: "IMG_2.jpg",
      source: "handler" as const,
    },
  ];
  const ISSUED = {
    url: "https://brf.test/arbetsorder/l/secret-token",
    expiresAt: "2026-12-04T09:00:00.000Z",
  };
  const give = { name: /^Ge entreprenören en länk/ };

  it("offers nothing while the switch is off, and still shows what came through a link", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: false, workOrders: [ANSWERED] }),
    });
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    expect(
      await screen.findByText("Packningen bytt, kranen tät."),
    ).toBeTruthy();
    expect(screen.getByText(/^Klar/)).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Foto från entreprenören: kranen.jpg" }),
    ).toBeTruthy();
    // Each is removable as the rest of the issue's free text is.
    expect(
      screen.getByRole("button", {
        name: /^Ta bort entreprenörens anteckning från/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Ta bort entreprenörens foto kranen.jpg",
      }),
    ).toBeTruthy();
    // No sign of the link itself.
    expect(screen.queryByText("Entreprenörens länk")).toBeNull();
    expect(screen.queryByRole("button", give)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dra tillbaka/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers no link to a work order whose contractor the list's clock took off it", async () => {
    // The work order keeps whom it went to, and nobody on the list is there
    // to give a link to: the server refuses one (`work-order-recipient-removed`).
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        workOrders: [{ ...DELIVERED, contractorId: null }],
      }),
    });
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    expect(
      await screen.findByText(
        "Entreprenören har inte fått någon länk till den här arbetsordern.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", give)).toBeNull();
  });

  it("shows the address once, and drops it when the record is read again", async () => {
    const withNote: WorkOrder = {
      ...DELIVERED,
      contractorLink: { ...NO_LINK, notes: ANSWERED.contractorLink.notes },
    };
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [withNote] }),
    });
    issueWorkOrderLink.mockResolvedValue({ ok: true, value: ISSUED });
    const user = userEvent.setup();
    render(<WithRedaction of={UNHELD} onChanged={vi.fn()} />);

    expect(
      await screen.findByText(
        "Entreprenören har inte fått någon länk till den här arbetsordern.",
      ),
    ).toBeTruthy();
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        workOrders: [
          {
            ...withNote,
            contractorLink: {
              ...withNote.contractorLink,
              link: { state: "live", expiresAt: ISSUED.expiresAt },
            },
          },
        ],
      }),
    });
    await user.click(screen.getByRole("button", give));

    expect(issueWorkOrderLink).toHaveBeenCalledWith({
      issueId: "issue-1",
      workOrderId: "wo-1",
    });
    expect(await screen.findByDisplayValue(ISSUED.url)).toBeTruthy();
    // The message carries the address and the association, and nothing of
    // the work order, the issue or its reporter.
    expect(
      screen.getByDisplayValue(
        `Här är länken till arbetsordern från Brf Eksemplet: ${ISSUED.url}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Länken visas bara nu/)).toBeTruthy();
    // The read after issuing says the link is live, and leaves the address.
    expect(
      await screen.findByText(/^Länken öppnar arbetsordern till/),
    ).toBeTruthy();
    expect(screen.getByDisplayValue(ISSUED.url)).toBeTruthy();
    // A live link is replaced only by a control that says the old one stops.
    expect(
      screen.getByRole("button", {
        name: /^Ge en ny länk – den nuvarande slutar fungera/,
      }),
    ).toBeTruthy();

    // Removing the contractor's note reads the record again.
    await user.click(
      screen.getByRole("button", {
        name: /^Ta bort entreprenörens anteckning från/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));
    await waitFor(() => {
      expect(redactIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        redaction: { target: "workOrderNote", id: "note-1" },
      });
    });
    await waitFor(() => {
      expect(screen.queryByDisplayValue(ISSUED.url)).toBeNull();
    });
    expect(screen.queryByText(/^Länken visas bara nu/)).toBeNull();
  });

  it("withdraws a live link and reads the record again", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        workOrders: [
          {
            ...DELIVERED,
            contractorLink: {
              ...NO_LINK,
              link: { state: "live", expiresAt: ISSUED.expiresAt },
            },
          },
        ],
      }),
    });
    revokeWorkOrderLink.mockResolvedValue({ ok: true, value: undefined });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await user.click(
      await screen.findByRole("button", {
        name: /^Dra tillbaka länken till arbetsordern till Rörfirman från/,
      }),
    );
    expect(revokeWorkOrderLink).toHaveBeenCalledWith({
      issueId: "issue-1",
      workOrderId: "wo-1",
    });
    expect(
      await screen.findByText(
        "Länken är tillbakadragen. Den öppnar inte längre arbetsordern.",
      ),
    ).toBeTruthy();
    expect(fetchIssueWorkOrders).toHaveBeenCalledTimes(2);
  });

  it("offers only the withdrawal of a live link while the switch is off", async () => {
    const live: WorkOrder = {
      ...DELIVERED,
      contractorLink: {
        ...NO_LINK,
        link: { state: "live", expiresAt: ISSUED.expiresAt },
      },
    };
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: false, workOrders: [live] }),
    });
    revokeWorkOrderLink.mockResolvedValue({ ok: true, value: undefined });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(/^Arbetsorderlänkar är avstängda/),
    ).toBeTruthy();
    expect(screen.queryByText(/^Länken öppnar arbetsordern/)).toBeNull();
    expect(screen.queryByRole("button", give)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Ge en ny länk/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();

    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: false,
        workOrders: [
          {
            ...live,
            contractorLink: {
              ...live.contractorLink,
              link: { state: "ended", expiresAt: null },
            },
          },
        ],
      }),
    });
    await user.click(
      screen.getByRole("button", {
        name: /^Dra tillbaka länken till arbetsordern till Rörfirman från/,
      }),
    );
    expect(revokeWorkOrderLink).toHaveBeenCalledWith({
      issueId: "issue-1",
      workOrderId: "wo-1",
    });
    // The outcome is said once the record reads the link as ended.
    expect(
      await screen.findByText(
        "Länken är tillbakadragen. Den öppnar inte längre arbetsordern.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Dra tillbaka/ })).toBeNull();
  });

  it("saves the photographs chosen for the link, as the whole choice", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        choosablePhotos: PHOTOS,
        workOrders: [
          {
            ...DELIVERED,
            contractorLink: { ...NO_LINK, chosenFileIds: ["f-1"] },
          },
        ],
      }),
    });
    chooseWorkOrderPhotos.mockResolvedValue({ ok: true, value: undefined });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    const first = await screen.findByRole("checkbox", { name: /IMG_1\.jpg/ });
    expect((first as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Ett foto kan visa personer/)).toBeTruthy();
    const save = screen.getByRole("button", { name: /^Spara valet/ });
    // Nothing changed, nothing to save.
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.click(first);
    await user.click(screen.getByRole("checkbox", { name: /IMG_2\.jpg/ }));
    // The record read after the save carries the saved choice.
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        choosablePhotos: PHOTOS,
        workOrders: [
          {
            ...DELIVERED,
            contractorLink: { ...NO_LINK, chosenFileIds: ["f-2"] },
          },
        ],
      }),
    });
    await user.click(save);

    expect(chooseWorkOrderPhotos).toHaveBeenCalledWith({
      issueId: "issue-1",
      workOrderId: "wo-1",
      fileIds: ["f-2"],
    });
    expect(
      await screen.findByText("Länken visar nu de valda fotona."),
    ).toBeTruthy();
    // And that choice is what stands once the save has settled.
    expect(
      (screen.getByRole("checkbox", { name: /IMG_2\.jpg/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /IMG_1\.jpg/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    // Changing the choice again lets go of the notice: it is about the last one.
    await user.click(screen.getByRole("checkbox", { name: /IMG_1\.jpg/ }));
    expect(screen.queryByText("Länken visar nu de valda fotona.")).toBeNull();
  });

  it("keeps a choice made while a save was out", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        choosablePhotos: PHOTOS,
        workOrders: [DELIVERED],
      }),
    });
    let answer: (value: unknown) => void = () => undefined;
    chooseWorkOrderPhotos.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await user.click(
      await screen.findByRole("checkbox", { name: /IMG_1\.jpg/ }),
    );
    const save = screen.getByRole("button", { name: /^Spara valet/ });
    await user.click(save);
    // One save at a time.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /IMG_2\.jpg/ }));

    await act(async () => {
      answer({ ok: true, value: undefined });
      await Promise.resolve();
    });
    // The newer choice stands, unsaved, and is offered for saving.
    expect(
      (screen.getByRole("checkbox", { name: /IMG_2\.jpg/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await waitFor(() => {
      expect((save as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText("Länken visar nu de valda fotona.")).toBeNull();
  });

  it("says why a link was refused", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [DELIVERED] }),
    });
    issueWorkOrderLink.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "work-order-protected" },
    });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await user.click(await screen.findByRole("button", give));
    expect(
      await screen.findByText(
        "Någon som ärendet gäller har skyddade personuppgifter, så ingen arbetsorder i ärendet får någon länk.",
      ),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue(ISSUED.url)).toBeNull();
  });

  it("reads the record again after a link is refused for a protected household", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [DELIVERED] }),
    });
    issueWorkOrderLink.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "work-order-protected" },
    });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await screen.findByRole("button", give);
    const reads = fetchIssueWorkOrders.mock.calls.length;
    await user.click(screen.getByRole("button", give));
    await waitFor(() => {
      expect(fetchIssueWorkOrders.mock.calls.length).toBeGreaterThan(reads);
    });
  });

  it("shows the address though the association's name is never answered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchIssueWorkOrders.mockResolvedValue({
        ok: true,
        value: orders({ linksEnabled: true, workOrders: [DELIVERED] }),
      });
      issueWorkOrderLink.mockResolvedValue({ ok: true, value: ISSUED });
      fetchViewer.mockReturnValue(new Promise(() => undefined));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<IssueWorkOrders issue={ISSUE} />);

      await user.click(await screen.findByRole("button", give));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByDisplayValue(ISSUED.url)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a refused link at once, without waiting for the association's name", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [DELIVERED] }),
    });
    issueWorkOrderLink.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "work-order-protected" },
    });
    // Never answered: the refusal must not wait out the read's five seconds.
    fetchViewer.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await user.click(await screen.findByRole("button", give));
    expect(
      await screen.findByText(
        "Någon som ärendet gäller har skyddade personuppgifter, så ingen arbetsorder i ärendet får någon länk.",
        undefined,
        { timeout: 1_000 },
      ),
    ).toBeTruthy();
  });

  it("does not show the address of a link the record says has ended", async () => {
    fetchIssueWorkOrders.mockResolvedValueOnce({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [DELIVERED] }),
    });
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        workOrders: [
          {
            ...DELIVERED,
            contractorLink: {
              ...DELIVERED.contractorLink,
              link: { state: "ended", expiresAt: null },
            },
          },
        ],
      }),
    });
    issueWorkOrderLink.mockResolvedValue({ ok: true, value: ISSUED });
    const user = userEvent.setup();
    render(<IssueWorkOrders issue={ISSUE} />);

    await user.click(await screen.findByRole("button", give));
    await waitFor(() => {
      expect(fetchIssueWorkOrders.mock.calls.length).toBeGreaterThan(1);
    });
    expect(screen.queryByDisplayValue(ISSUED.url)).toBeNull();
  });

  it("offers no link, and shows the one given before as ended, while a resident has protected personal data", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({
        linksEnabled: true,
        // The reporter is not protected; somebody living in the apartment is.
        protectedHousehold: true,
        workOrders: [
          {
            ...DELIVERED,
            contractorLink: {
              ...NO_LINK,
              link: { state: "ended", expiresAt: null },
            },
          },
        ],
      }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(
        /^Någon som ärendet gäller, den som anmälde eller någon som bor i lägenheten, har skyddade personuppgifter/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/^Länken öppnar inte längre arbetsordern/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", give)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Ge en ny länk/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dra tillbaka/ })).toBeNull();
  });

  it("offers no new link for a work order the contractor marked done", async () => {
    fetchIssueWorkOrders.mockResolvedValue({
      ok: true,
      value: orders({ linksEnabled: true, workOrders: [ANSWERED] }),
    });
    render(<IssueWorkOrders issue={ISSUE} />);

    expect(
      await screen.findByText(
        "Entreprenören har tackat nej till arbetsordern eller markerat den som klar, så ingen ny länk ges.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ge en ny länk/ })).toBeNull();
  });
});
