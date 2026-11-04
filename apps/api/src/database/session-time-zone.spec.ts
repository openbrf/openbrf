import { describe, expect, it } from "vite-plus/test";
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
