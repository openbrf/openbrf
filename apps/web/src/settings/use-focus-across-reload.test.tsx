import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

function Saving({ rebuild }: { rebuild: boolean }) {
  const [applied, setApplied] = useState(0);
  const [saving, setSaving] = useState(false);
  const { rootRef, remember } = useFocusAcrossReload(applied);
  return (
    <div ref={rootRef}>
      <form key={rebuild ? applied : 0}>
        <input type="text" name="name" disabled={saving} />
        <button type="button" disabled={saving}>
          {"Save"}
        </button>
      </form>
      <button
        type="button"
        data-testid="start"
        onClick={() => {
          setSaving(true);
        }}
      >
        {"start"}
      </button>
      <button
        type="button"
        data-testid="saved"
        onClick={() => {
          setSaving(false);
        }}
      >
        {"saved"}
      </button>
      <button
        type="button"
        data-testid="reloaded"
        onClick={() => {
          remember();
          setApplied(1);
        }}
      >
        {"reloaded"}
      </button>
      <button
        type="button"
        data-testid="finish"
        onClick={() => {
          remember();
          setSaving(false);
          setApplied(1);
        }}
      >
        {"finish"}
      </button>
    </div>
  );
}

/**
 * Chrome drops focus from a control that is disabled, without a blur event;
 * jsdom keeps it, so the body is reported as active until focus is set again.
 */
function dropFocus(): void {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => document.body,
  });
  const focus = Reflect.get(HTMLElement.prototype, "focus") as (
    this: HTMLElement,
    options?: FocusOptions,
  ) => void;
  const spy = vi.spyOn(HTMLElement.prototype, "focus");
  spy.mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    spy.mockRestore();
    Reflect.deleteProperty(document, "activeElement");
    focus.call(this, options);
  });
}

function saveWithFocusDropped(): void {
  act(() => {
    screen
      .getByTestId("start")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  dropFocus();
  act(() => {
    screen
      .getByTestId("finish")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "activeElement");
});

function click(testId: string): void {
  act(() => {
    screen
      .getByTestId(testId)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("useFocusAcrossReload when the save enables the control before the reload lands", () => {
  it.each([
    ["rebuilt", true],
    ["unchanged", false],
  ])("restores focus to the %s panel", (_name, rebuild) => {
    render(<Saving rebuild={rebuild} />);
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    click("start");
    dropFocus();
    click("saved");
    click("reloaded");
    const now = screen.getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(now);
    expect(now === save).toBe(!rebuild);
  });

  it("leaves focus alone when the user moved it after the save enabled the control", () => {
    render(<Saving rebuild />);
    screen.getByRole("button", { name: "Save" }).focus();
    click("start");
    dropFocus();
    click("saved");
    screen.getByRole("textbox").focus();
    click("reloaded");
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

describe("useFocusAcrossReload while a save disables the focused control", () => {
  it("restores focus to the rebuilt control", () => {
    render(<Saving rebuild />);
    screen.getByRole("button", { name: "Save" }).focus();
    saveWithFocusDropped();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Save" }),
    );
  });

  it("restores focus to the same control when the panel is not rebuilt", () => {
    render(<Saving rebuild={false} />);
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    saveWithFocusDropped();
    expect(document.activeElement).toBe(save);
  });

  it("leaves focus alone when the user moved it elsewhere", () => {
    render(<Saving rebuild />);
    screen.getByRole("button", { name: "Save" }).focus();
    screen.getByRole("textbox").focus();
    act(() => {
      screen
        .getByTestId("finish")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

function Redirecting() {
  const [applied, setApplied] = useState(0);
  const [saving, setSaving] = useState(false);
  const [routed, setRouted] = useState(false);
  const { rootRef, remember } = useFocusAcrossReload(applied);
  return (
    <>
      {routed ? (
        <div ref={rootRef}>
          <form key={applied}>
            <button type="button" disabled={saving}>
              {"Save"}
            </button>
          </form>
        </div>
      ) : null}
      <button
        type="button"
        data-testid="route"
        onClick={() => {
          setRouted(true);
        }}
      >
        {"route"}
      </button>
      <button
        type="button"
        data-testid="start"
        onClick={() => {
          setSaving(true);
        }}
      >
        {"start"}
      </button>
      <button
        type="button"
        data-testid="finish"
        onClick={() => {
          remember();
          setSaving(false);
          setApplied(1);
        }}
      >
        {"finish"}
      </button>
    </>
  );
}

describe("useFocusAcrossReload when the root appears after the hook mounted", () => {
  it("restores focus lost while a save disabled the control", () => {
    render(<Redirecting />);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    click("route");
    screen.getByRole("button", { name: "Save" }).focus();
    saveWithFocusDropped();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Save" }),
    );
  });
});

function Renamed() {
  const [applied, setApplied] = useState(0);
  const { rootRef, remember } = useFocusAcrossReload(applied);
  return (
    <div ref={rootRef}>
      <form key={applied}>
        <button type="submit">{applied === 0 ? "Spara" : "Save"}</button>
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

describe("useFocusAcrossReload when the reload renames the save button", () => {
  it("restores focus to the rebuilt submit button, whatever it now says", () => {
    render(<Renamed />);
    screen.getByRole("button", { name: "Spara" }).focus();
    act(() => {
      screen
        .getByTestId("reload")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Save" }),
    );
  });
});
