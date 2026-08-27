import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import { Notice, type NoticeTone } from "./Notice";

/**
 * Colour is never the only signal.
 *
 * DESIGN.md states this as a rule and it is not decoration: board members and
 * residents span a wide age range, and a red-green colour blind reader has to be
 * able to tell a confirmation from a failure. Every notice therefore carries a
 * written word as well as its colour, and this test is what stops that word
 * being dropped as visual noise later.
 */

const BODY = "message";
const TONES: readonly NoticeTone[] = ["ok", "warn", "danger", "info"];

describe("every tone", () => {
  it.each(TONES)("names itself in words as well as colour: %s", (tone) => {
    const { container } = render(<Notice tone={tone}>{BODY}</Notice>);

    const label = container.querySelector(".text-chip");
    expect(label?.textContent ?? "").not.toBe("");
    // A distinct word per tone, not one label reused for all four.
    expect(label?.textContent).not.toBe(BODY);
  });

  it.each(TONES)("carries a border as a third signal: %s", (tone) => {
    const { container } = render(<Notice tone={tone}>{BODY}</Notice>);

    expect(container.firstElementChild?.className).toContain("border-l-4");
  });

  it("gives the four tones four different words", () => {
    const words = TONES.map((tone) => {
      const { container } = render(<Notice tone={tone}>{BODY}</Notice>);
      const label = container.querySelector(".text-chip")?.textContent ?? "";
      return label;
    });

    // Info and one other sharing a word would be a translation bug, not a
    // design choice: the word is the signal.
    expect(new Set(words).size).toBe(TONES.length);
  });
});

describe("announcing an outcome", () => {
  it("is a live region only when asked", () => {
    const { container: quiet } = render(<Notice tone="info">{BODY}</Notice>);
    expect(quiet.firstElementChild?.getAttribute("aria-live")).toBeNull();

    const { container: live } = render(
      <Notice tone="ok" live>
        {BODY}
      </Notice>,
    );
    // A standing notice was already there on load; only the result of an action
    // interrupts a screen reader.
    expect(live.firstElementChild?.getAttribute("aria-live")).toBe("polite");
    expect(live.firstElementChild?.getAttribute("role")).toBe("status");
  });
});
