import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { IssueRetentionPanel } from "./IssueRetentionPanel";

/**
 * The board's clock on an issue's free text (ADR 0057): a whole number of
 * years from one to ten, refused outside them before anything is sent.
 */

const fetchIssueRetention = vi.fn();
const saveIssueRetention = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueRetention: () => fetchIssueRetention(),
  saveIssueRetention: (input: unknown) => saveIssueRetention(input),
}));

beforeEach(() => {
  fetchIssueRetention.mockReset().mockResolvedValue({
    ok: true,
    value: { years: 2 },
  });
  saveIssueRetention.mockReset().mockResolvedValue({
    ok: true,
    value: { years: 5 },
  });
});

async function submit(typed: string): Promise<void> {
  render(<IssueRetentionPanel />);
  const field = await screen.findByLabelText(/År efter att ett ärende stängts/);
  expect((field as HTMLInputElement).value).toBe("2");
  fireEvent.change(field, { target: { value: typed } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

describe("the number of years", () => {
  it.each(["0", "11", "2.5", ""])("refuses %j", async (typed) => {
    await submit(typed);

    expect(saveIssueRetention).not.toHaveBeenCalled();
    expect(
      screen.getByText("Välj ett helt antal år mellan 1 och 10."),
    ).toBeTruthy();
  });

  it("saves five, and says it was saved", async () => {
    await submit("5");

    await waitFor(() => {
      expect(saveIssueRetention).toHaveBeenCalledWith({ years: 5 });
    });
    expect(await screen.findByText(/Sparat/)).toBeTruthy();
  });

  it("says that the building record stays and a shorter clock acts the next night", async () => {
    render(<IssueRetentionPanel />);

    expect(await screen.findByText(/Vad, var, när och utfallet/)).toBeTruthy();
    expect(screen.getByText(/redan nästa natt/)).toBeTruthy();
  });
});

describe("an entry typed while a save is on its way", () => {
  it("stays in the field, and the answer does not say it was saved", async () => {
    let answer: (value: unknown) => void = () => undefined;
    saveIssueRetention.mockReset().mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await submit("5");
    await waitFor(() => {
      expect(saveIssueRetention).toHaveBeenCalledWith({ years: 5 });
    });

    const field = screen.getByLabelText(
      /År efter att ett ärende stängts/,
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "10" } });
    answer({ ok: true, value: { years: 5 } });

    await waitFor(() => {
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(field.value).toBe("10");
    expect(screen.queryByText(/Sparat/)).toBeNull();
  });
});
