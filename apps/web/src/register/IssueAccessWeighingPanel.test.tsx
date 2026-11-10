import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { IssueAccessWeighingPanel } from "./IssueAccessWeighingPanel";
import type { IssueAccessDecision, IssueAccessWeighing } from "./register-api";

/**
 * The board's art. 15(4) weighing of one issue for one access report (ADR
 * 0057): every text needs a choice before it saves, a text given in part is
 * saved only as a copy that leaves words out, a reporter's own report offers
 * no leaving out for naming them, no save is sent while one is in flight, and
 * a failed save keeps the choices to try again. The report owns the save
 * (`DataSubjectReport.test.tsx` covers a save outliving its panel).
 */

const { fetchIssueAccessWeighing } = vi.hoisted(() => ({
  fetchIssueAccessWeighing: vi.fn(),
}));

vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchIssueAccessWeighing,
}));

const CONCERNED: IssueAccessWeighing = {
  issueId: "issue-1",
  number: 52,
  typeName: "Störningar",
  report: "concerned",
  texts: [
    {
      part: "DESCRIPTION",
      id: null,
      writtenAt: "2026-01-07T21:00:00.000Z",
      side: null,
      recipientName: null,
      text: "Jag i 1102 hör musik varje natt.",
      decision: null,
      givenText: null,
    },
    {
      part: "MESSAGE",
      id: "message-1",
      writtenAt: "2026-01-08T09:00:00.000Z",
      side: "HANDLER",
      recipientName: null,
      text: "Vi har pratat med grannen.",
      decision: "given",
      givenText: null,
    },
  ],
};

const REPORTER: IssueAccessWeighing = {
  ...CONCERNED,
  report: "reporter",
  texts: [
    {
      part: "NOTE",
      id: "note-1",
      writtenAt: "2026-01-08T09:00:00.000Z",
      side: null,
      recipientName: null,
      text: "Ringde om porten.",
      decision: null,
      givenText: null,
    },
  ],
};

