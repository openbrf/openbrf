import { describe, expect, it } from "vite-plus/test";

import {
  canonicalRecipient,
  recipientHost,
  sameRecipientDeclaration,
} from "./recipients.ts";

const provider = {
  id: "model-provider",
  origin: "https://api.anthropic.com",
  personalData: ["freeText", "name"] as const,
};

describe("canonicalRecipient", () => {
  // The order a manifest lists categories in is not what the board agreed to.
  it("reads the categories in any order as one declaration", () => {
    expect(
      canonicalRecipient({ ...provider, personalData: ["name", "freeText"] }),
    ).toBe(canonicalRecipient(provider));
  });

  it.each([
    ["the id", { id: "other" }],
    ["the origin", { origin: "https://api.example.com" }],
    ["the categories", { personalData: ["freeText"] as const }],
  ])("tells a change of %s apart", (_label, change) => {
    expect(canonicalRecipient({ ...provider, ...change })).not.toBe(
      canonicalRecipient(provider),
    );
  });
});

describe("sameRecipientDeclaration", () => {
  it("compares as a multiset, in any order", () => {
    const other = { ...provider, id: "rates", origin: "https://rates.test" };
    expect(sameRecipientDeclaration([provider, other], [other, provider])).toBe(
      true,
    );
    expect(sameRecipientDeclaration([provider], [provider, provider])).toBe(
      false,
    );
    expect(sameRecipientDeclaration([provider], [])).toBe(false);
  });
});

describe("recipientHost", () => {
  it("names the host and a port other than 443", () => {
    expect(recipientHost("https://api.anthropic.com")).toBe(
      "api.anthropic.com",
    );
    expect(recipientHost("https://api.example.com:8443")).toBe(
      "api.example.com:8443",
    );
  });
});
