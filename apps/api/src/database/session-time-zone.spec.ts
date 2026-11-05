import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import ConnectionParameters from "pg/lib/connection-parameters";

import { pinnedSessionConfig } from "./session-time-zone";

/** What `pg` would send as the connection's `options` start-up parameter. */
function sentOptions(connectionString: string): string | undefined {
  const parameters = new ConnectionParameters(
    pinnedSessionConfig(connectionString),
  );
  return parameters.options as string | undefined;
}

describe("pinnedSessionConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks for UTC when the connection string says nothing", () => {
    expect(sentOptions("postgres://u:p@db:5432/openbrf")).toBe(
      "-c TimeZone=UTC",
    );
  });

  it("asks for UTC after a time zone the connection string names", () => {
    const sent = sentOptions(
      "postgres://u:p@db/openbrf?options=-c%20TimeZone%3DAsia/Tokyo",
    );
    // PostgreSQL applies the last -c for a setting.
    expect(sent?.endsWith("-c TimeZone=UTC")).toBe(true);
  });

  it("keeps another option the connection string carries", () => {
    expect(
      sentOptions(
        "postgres://u:p@db/openbrf?options=-c%20statement_timeout%3D5s",
      ),
    ).toBe("-c statement_timeout=5s -c TimeZone=UTC");
  });

  it("keeps the options of PGOPTIONS when the connection string has none", () => {
    vi.stubEnv("PGOPTIONS", "-c statement_timeout=5s");
    expect(sentOptions("postgres://u:p@db/openbrf")).toBe(
      "-c statement_timeout=5s -c TimeZone=UTC",
    );
  });

  it("reads the options of the connection string before PGOPTIONS, as pg does", () => {
    vi.stubEnv("PGOPTIONS", "-c statement_timeout=5s");
    expect(
      sentOptions("postgres://u:p@db/openbrf?options=-c%20work_mem%3D8MB"),
    ).toBe("-c work_mem=8MB -c TimeZone=UTC");
  });

  it("keeps the last of several options parameters, as pg reads them", () => {
    expect(
      sentOptions(
        "postgres://u:p@db/openbrf?options=-c%20work_mem%3D8MB&options=-c%20statement_timeout%3D5s",
      ),
    ).toBe("-c statement_timeout=5s -c TimeZone=UTC");
  });

  it("asks for UTC when the connection string has user information and no host", () => {
    const sent = sentOptions(
      "postgres://u:p@/openbrf?host=/var/run/postgresql&options=-c%20TimeZone%3DAsia/Tokyo",
    );
    expect(sent?.endsWith("-c TimeZone=UTC")).toBe(true);
    const { connectionString } = pinnedSessionConfig(
      "postgres://u:p%40q@/openbrf?host=/var/run/postgresql",
    );
    expect(connectionString).toContain("postgres://u:p%40q@/openbrf?");
    expect(connectionString).not.toContain("empty-host");
  });

  it("asks for UTC when the connection string has no host and no user information", () => {
    const sent = sentOptions(
      "postgres:///openbrf?host=/tmp&options=-c%20TimeZone%3DAsia/Tokyo",
    );
    expect(sent?.endsWith("-c TimeZone=UTC")).toBe(true);
  });

  it("leaves the host to PGHOST when the empty credentials are dropped", () => {
    vi.stubEnv("PGHOST", "/var/run/postgresql");
    const { connectionString } = pinnedSessionConfig(
      "postgres://@/openbrf?user=openbrf_app",
    );
    expect(connectionString).not.toContain("empty-host");
    const parameters = new ConnectionParameters(
      pinnedSessionConfig("postgres://@/openbrf?user=openbrf_app"),
    );
    expect(parameters.host).toBe("/var/run/postgresql");
    expect(parameters.user).toBe("openbrf_app");
    expect(parameters.options).toBe("-c TimeZone=UTC");
  });

  it("keeps a user named like the stand-in host", () => {
    vi.stubEnv("PGHOST", "/var/run/postgresql");
    for (const url of [
      "postgres://empty-host.invalid@/openbrf",
      "postgres://empty-host.invalid:secret@/openbrf",
      "postgres://empty-host.invalid:@/openbrf",
    ]) {
      const parameters = new ConnectionParameters(pinnedSessionConfig(url));
      expect(parameters.user).toBe("empty-host.invalid");
      expect(parameters.host).toBe("/var/run/postgresql");
    }
  });

  it("keeps PGOPTIONS when the connection string's options are blank", () => {
    vi.stubEnv("PGOPTIONS", "-c statement_timeout=5s");
    expect(sentOptions("postgres://u:p@db/openbrf?options=")).toBe(
      "-c statement_timeout=5s -c TimeZone=UTC",
    );
  });

  it("asks for UTC after a time zone PGOPTIONS names", () => {
    vi.stubEnv("PGOPTIONS", "-c TimeZone=Asia/Tokyo");
    expect(sentOptions("postgres://u:p@db/openbrf")).toBe(
      "-c TimeZone=Asia/Tokyo -c TimeZone=UTC",
    );
  });

  it("keeps the other parts of the connection string", () => {
    const { connectionString } = pinnedSessionConfig(
      "postgres://app:p%40ss%2Fword@db.example:6543/openbrf?sslmode=require",
    );
    const url = new URL(connectionString ?? "");
    expect(url.username).toBe("app");
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
    expect(url.host).toBe("db.example:6543");
    expect(url.pathname).toBe("/openbrf");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("passes the other settings through", () => {
    expect(
      pinnedSessionConfig("postgres://u:p@db/openbrf", { max: 3 }).max,
    ).toBe(3);
  });
});
