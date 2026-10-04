import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  platformVersion,
  platformVersionLine,
  readPlatformVersion,
} from "./version";

/** The package version, read the way a reviewer would check it. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  }
).version;

const REVISION = "0123456789abcdef0123456789abcdef01234567";

describe("the platform's version", () => {
  it("is the API's package version, the fixed group's", () => {
    expect(readPlatformVersion({}).version).toBe(PACKAGE_VERSION);
    expect(platformVersion().version).toBe(PACKAGE_VERSION);
  });

  it("carries the revision the image was built from", () => {
    expect(readPlatformVersion({ OPENBRF_REVISION: REVISION }).revision).toBe(
      REVISION,
    );
  });

  it("has no revision when the build argument was empty or absent", () => {
    // The Dockerfile's argument defaults to empty, and a checkout sets nothing.
    expect(readPlatformVersion({ OPENBRF_REVISION: "" }).revision).toBeNull();
    expect(readPlatformVersion({}).revision).toBeNull();
  });

  it("is read once and kept", () => {
    expect(platformVersion()).toBe(platformVersion());
  });
});

describe("the line a starting instance logs", () => {
  it("names the version and twelve characters of the revision", () => {
    expect(platformVersionLine({ version: "0.1.0", revision: REVISION })).toBe(
      "Open BRF 0.1.0 (0123456789ab)",
    );
  });

  it("names the version alone when there is no revision", () => {
    expect(platformVersionLine({ version: "0.1.0", revision: null })).toBe(
      "Open BRF 0.1.0",
    );
  });
});
