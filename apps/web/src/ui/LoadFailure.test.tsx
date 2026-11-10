import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { LoadFailure } from "./LoadFailure";

/**
 * Where the focus goes when a notice answers a retry that failed again.
 *
 * A screen that takes the notice away while its retry is out takes the button
 * the reader pressed with it, and the focus falls to the page. The new notice's
 * retry takes it back, but only from the page: a reader who moved on to
 * another control in the meantime keeps their place.
 */
describe("the focus on a retry", () => {
  it("is taken from the page when the notice answers a retry", () => {
    render(
      <LoadFailure
        messageKey="issues.loadFailed"
        onRetry={() => undefined}
        focusRetry
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Försök igen" }),
    );
  });

  it("is left where it is when the notice answers no retry", () => {
    render(
      <LoadFailure messageKey="issues.loadFailed" onRetry={() => undefined} />,
    );

    expect(document.activeElement).toBe(document.body);
  });

  it("is not taken from another control the reader moved to", () => {
    render(<input aria-label="Sök" />);
    const elsewhere = screen.getByLabelText("Sök");
    elsewhere.focus();

    render(
      <LoadFailure
        messageKey="issues.loadFailed"
        onRetry={() => undefined}
        focusRetry
      />,
    );

    expect(document.activeElement).toBe(elsewhere);
  });
});
