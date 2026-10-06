import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { FileEntryPanel } from "./FileEntryPanel";

/**
 * Filing an entry while the request is still running.
 *
 * The fields are cleared once the entry is filed, so what is typed in the
 * meantime would be wiped without a word. The panel refuses it instead, and
 * hands focus back when it opens again.
 */

const file = vi.fn();

function panel(): void {
  render(
    <FileEntryPanel
      apartmentId="apartment-1201"
      filer="TENANT_OWNER"
      file={(apartmentId, fields, chosen) => file(apartmentId, fields, chosen)}
      onFiled={() => undefined}
    />,
  );
}

/** Holds the request open, so the panel is observed mid-save. */
function holdRequest(): (outcome: unknown) => void {
  let settle: (outcome: unknown) => void = () => undefined;
  file.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (outcome) => {
    settle(outcome);
  };
}

const OUTCOMES = [
  ["once the entry is filed", { ok: true, value: { id: "entry-1" } }],
  [
    "when the filing is refused",
    { ok: false, failure: { status: 422, reason: "unsupported-type" } },
  ],
] as const;

const pdf = (): File =>
  new File(["bytes"], "tvattmaskin.pdf", { type: "application/pdf" });

beforeEach(() => {
  file.mockReset();
});

describe("while an entry is being filed", () => {
  it("locks the fields, so nothing typed is lost when they are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const title = screen.getByLabelText<HTMLInputElement>(/^Titel/);
    await user.type(title, "Bruksanvisning");
    await user.upload(screen.getByLabelText("Fil", { exact: true }), pdf());
    expect(title.matches(":disabled")).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Lägg in handlingen" }),
    );

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(true);
    });
    expect(
      screen.getByLabelText("Fil", { exact: true }).matches(":disabled"),
    ).toBe(true);
    await user.type(title, "9");
    expect(title.value).toBe("Bruksanvisning");

    settle({ ok: true, value: { id: "entry-1" } });

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(false);
    });
    expect(title.value).toBe("");
    expect(screen.queryByText(/^Vald:/)).toBeNull();
  });

  it.each(OUTCOMES)(
    "keeps focus in the title field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const title = screen.getByLabelText<HTMLInputElement>(/^Titel/);
      await user.upload(screen.getByLabelText("Fil", { exact: true }), pdf());
      await user.type(title, "Bruksanvisning{Enter}");

      await waitFor(() => {
        expect(title.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(title, "focus");

      settle(outcome);

      await waitFor(() => {
        expect(title.matches(":disabled")).toBe(false);
      });
      expect(refocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(title);
    },
  );
});
