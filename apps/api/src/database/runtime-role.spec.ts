import { describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { assertConstrainedRuntimeRole } from "./runtime-role";

/**
 * The application's own refusal of an owner's credentials in its environment,
 * which the entrypoint makes too, for a platform that never runs the
 * entrypoint.
 *
 * Nothing listens on port 1, so a start that got past the refusal would fail
 * on the connection instead, with a message that does not name the variable.
 */

const RUNTIME_URL = "postgresql://openbrf_app:runtime@127.0.0.1:1/openbrf";
const DECOY = "owner-password-that-is-never-repeated";

const production = {
  NODE_ENV: "production",
  DATABASE_URL_RUNTIME: RUNTIME_URL,
} as Env;

describe("a production start", () => {
  it.each([
    ["OWNER_DB_PASSWORD", { OWNER_DB_PASSWORD: DECOY }],
    ["POSTGRES_PASSWORD", { POSTGRES_PASSWORD: DECOY }],
    [
      "DATABASE_URL",
      {
        DATABASE_URL: `postgresql://openbrf_owner:${DECOY}@127.0.0.1:1/openbrf`,
        DATABASE_URL_RUNTIME: RUNTIME_URL,
      },
    ],
    [
      "DATABASE_URL",
      {
        DATABASE_URL: `postgresql://openbrf_owner:${DECOY}@127.0.0.1:1/openbrf`,
        RUNTIME_DB_PASSWORD: "runtime",
      },
    ],
  ])("refuses %s in its environment, by name", async (name, source) => {
    const failure = await assertConstrainedRuntimeRole(production, source).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain(
      `${name} set in the application's environment`,
    );
    expect(failure?.message.includes(DECOY), "no value repeated").toBe(false);
  });

  it("counts an empty variable as unset, as Compose passes one", async () => {
    const failure = await assertConstrainedRuntimeRole(production, {
      OWNER_DB_PASSWORD: "",
      POSTGRES_PASSWORD: "",
      DATABASE_URL: "",
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // On to the connection, which nothing answers.
    expect(failure?.message ?? "").not.toContain("application's environment");
  });
});

describe("outside production", () => {
  it("leaves a development instance's single connection alone", async () => {
    await expect(
      assertConstrainedRuntimeRole({ NODE_ENV: "development" } as Env, {
        DATABASE_URL: RUNTIME_URL,
        POSTGRES_PASSWORD: DECOY,
      }),
    ).resolves.toBeUndefined();
  });
});
