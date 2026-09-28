import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { assertConstrainedRuntimeRole } from "./runtime-role";

/**
 * A production start refuses a connection that is not the constrained role.
 *
 * DATABASE_URL_RUNTIME is written by hand by an operator who manages the role
 * themselves, and nothing about the variable says which role it names. These
 * suites connect as the schema owner, which is exactly the connection the
 * application must refuse, and as a role of their own holding what the
 * hardening script leaves openbrf_app, which it must accept.
 */

const env = loadEnvForIntegrationTests();

const suffix = process.hrtime.bigint().toString(36);
const CONSTRAINED_ROLE = `openbrf_runtime_probe_${suffix.replace(/[^a-z0-9]/gi, "")}`;
const CONSTRAINED_PASSWORD = randomBytes(16).toString("hex");

let owner: PrismaClient;

function production(url: string) {
  return { ...env, NODE_ENV: "production" as const, DATABASE_URL_RUNTIME: url };
}

function asRole(role: string, password: string): string {
  const url = new URL(env.DATABASE_URL);
  url.username = role;
  url.password = password;
  return url.href;
}

beforeAll(async () => {
  owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  // What harden-runtime-role.sql leaves the application on the two tables the
  // check reads: SELECT and INSERT, nothing that rewrites, nothing owned.
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${CONSTRAINED_ROLE} LOGIN PASSWORD '${CONSTRAINED_PASSWORD}'`,
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA public TO ${CONSTRAINED_ROLE}`,
  );
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT ON public.member_register_entry, public.audit_log_entry TO ${CONSTRAINED_ROLE}`,
  );
});

afterAll(async () => {
  await owner.$executeRawUnsafe(`DROP OWNED BY ${CONSTRAINED_ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${CONSTRAINED_ROLE}`);
  await owner.$disconnect();
});

describe("a production start", () => {
  it("refuses to serve when connected as the schema owner", async () => {
    await expect(
      assertConstrainedRuntimeRole(production(env.DATABASE_URL)),
    ).rejects.toThrow(/not the constrained runtime role/);
  });

  it("names what it found, and nothing from the connection", async () => {
    const failure = await assertConstrainedRuntimeRole(
      production(env.DATABASE_URL),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(
      /can rewrite the member register or the audit log/,
    );
    // The role's name is what an operator needs to read; the URL it came in
    // is not, and would carry the password.
    expect(failure?.message.includes("postgresql://")).toBe(false);
    expect(failure?.message.includes(env.DATABASE_URL)).toBe(false);
  });

  it("serves when connected as a role that owns nothing and cannot rewrite the archive", async () => {
    await expect(
      assertConstrainedRuntimeRole(
        production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a role that can write the migration history", async () => {
    await owner.$executeRawUnsafe(
      `GRANT UPDATE ON public._prisma_migrations TO ${CONSTRAINED_ROLE}`,
    );
    try {
      await expect(
        assertConstrainedRuntimeRole(
          production(asRole(CONSTRAINED_ROLE, CONSTRAINED_PASSWORD)),
        ),
      ).rejects.toThrow(/can write the migration history/);
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE UPDATE ON public._prisma_migrations FROM ${CONSTRAINED_ROLE}`,
      );
    }
  });
});

describe("outside production", () => {
  it("leaves the owner connection a development instance runs on alone", async () => {
    await expect(
      assertConstrainedRuntimeRole({
        ...env,
        DATABASE_URL_RUNTIME: env.DATABASE_URL,
      }),
    ).resolves.toBeUndefined();
  });
});
