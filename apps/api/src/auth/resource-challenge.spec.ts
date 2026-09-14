import { describe, expect, it } from "vitest";

import type { ProtectedResource } from "./protected-resource";
import {
  insufficientScopeChallenge,
  resourceMetadataUrl,
  unauthorizedChallenge,
} from "./resource-challenge";

/**
 * The challenge headers, which are the whole remedy a refused client gets.
 *
 * A malformed challenge is not a cosmetic fault: a client parses it to find
 * out where a token comes from, so a broken one leaves a legitimate client
 * with an address it cannot use and no way to discover why.
 */

const RESOURCE: ProtectedResource = {
  declared: true,
  path: "/api/plugin/connector/mcp",
  url: "https://brf.example/api/plugin/connector/mcp",
};

describe("resourceMetadataUrl", () => {
  it("points at the resource's own document, under the well-known prefix", () => {
    expect(resourceMetadataUrl(RESOURCE, "https://brf.example")).toBe(
      "https://brf.example/.well-known/oauth-protected-resource/api/plugin/connector/mcp",
    );
  });

  it("is absolute even when the base carries a path", () => {
    // The document lives at the root of the origin whatever else is served
    // there; a relative join would put it under the base's path instead.
    expect(resourceMetadataUrl(RESOURCE, "https://brf.example/app/")).toBe(
      "https://brf.example/.well-known/oauth-protected-resource/api/plugin/connector/mcp",
    );
  });

  it("names the sub-path form rather than the bare one", () => {
    // Both answer with the same document, but this is the one that names the
    // route the connector actually serves, so it is what a client should keep.
    const url = resourceMetadataUrl(RESOURCE, "https://brf.example");
    expect(url.endsWith(RESOURCE.path)).toBe(true);
  });
});

describe("unauthorizedChallenge", () => {
  it("is a Bearer challenge carrying the metadata pointer", () => {
    expect(unauthorizedChallenge("https://brf.example/.well-known/x")).toBe(
      'Bearer resource_metadata="https://brf.example/.well-known/x"',
    );
  });
});

describe("insufficientScopeChallenge", () => {
  it("names every scope at once, space separated", () => {
    const challenge = insufficientScopeChallenge(
      "https://brf.example/.well-known/x",
      ["mcp:read", "mcp:write"],
      "This connection does not carry mcp:write.",
    );

    expect(challenge).toContain('error="insufficient_scope"');
    // Every scope in one challenge: a client told only the next missing one
    // would be refused again for each of the others.
    expect(challenge).toContain('scope="mcp:read mcp:write"');
    expect(challenge).toContain(
      'resource_metadata="https://brf.example/.well-known/x"',
    );
  });

  it("cannot be broken out of by a quote in the description", () => {
    const challenge = insufficientScopeChallenge(
      "https://brf.example/.well-known/x",
      ["mcp:read"],
      'a "quoted" phrase',
    );

    // A raw quote would close error_description early and turn the rest of the
    // sentence into parameters of its own, so a client would read a malformed
    // challenge rather than the one intended.
    expect(challenge).toContain(`error_description="a 'quoted' phrase"`);
    expect(challenge.match(/"/g)?.length).toBe(8);
  });
});