function renderPanel(
  onSave: (decisions: IssueAccessDecision[]) => Promise<boolean> = vi.fn(() =>
    Promise.resolve(true),
  ),
  saving = false,
) {
  const onClose = vi.fn();
  const view = render(
    <IssueAccessWeighingPanel
      personId="person-1"
      issueId="issue-1"
      saving={saving}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  return { onSave, onClose, view };
}

function noop(): void {}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Spara prövningen",
  }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the board's weighing of an issue for an access report", () => {
  it("saves only once every text has a choice, and sends each as chosen", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(CONCERNED);
    const { onSave } = renderPanel();

    await screen.findByText("Jag i 1102 hör musik varje natt.");
    // The message's earlier weighing stands; the description has none yet.
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/^Välj för varje text/)).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("radio", {
        name: "Utelämna: det skulle avslöja vem som anmälde ärendet",
      })[0] as HTMLElement,
    );
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith([
      {
        part: "DESCRIPTION",
        id: null,
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: null,
      },
      {
        part: "MESSAGE",
        id: "message-1",
        withheldBecause: null,
        givenText: null,
      },
    ]);
  });

  it("gives a text in part as a copy that only leaves words out, each place marked", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(CONCERNED);
    const { onSave } = renderPanel();

    await screen.findByText("Jag i 1102 hör musik varje natt.");
    fireEvent.click(
      screen.getAllByRole("radio", {
        name: "Lämna ut delvis: utelämna orden som skulle avslöja vem som anmälde ärendet",
      })[0] as HTMLElement,
    );
    // The copy starts as the whole text, which leaves nothing out yet.
    const copy = screen.getByRole("textbox", {
      name: "Det som lämnas ut",
    }) as HTMLTextAreaElement;
    expect(copy.value).toBe("Jag i 1102 hör musik varje natt.");
    expect(saveButton().disabled).toBe(true);

    // Select "i 1102" and leave it out.
    copy.setSelectionRange(4, 10);
    fireEvent.click(
      screen.getByRole("button", { name: "Utelämna de markerade orden" }),
    );
    expect(copy.value).toBe("Jag […] hör musik varje natt.");
    expect(saveButton().disabled).toBe(false);

    // A word the text does not hold is not saved.
    fireEvent.change(copy, {
      target: { value: "Jag […] hör hög musik varje natt." },
    });
    expect(saveButton().disabled).toBe(true);
    expect(copy.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(copy, {
      target: { value: "Jag […] hör musik varje natt." },
    });

    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith([
      {
        part: "DESCRIPTION",
        id: null,
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: "Jag […] hör musik varje natt.",
      },
      {
        part: "MESSAGE",
        id: "message-1",
        withheldBecause: null,
        givenText: null,
      },
    ]);
  });

  it("offers again a copy the board gave in part before", async () => {
    const [description] = CONCERNED.texts;
    if (description === undefined) throw new Error("the fixture holds a text");
    fetchIssueAccessWeighing.mockResolvedValue({
      ...CONCERNED,
      texts: [
        {
          ...description,
          decision: "ABOUT_ANOTHER_PERSON",
          givenText: "Jag i 1102 hör […]",
        },
      ],
    } satisfies IssueAccessWeighing);
    renderPanel();

    const copy = (await screen.findByRole("textbox", {
      name: "Det som lämnas ut",
    })) as HTMLTextAreaElement;
    expect(copy.value).toBe("Jag i 1102 hör […]");
    expect(
      (
        screen.getByRole("radio", {
          name: "Lämna ut delvis: utelämna orden om någon annan",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it("offers a reporter's own report no leaving out for naming them", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(REPORTER);
    renderPanel();

    await screen.findByText("Ringde om porten.");
    expect(
      screen.getByRole("radio", {
        name: "Utelämna: det handlar om någon annan",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("radio", {
        name: "Utelämna: det skulle avslöja vem som anmälde ärendet",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("radio", {
        name: "Lämna ut delvis: utelämna orden som skulle avslöja vem som anmälde ärendet",
      }),
    ).toBeNull();
  });

  it("weighs a work order's text on a reporter's report, named by whom it went to", async () => {
    // ADR 0057, question 7: the handler's words to a contractor are part of
    // the reporter's copy, weighed as a note is.
    fetchIssueAccessWeighing.mockResolvedValue({
      ...REPORTER,
      texts: [
        {
          part: "WORK_ORDER",
          id: "work-order-1",
          writtenAt: "2026-01-09T09:00:00.000Z",
          side: null,
          recipientName: "Rörmokare Ab",
          text: "Byt packningen i 1102, grannen i 1103 klagar på läckan.",
          decision: null,
          givenText: null,
        },
        {
          part: "WORK_ORDER",
          id: "work-order-2",
          writtenAt: "2026-01-10T09:00:00.000Z",
          side: null,
          recipientName: null,
          text: "Kontrollera avloppet.",
          decision: "given",
          givenText: null,
        },
      ],
    } satisfies IssueAccessWeighing);
    const { onSave } = renderPanel();

    await screen.findByText(
      "Byt packningen i 1102, grannen i 1103 klagar på läckan.",
    );
    expect(screen.getByText("Arbetsorder till Rörmokare Ab")).toBeTruthy();
    expect(
      screen.getByText(
        "Arbetsorder till en entreprenör som sedan tagits bort från listan",
      ),
    ).toBeTruthy();
    // The reporter's own report never leaves a text out for naming them.
    expect(
      screen.queryByRole("radio", {
        name: "Utelämna: det skulle avslöja vem som anmälde ärendet",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getAllByRole("radio", {
        name: "Utelämna: det handlar om någon annan",
      })[0] as HTMLElement,
    );
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith([
      {
        part: "WORK_ORDER",
        id: "work-order-1",
        withheldBecause: "ABOUT_ANOTHER_PERSON",
        givenText: null,
      },
      {
        part: "WORK_ORDER",
        id: "work-order-2",
        withheldBecause: null,
        givenText: null,
      },
    ]);
  });

  it("sends nothing while a save is in flight, and keeps the choices when a save fails", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(REPORTER);
    const onSave = vi.fn(() => Promise.resolve(false));
    const { view } = renderPanel(onSave, true);

    await screen.findByText("Ringde om porten.");
    const saving = screen.getByRole("button", { name: "Sparar..." });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saving);
    expect(onSave).not.toHaveBeenCalled();

    view.rerender(
      <IssueAccessWeighingPanel
        personId="person-1"
        issueId="issue-1"
        saving={false}
        onSave={onSave}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Lämna ut" }));
    fireEvent.click(saveButton());
    await screen.findByText("Prövningen gick inte att spara. Försök igen.");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("radio", { name: "Lämna ut" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });
});
