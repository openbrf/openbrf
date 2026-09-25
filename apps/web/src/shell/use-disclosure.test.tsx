import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDisclosure } from "./use-disclosure";

/** The router's location, as the mock below answers it. */
const location = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (value: { pathname: string }) => string;
  }): string => select({ pathname: location.pathname }),
}));

/* Names held in constants so the no-literal-string rule stays strict. */
const TRIGGER = "Styrelsen";
const LINK = "Stämmor";
const OUTSIDE = "Elsewhere";

/** A trigger, its panel of one link, and a button outside both. */
function Harness(): ReactElement {
  const { open, toggle, close, panelId, triggerRef, containerRef } =
    useDisclosure<HTMLDivElement>();
  return (
    <>
      <button type="button">{OUTSIDE}</button>
      <div ref={containerRef}>
        <button
          type="button"
          ref={triggerRef}
          aria-expanded={open}
          onClick={toggle}
        >
          {TRIGGER}
        </button>
        {open ? (
          <ul id={panelId}>
            <li>
              <a href="#meetings" onClick={close}>
                {LINK}
              </a>
            </li>
          </ul>
        ) : null}
      </div>
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: TRIGGER });
const outside = () => screen.getByRole("button", { name: OUTSIDE });
const link = () => screen.queryByRole("link", { name: LINK });

function renderOpen() {
  const view = render(<Harness />);
  fireEvent.click(trigger());
  expect(link()).not.toBeNull();
  return view;
}

afterEach(() => {
  location.pathname = "/";
});

describe("useDisclosure", () => {
  it("opens and closes on its trigger", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(link()).toBeNull();

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(link()).not.toBeNull();

    fireEvent.click(trigger());
    expect(link()).toBeNull();
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    renderOpen();
    link()?.focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(link()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when a link in it is pressed, focus back on the trigger", () => {
    renderOpen();
    link()?.focus();

    fireEvent.click(link() as HTMLElement);

    expect(link()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a pointer pressed outside, and leaves focus where it is", () => {
    renderOpen();
    outside().focus();

    fireEvent.pointerDown(outside());

    expect(link()).toBeNull();
    expect(document.activeElement).toBe(outside());
  });

  it("stays open on a pointer pressed inside", () => {
    renderOpen();

    fireEvent.pointerDown(link() as HTMLElement);

    expect(link()).not.toBeNull();
  });

  it("closes when focus moves outside, and only then", () => {
    renderOpen();
    const inside = link() as HTMLElement;

    // Within the trigger and its panel, and to nothing at all, it stays.
    fireEvent.focusOut(inside, { relatedTarget: trigger() });
    expect(link()).not.toBeNull();
    fireEvent.focusOut(inside, { relatedTarget: null });
    expect(link()).not.toBeNull();

    fireEvent.focusOut(inside, { relatedTarget: outside() });
    expect(link()).toBeNull();
  });

  it("closes when the page changes", () => {
    const view = renderOpen();

    location.pathname = "/meetings";
    view.rerender(<Harness />);

    expect(link()).toBeNull();
  });

  it("hands focus back only when it was on the trigger or in the panel", () => {
    renderOpen();
    outside().focus();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(link()).toBeNull();
    expect(document.activeElement).toBe(outside());
  });

  it("listens for nothing while closed", () => {
    render(<Harness />);
    outside().focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(document.activeElement).toBe(outside());
  });
});
