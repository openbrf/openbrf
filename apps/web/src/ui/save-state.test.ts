import { describe, expect, it } from "vite-plus/test";

import i18n from "../i18n";
import { failureMessage, failureMessageKey } from "./save-state";

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

describe("failureMessageKey", () => {
  it("says a support session's refusal is the access being read-only", () => {
    // Not the account's own "not allowed": a supporter has no account, and the
    // remedy is to ask the administrator (ADR 0028).
    expect(
      t(
        failureMessageKey(
          { status: 403, reason: "support-access-read-only" },
          {},
          "settings.errors.unknown",
        ),
      ),
    ).toBe(
      "Supportåtkomst är bara läsande. Be administratören att göra ändringen.",
    );
  });

  it("keeps the account's sentence for any other 403", () => {
    expect(
      failureMessageKey(
        { status: 403, reason: "unexpected" },
        {},
        "settings.errors.unknown",
      ),
    ).toBe("form.errors.forbidden");
  });
});
