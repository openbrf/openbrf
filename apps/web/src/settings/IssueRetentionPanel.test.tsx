import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { IssueRetentionPanel } from "./IssueRetentionPanel";

/**
 * The board's clocks on an issue's free text (ADR 0057): the ordinary types'
 * and a ring-fenced type's (decision 32), each a whole number of years from
 * one to ten, refused outside them before anything is sent, and saved
 * together.
 */

const fetchIssueRetention = vi.fn();
const saveIssueRetention = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueRetention: () => fetchIssueRetention(),
  saveIssueRetention: (input: unknown) => saveIssueRetention(input),
}));

const ORDINARY = /År efter att ett ärende stängts/;
const RING_FENCED = /År efter att ett avskärmat ärende stängts/;

beforeEach(() => {
  fetchIssueRetention.mockReset().mockResolvedValue({
    ok: true,
    value: { years: 2, ringFencedYears: 1 },
  });
  saveIssueRetention.mockReset().mockResolvedValue({
    ok: true,
    value: { years: 5, ringFencedYears: 1 },
  });
});

async function submit(
  typed: string,
  label: RegExp = ORDINARY,
): Promise<HTMLInputElement> {
  render(<IssueRetentionPanel />);
  const field = (await screen.findByLabelText(label)) as HTMLInputElement;
  fireEvent.change(field, { target: { value: typed } });
  fireEvent.submit(field.form as HTMLFormElement);
  return field;
}

describe("the number of years", () => {
  it("shows both clocks as they were read", async () => {
    render(<IssueRetentionPanel />);

    expect(
      ((await screen.findByLabelText(ORDINARY)) as HTMLInputElement).value,
    ).toBe("2");
    expect((screen.getByLabelText(RING_FENCED) as HTMLInputElement).value).toBe(
      "1",
    );
  });

  it.each([
    ["the other types'", ORDINARY],
    ["a ring-fenced type's", RING_FENCED],
  ])("refuses a clock out of range for %s clock", async (_name, label) => {
    for (const typed of ["0", "11", "2.5", ""]) {
      const field = await submit(typed, label);

      expect(saveIssueRetention).not.toHaveBeenCalled();
      expect(
        screen.getByText("Välj ett helt antal år mellan 1 och 10."),
      ).toBeTruthy();
      expect(field.getAttribute("aria-invalid")).toBe("true");
      cleanup();
    }
  });

  it("saves five for the other types with the ring-fenced clock as it was, and says it was saved", async () => {
    await submit("5");

    await waitFor(() => {
      expect(saveIssueRetention).toHaveBeenCalledWith({
        years: 5,
        ringFencedYears: 1,
      });
    });
    expect(await screen.findByText(/Sparat/)).toBeTruthy();
  });

  it("saves a ring-fenced clock longer than the other types'", async () => {
    saveIssueRetention.mockReset().mockResolvedValue({
      ok: true,
      value: { years: 2, ringFencedYears: 4 },
    });
    const field = await submit("4", RING_FENCED);

    await waitFor(() => {
      expect(saveIssueRetention).toHaveBeenCalledWith({
        years: 2,
        ringFencedYears: 4,
      });
    });
    expect(await screen.findByText(/Sparat/)).toBeTruthy();
    expect(field.value).toBe("4");
  });

  it("says that the building record stays and a shorter clock acts in the nights that follow", async () => {
    render(<IssueRetentionPanel />);

    expect(
      await screen.findByText(
        /Vad det gällde, när det anmäldes och stängdes, utfallet och lägenheten/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/högst 500 ärenden vid varje körning/),
    ).toBeTruthy();
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
    const field = await submit("5");
    await waitFor(() => {
      expect(saveIssueRetention).toHaveBeenCalledWith({
        years: 5,
        ringFencedYears: 1,
      });
    });

    fireEvent.change(screen.getByLabelText(RING_FENCED), {
      target: { value: "3" },
    });
    answer({ ok: true, value: { years: 5, ringFencedYears: 1 } });

    await waitFor(() => {
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(field.value).toBe("5");
    expect((screen.getByLabelText(RING_FENCED) as HTMLInputElement).value).toBe(
      "3",
    );
    expect(screen.queryByText(/Sparat/)).toBeNull();
  });
});
