import { describe, expect, it } from "vite-plus/test";

import { reporterLinkRecipient } from "./issue-reporter-link-recipient";

describe("reporterLinkRecipient", () => {
  it("drops a tag after a plus, whatever the domain", () => {
    expect(reporterLinkRecipient("anna+1@exempel.se")).toBe("anna@exempel.se");
    expect(reporterLinkRecipient("anna+felanmalan+2@exempel.se")).toBe(
      "anna@exempel.se",
    );
    expect(reporterLinkRecipient("anna@exempel.se")).toBe("anna@exempel.se");
  });

  it("folds case and the space around the address", () => {
    expect(reporterLinkRecipient("  Anna+X@Exempel.SE ")).toBe(
      "anna@exempel.se",
    );
  });

  it("drops the dots of a Google address and names its domain one way", () => {
    expect(reporterLinkRecipient("a.n.n.a@gmail.com")).toBe("anna@gmail.com");
    expect(reporterLinkRecipient("A.nna+1@googlemail.com")).toBe(
      "anna@gmail.com",
    );
  });

  it("keeps the dots of an address elsewhere, where they may name another inbox", () => {
    expect(reporterLinkRecipient("a.nna@exempel.se")).toBe("a.nna@exempel.se");
    expect(reporterLinkRecipient("a.nna@gmail.com.example")).toBe(
      "a.nna@gmail.com.example",
    );
  });

  it("reads a trailing dot of the domain as the same domain", () => {
    expect(reporterLinkRecipient("anna@exempel.se.")).toBe("anna@exempel.se");
    expect(reporterLinkRecipient("a.nna@gmail.com.")).toBe("anna@gmail.com");
  });

  it("gives every address whose local part is all tag one recipient per domain", () => {
    expect(reporterLinkRecipient("+1@exempel.se")).toBe("@exempel.se");
    expect(reporterLinkRecipient("+2@exempel.se")).toBe("@exempel.se");
  });

  it("splits at the last at sign", () => {
    expect(reporterLinkRecipient('"a@b"+1@exempel.se')).toBe(
      '"a@b"@exempel.se',
    );
  });
});
