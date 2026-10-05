import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useFocusAcrossReload } from "./use-focus-across-reload";

function Harness() {
  const [applied, setApplied] = useState(0);
  const { rootRef, remember } = useFocusAcrossReload(applied);
  return (
    <div ref={rootRef}>
      <form key={applied}>
        {applied > 0 && <input type="checkbox" name="clear" />}
        <input type="checkbox" name="secure" />
        <button type="button" onClick={() => undefined}>
          {"Save"}
        </button>
      </form>
      <button
        type="button"
        data-testid="reload"
        onClick={() => {
          remember();
          setApplied(1);
        }}
      >
        {"reload"}
      </button>
    </div>
  );
}

describe("useFocusAcrossReload", () => {
  it("restores focus to the same control when the rebuilt panel has gained one before it", () => {
    render(<Harness />);
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    act(() => {
      // Click would move focus; call the handler with focus on Save.
      screen
        .getByTestId("reload")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Save" }),
    );
  });
});
