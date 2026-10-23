import { describe, expect, it } from "vite-plus/test";

import {
  canonicalRecipient,
  pluginRecipientsSchema,
  recipientCategoryIssues,
  RECEIVING_HOSTS_MAX_LENGTH,
  receivingHosts,
  recipientHost,
  recipientsBeyondConsent,
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

describe("recipientsBeyondConsent", () => {
  const consented = [canonicalRecipient(provider)];

  it("covers the recipient consented to, and one receiving fewer categories", () => {
    expect(recipientsBeyondConsent([provider], consented)).toEqual([]);
    expect(
      recipientsBeyondConsent(
        [{ ...provider, personalData: ["freeText"] }],
        consented,
      ),
    ).toEqual([]);
    expect(
      recipientsBeyondConsent([{ ...provider, personalData: [] }], consented),
    ).toEqual([]);
  });

  it.each([
    ["a new recipient", { id: "rates", origin: "https://rates.test" }],
    ["an id moved to another origin", { origin: "https://api.example.com" }],
    ["an origin under another id", { id: "other" }],
    [
      "a recipient receiving a category more",
      { personalData: ["freeText", "name", "email"] as const },
    ],
  ])("returns %s", (_label, change) => {
    const changed = { ...provider, ...change };
    expect(recipientsBeyondConsent([changed], consented)).toEqual([changed]);
  });

  it("reads a recipient consented to with no categories", () => {
    const rates = {
      id: "rates",
      origin: "https://rates.test",
      personalData: [] as ("name" | "freeText")[],
    };
    const agreed = [canonicalRecipient(rates)];
    expect(recipientsBeyondConsent([rates], agreed)).toEqual([]);
    expect(
      recipientsBeyondConsent([{ ...rates, personalData: ["name"] }], agreed),
    ).toHaveLength(1);
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

describe("receivingHosts", () => {
  const purpose = { sv: "Syfte", en: "Purpose" };

  it("joins the hosts of the recipients that receive personal data", () => {
    expect(
      receivingHosts([
        { origin: "https://api.anthropic.com", personalData: ["name"] },
        { origin: "https://rates.test", personalData: [] },
        { origin: "https://api.example.com:8443", personalData: ["freeText"] },
      ]),
    ).toBe("api.anthropic.com, api.example.com:8443");
    expect(
      receivingHosts([{ origin: "https://rates.test", personalData: [] }]),
    ).toBe("");
  });

  // A field sized for the answer has to take the longest one a declaration
  // the schema accepts can give, or the board is refused for an answer it did
  // not write.
  it("is at most RECEIVING_HOSTS_MAX_LENGTH for the longest declaration", () => {
    const longest = Array.from({ length: 8 }, (_, index) => {
      const host = `${String(index)}${"a".repeat(62)}.${"b".repeat(63)}.${"c".repeat(64)}`;
      return {
        id: `recipient-${String(index)}`,
        origin: `https://${host}`,
        purpose,
        personalData: ["name" as const],
      };
    });
    expect(longest[0]?.origin).toHaveLength(200);
    expect(pluginRecipientsSchema.safeParse(longest).success).toBe(true);
    expect(receivingHosts(longest)).toHaveLength(RECEIVING_HOSTS_MAX_LENGTH);
  });
});

describe("recipientCategoryIssues", () => {
  it("finds nothing for no recipients, or for categories the plugin handles", () => {
    expect(recipientCategoryIssues([], ["name"])).toEqual([]);
    expect(recipientCategoryIssues([provider], ["name", "freeText"])).toEqual(
      [],
    );
    expect(recipientCategoryIssues([{ personalData: [] }], [])).toEqual([]);
  });

  it("names the path of a category the plugin does not handle", () => {
    const issues = recipientCategoryIssues([provider], ["name"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["recipients", 0, "personalData", 0]);
    expect(issues[0]?.message).toContain('"freeText"');
  });

  // Each occurrence is its own issue, at its own place.
  it("reports a category repeated in one recipient at each place", () => {
    const issues = recipientCategoryIssues(
      [{ personalData: ["email", "name", "email"] }],
      ["name"],
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ["recipients", 0, "personalData", 0],
      ["recipients", 0, "personalData", 2],
    ]);
  });

  it("reads every recipient against the same list", () => {
    const issues = recipientCategoryIssues(
      [
        { personalData: ["name"] },
        { personalData: ["email"] },
        { personalData: ["name", "phone"] },
      ],
      ["name"],
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ["recipients", 1, "personalData", 0],
      ["recipients", 2, "personalData", 1],
    ]);
  });
});
