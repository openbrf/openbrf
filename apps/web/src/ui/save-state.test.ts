import { describe, expect, it } from "vitest";

import i18n from "../i18n";
import { failureMessage } from "./save-state";

/**
 * A schema refusal names the field it refused.
 *
 * Retrying the same input can never succeed, so "could not be saved just now,
 * try again" is the one sentence it must not be.
 */

const t = i18n.getFixedT("sv");

const refusal = (...paths: string[]) => ({
  status: 400,
  reason: "invalid-body",
  detail: paths.map((path) => ({ path, message: "Invalid" })),
});

describe("failureMessage", () => {
  it("names a refused field by the form's own label", () => {
    expect(
      failureMessage(t, refusal("postalCode"), {}, "settings.errors.unknown", {
        postalCode: "settings.addresses.postalCode",
      }),
    ).toBe("Postnummer godtogs inte. Rätta fältet och spara igen.");
  });

  it("reads a list row's field as the column, once", () => {
    expect(
      failureMessage(
        t,
        refusal("apartments.0.number", "apartments.3.number"),
        {},
        "settings.errors.unknown",
        { "apartments.number": "settings.apartments.table.number" },
      ),
    ).toBe("Lägenhetsnummer godtogs inte. Rätta fältet och spara igen.");
  });

  it("says something was not accepted when no refused field has a label", () => {
    expect(
      failureMessage(t, refusal("unknown"), {}, "settings.errors.unknown"),
    ).toBe(
      "Något i formuläret godtogs inte. Kontrollera uppgifterna och spara igen.",
    );
  });

  it("leaves every other failure to its own sentence", () => {
    expect(
      failureMessage(
        t,
        { status: 0, reason: "offline" },
        {},
        "settings.errors.unknown",
      ),
    ).toBe("Det kunde inte sparas just nu. Försök igen.");
  });
});
