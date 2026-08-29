import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { IssueReportingPanel } from "./IssueReportingPanel";

/**
 * Whether the association's website carries an issue report form.
 *
 * The same property the sign-up switch has, for the same reason: what the panel
 * says about a form anyone can reach has to be what the server actually
 * accepted. The dangerous direction is closing - a board that unticks the box,
 * sees "off" and walks away has been told a public form is gone while it is
 * still on the website.
 */

const saveIssueReporting = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  saveIssueReporting: (input: unknown) => saveIssueReporting(input),
}));

const checkbox = () => screen.getByRole("checkbox");

beforeEach(() => {
  saveIssueReporting.mockReset();
});

describe("the state in words", () => {
  it("goes back to the server's answer when the save is refused", async () => {
    saveIssueReporting.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const session = userEvent.setup();
    render(<IssueReportingPanel publicFormEnabled />);

    await session.click(checkbox());

    await waitFor(() => {
      expect(screen.getByText(/kunde inte sparas/i)).toBeTruthy();
    });
    expect(checkbox()).toHaveProperty("checked", true);
    expect(screen.getByText(/^På:/)).toBeTruthy();
  });

  it("keeps the new state when the save lands", async () => {
    saveIssueReporting.mockResolvedValue({
      ok: true,
      value: { publicFormEnabled: false },
    });

    const session = userEvent.setup();
    render(<IssueReportingPanel publicFormEnabled />);

    await session.click(checkbox());

    await waitFor(() => {
      expect(checkbox()).toHaveProperty("checked", false);
    });
    expect(screen.getByText(/^Av:/)).toBeTruthy();
  });

  it("follows the server when a reload corrects the prop", () => {
    const { rerender } = render(
      <IssueReportingPanel publicFormEnabled={false} />,
    );
    expect(checkbox()).toHaveProperty("checked", false);

    rerender(<IssueReportingPanel publicFormEnabled />);

    expect(checkbox()).toHaveProperty("checked", true);
  });

  it("is read-only for an account that may not change it", () => {
    render(<IssueReportingPanel publicFormEnabled editable={false} />);

    expect(checkbox()).toHaveProperty("disabled", true);
  });
});
