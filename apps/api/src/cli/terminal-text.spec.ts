import { describe, expect, it } from "vitest";

import { terminalText } from "./terminal-text";

describe("terminalText", () => {
  it("leaves printable text, accents and tabs as they are", () => {
    expect(terminalText("Bokning\tå ä ö @openbrf/plugin-booking 1.2.0")).toBe(
      "Bokning\tå ä ö @openbrf/plugin-booking 1.2.0",
    );
  });

  it("shows an escape sequence instead of sending it to the terminal", () => {
    expect(terminalText("\u001b]0;pwned\u0007name")).toBe(
      "\\x1b]0;pwned\\x07name",
    );
  });

  it("keeps a value on one line", () => {
    expect(terminalText("a\r\n  status       installed\u2028b")).toBe(
      "a\\r\\n  status       installed\\u2028b",
    );
  });

  it("shows C1 controls and bidirectional overrides as escapes", () => {
    expect(terminalText("\u009b31m\u202egnp.exe\u2066")).toBe(
      "\\x9b31m\\u202egnp.exe\\u2066",
    );
  });
});
