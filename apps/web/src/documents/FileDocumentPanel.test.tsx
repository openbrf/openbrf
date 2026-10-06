import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { FileDocumentPanel } from "./FileDocumentPanel";

/**
 * Filing a document while the request is still running.
 *
 * The fields are cleared once the document is filed, so what is typed in the
 * meantime would be wiped without a word. The panel refuses it instead, and
 * hands focus back when it opens again.
 */

const fileDocument = vi.fn();

vi.mock("./documents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents-api")>()),
  fileDocument: (fields: unknown, file: unknown) => fileDocument(fields, file),
}));

/** Holds the request open, so the panel is observed mid-save. */
function holdRequest(): (outcome: unknown) => void {
  let settle: (outcome: unknown) => void = () => undefined;
  fileDocument.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (outcome) => {
    settle(outcome);
  };
}

const OUTCOMES = [
  ["once the document is filed", { ok: true, value: { id: "document-1" } }],
  [
    "when the filing is refused",
    { ok: false, failure: { status: 422, reason: "unsupported-type" } },
  ],
] as const;

beforeEach(() => {
  fileDocument.mockReset();
});

async function fill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/^Titel/), "Stadgar 2026");
  await user.type(screen.getByLabelText(/^Pärm/), "Stadgar");
  await user.upload(
    screen.getByLabelText("Fil", { exact: true }),
    new File(["bytes"], "stadgar.pdf", { type: "application/pdf" }),
  );
}

describe("while a document is being filed", () => {
  it("locks the fields, so nothing typed is lost when they are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    render(<FileDocumentPanel onFiled={() => undefined} />);

    const title = screen.getByLabelText<HTMLInputElement>(/^Titel/);
    const category = screen.getByLabelText<HTMLInputElement>(/^Pärm/);
    await fill(user);
    expect(title.matches(":disabled")).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Lägg in dokumentet" }),
    );

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(true);
    });
    expect(category.matches(":disabled")).toBe(true);
    expect(
      screen.getByLabelText("Fil", { exact: true }).matches(":disabled"),
    ).toBe(true);
    await user.type(title, "9");
    await user.type(category, "x");
    expect(title.value).toBe("Stadgar 2026");
    expect(category.value).toBe("Stadgar");

    settle({ ok: true, value: { id: "document-1" } });

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(false);
    });
    expect(title.value).toBe("");
    expect(category.value).toBe("");
    expect(screen.queryByText(/^Vald:/)).toBeNull();
  });

  it.each(OUTCOMES)(
    "keeps focus in the title field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      render(<FileDocumentPanel onFiled={() => undefined} />);

      const title = screen.getByLabelText<HTMLInputElement>(/^Titel/);
      await user.type(screen.getByLabelText(/^Pärm/), "Stadgar");
      await user.upload(
        screen.getByLabelText("Fil", { exact: true }),
        new File(["bytes"], "stadgar.pdf", { type: "application/pdf" }),
      );
      await user.type(title, "Stadgar 2026{Enter}");

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
