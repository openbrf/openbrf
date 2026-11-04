import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueEntry } from "../api/issues";
import { EntryPermissionForm } from "./EntryPermissionForm";

/**
 * The resident's permission to enter (decision 29), as the resident and a
 * handler fill it in.
 *
 * What matters is what is promised: a door code is caught while the resident
 * can still reword it and never sent, a no sends nothing else, and the form
 * says the answer is cleared when the issue closes.
 */

const answer = vi.fn();
const withdraw = vi.fn();
const onChanged = vi.fn();

const YES: IssueEntry = {
  answer: "YES",
  note: "Ring på",
  pets: true,
  masterKey: false,
  until: "2027-03-01",
  expired: false,
};

function renderForm(entry: IssueEntry | null = null) {
  return render(
    <EntryPermissionForm
      entry={entry}
      audience="reporter"
      answer={(input) => answer(input) as ReturnType<typeof answer>}
      withdraw={() => withdraw() as ReturnType<typeof withdraw>}
      onChanged={onChanged}
    />,
  );
}

beforeEach(() => {
  answer.mockReset().mockResolvedValue({ ok: true, value: { entry: null } });
  withdraw.mockReset().mockResolvedValue({ ok: true, value: { entry: null } });
  onChanged.mockReset();
});

describe("answering", () => {
  it("offers nothing to save until an answer is chosen, and says it is cleared at closing", () => {
    renderForm();

    expect(
      (screen.getByRole("button", { name: "Spara svar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/rensas när ärendet avslutas/i)).toBeTruthy();
    expect(screen.queryByLabelText(/huvudnyckeln/i)).toBeNull();
  });

  it("sends a yes with pets, the master key, a note and the last day", async () => {
    const session = userEvent.setup();
    renderForm();

    await session.click(screen.getByLabelText("Ja"));
    await session.click(screen.getByLabelText(/husdjur/i));
    await session.click(screen.getByLabelText(/huvudnyckeln/i));
    await session.type(
      screen.getByLabelText("Hur man kommer in"),
      "Ring på hos grannen",
    );
    await session.type(
      screen.getByLabelText("Gäller till och med"),
      "2027-03-01",
    );
    await session.click(screen.getByRole("button", { name: "Spara svar" }));

    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith({
        answer: "YES",
        pets: true,
        masterKey: true,
        note: "Ring på hos grannen",
        until: "2027-03-01",
      });
    });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("sends a no with nothing else", async () => {
    const session = userEvent.setup();
    renderForm(YES);

    await session.click(screen.getByLabelText("Nej"));
    await session.click(screen.getByRole("button", { name: "Spara svar" }));

    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ answer: "NO" });
    });
  });

  it("catches a door code as it is typed, says why and does not send it", async () => {
    const session = userEvent.setup();
    renderForm();

    await session.click(screen.getByLabelText("Ja"));
    await session.type(
      screen.getByLabelText("Hur man kommer in"),
      "Porten har koden 4821",
    );

    expect(await screen.findByText(/ser ut som en portkod/i)).toBeTruthy();
    expect(screen.getByText(/portkoder sparas aldrig/i)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Spara svar" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await session.click(save);
    expect(answer).not.toHaveBeenCalled();
  });

  it("lets a note ask somebody to ring", async () => {
    const session = userEvent.setup();
    renderForm();

    await session.click(screen.getByLabelText("Ja"));
    await session.type(
      screen.getByLabelText("Hur man kommer in"),
      "Ring 070-123 45 67 efter klockan 17",
    );

    expect(screen.queryByText(/ser ut som en portkod/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Spara svar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("says in words what the server refused, with the draft kept", async () => {
    const session = userEvent.setup();
    answer.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "entry-until-past" },
    });
    renderForm();

    await session.click(screen.getByLabelText("Ja"));
    await session.type(
      screen.getByLabelText("Gäller till och med"),
      "2020-01-01",
    );
    await session.click(screen.getByRole("button", { name: "Spara svar" }));

    expect(await screen.findByText(/redan varit/i)).toBeTruthy();
    expect(
      (screen.getByLabelText("Gäller till och med") as HTMLInputElement).value,
    ).toBe("2020-01-01");
  });

  it("says a yes comes from someone who lives in the apartment, with the draft kept", async () => {
    const session = userEvent.setup();
    answer.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "entry-not-resident" },
    });
    renderForm();

    await session.click(screen.getByLabelText("Ja"));
    await session.type(
      screen.getByLabelText("Gäller till och med"),
      "2027-03-01",
    );
    await session.click(screen.getByRole("button", { name: "Spara svar" }));

    expect(
      await screen.findByText(/bara den som bor i lägenheten/i),
    ).toBeTruthy();
    expect((screen.getByLabelText("Ja") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByLabelText("Gäller till och med") as HTMLInputElement).value,
    ).toBe("2027-03-01");
  });

  it("asks for the issue to be read again when it was closed meanwhile", async () => {
    const session = userEvent.setup();
    answer.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "issue-closed" },
    });
    renderForm();

    await session.click(screen.getByLabelText("Nej"));
    await session.click(screen.getByRole("button", { name: "Spara svar" }));

    expect(
      (await screen.findAllByText(/ärendet är avslutat/i)).length,
    ).toBeGreaterThan(0);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("an answer given", () => {
  it("shows what is held, and offers a save only for a change", async () => {
    const session = userEvent.setup();
    renderForm(YES);

    expect((screen.getByLabelText("Ja") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByLabelText(/husdjur/i) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Hur man kommer in") as HTMLTextAreaElement).value,
    ).toBe("Ring på");
    const save = screen.getByRole("button", { name: "Spara svar" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await session.click(screen.getByLabelText(/huvudnyckeln/i));
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when the permission has lapsed", () => {
    renderForm({ ...YES, expired: true });

    expect(screen.getByText("2027-03-01", { selector: "span" })).toBeTruthy();
    expect(document.body.textContent).toMatch(/gick ut den 2027-03-01/);
  });

  it("withdraws the answer", async () => {
    const session = userEvent.setup();
    renderForm(YES);

    await session.click(
      screen.getByRole("button", { name: "Ta tillbaka svaret" }),
    );

    await waitFor(() => {
      expect(withdraw).toHaveBeenCalledTimes(1);
    });
  });
});
