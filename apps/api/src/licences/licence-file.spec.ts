import { LICENCE_FILE_MAX_BYTES } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeBase64Url,
  ed25519PublicKey,
  readLicenceEnvelope,
  verifiedPayload,
} from "./licence-file";
import { issueLicence, testKey, testPayload } from "./testing/licence-fixtures";

/**
 * One reading of every byte (ADR 0042): each file below is one that another
 * verifier could read differently, and each is refused.
 */

const issuer = testKey();
const publicKey = ed25519PublicKey(issuer.raw);

function payloadText(
  overrides: Record<string, unknown> = {},
  extra = "",
): string {
  const json = JSON.stringify({ ...testPayload(), ...overrides });
  return extra === "" ? json : `${json.slice(0, -1)},${extra}}`;
}

describe("readLicenceEnvelope", () => {
  it("reads a licence and verifies it under its issuer's key", () => {
    const payload = testPayload();
    const file = issueLicence({ key: issuer, payload });

    const read = readLicenceEnvelope(file);
    expect(read.ok).toBe(true);
    expect(verifiedPayload(file, publicKey)).toEqual(payload);
  });

  it("does not verify under another key", () => {
    const file = issueLicence({ key: issuer, payload: testPayload() });
    expect(verifiedPayload(file, ed25519PublicKey(testKey().raw))).toBeNull();
  });

  it("accepts a file of exactly 16 KiB and refuses one byte more", () => {
    const payload = testPayload();
    const largest = issueLicence({
      key: issuer,
      payload,
      padTo: LICENCE_FILE_MAX_BYTES,
    });
    expect(largest.length).toBe(LICENCE_FILE_MAX_BYTES);
    expect(verifiedPayload(largest, publicKey)).toEqual(payload);

    const larger = issueLicence({
      key: issuer,
      payload,
      padTo: LICENCE_FILE_MAX_BYTES + 1,
    });
    expect(readLicenceEnvelope(larger)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("tells a later format version apart from a file that is not a licence", () => {
    const later = issueLicence({
      key: issuer,
      payload: testPayload(),
      envelope: { format: "openbrf-licence/2" },
    });
    expect(readLicenceEnvelope(later)).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
    expect(readLicenceEnvelope(Buffer.from('{"hello":"world"}'))).toEqual({
      ok: false,
      reason: "not-a-licence",
    });
  });

  it.each([
    ["padding on the payload", (value: string) => `${value}=`],
    ["a character base64url does not have", (value: string) => `${value}+`],
    [
      "a space inside",
      (value: string) => `${value.slice(0, 4)} ${value.slice(4)}`,
    ],
  ])("refuses a payload with %s", (_, spoil) => {
    const file = issueLicence({ key: issuer, payload: testPayload() });
    const envelope = JSON.parse(file.toString()) as { payload: string };
    const spoiled = issueLicence({
      key: issuer,
      payload: testPayload(),
      envelope: { payload: spoil(envelope.payload) },
    });
    expect(readLicenceEnvelope(spoiled)).toEqual({
      ok: false,
      reason: "not-a-licence",
    });
  });

  it("refuses a signature that is not 64 bytes", () => {
    const file = issueLicence({
      key: issuer,
      payload: testPayload(),
      envelope: { signature: Buffer.alloc(63).toString("base64url") },
    });
    expect(readLicenceEnvelope(file)).toEqual({
      ok: false,
      reason: "not-a-licence",
    });
  });

  it("refuses a signature in a second spelling of its bytes", () => {
    // 64 bytes take 86 characters, and the last carries four bits no byte has.
    const file = issueLicence({ key: issuer, payload: testPayload() });
    const { signature } = JSON.parse(file.toString()) as { signature: string };
    const last = signature.at(-1) ?? "A";
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = alphabet.charAt(alphabet.indexOf(last) + 1);
    const spoiled = issueLicence({
      key: issuer,
      payload: testPayload(),
      envelope: { signature: signature.slice(0, -1) + twin },
    });
    expect(decodeBase64Url(signature.slice(0, -1) + twin)).toBeNull();
    expect(readLicenceEnvelope(spoiled).ok).toBe(false);
  });

  it("refuses an envelope that repeats a key", () => {
    const file = issueLicence({ key: issuer, payload: testPayload() });
    const text = file.toString();
    const repeated = Buffer.from(
      `${text.slice(0, -1)},"keyId":"other-1"}`,
      "utf8",
    );
    expect(readLicenceEnvelope(repeated)).toEqual({
      ok: false,
      reason: "not-a-licence",
    });
  });

  it("refuses an envelope field it does not know", () => {
    const file = issueLicence({
      key: issuer,
      payload: testPayload(),
      envelope: { issuer: "Apteo AB" },
    });
    expect(readLicenceEnvelope(file).ok).toBe(false);
  });

  it.each([
    ["an uppercase key id", "Test-1"],
    ["an empty key id", ""],
    ["a key id of 65 characters", "a".repeat(65)],
  ])("refuses %s", (_, keyId) => {
    const file = issueLicence({ key: issuer, payload: testPayload(), keyId });
    expect(readLicenceEnvelope(file).ok).toBe(false);
  });

  it("refuses bytes that are not UTF-8, and a byte-order mark", () => {
    const file = issueLicence({ key: issuer, payload: testPayload() });
    expect(
      readLicenceEnvelope(Buffer.concat([Buffer.from([0xff]), file])).ok,
    ).toBe(false);
    expect(
      readLicenceEnvelope(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), file]),
      ).ok,
    ).toBe(false);
  });
});

describe("a signed payload this format refuses", () => {
  it.each([
    [
      "that repeats a key",
      payloadText({}, '"instanceId":"4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f"'),
    ],
    ["with a field version 1 does not know", payloadText({}, '"usageCap":100')],
    [
      "with an uppercase UUID",
      payloadText({ licenceId: "9B0C7C5E-2F4E-4D8A-9A51-3A3F0A5F1C2D" }),
    ],
    ["with an impossible date", payloadText({ issuedOn: "2027-02-30" })],
    [
      "with an impossible end date",
      payloadText({
        entitlements: { "mcp-connector": { validUntil: "2027-02-29" } },
      }),
    ],
    [
      "with an entitlement name starting with a digit",
      payloadText({ entitlements: { "1connector": {} } }),
    ],
    [
      "with an entitlement name in upper case",
      payloadText({ entitlements: { Connector: {} } }),
    ],
    ["with no entitlements", payloadText({ entitlements: {} })],
    [
      "with a field it does not know on an entitlement",
      payloadText({ entitlements: { "mcp-connector": { seats: 3 } } }),
    ],
    [
      "with an instance key that is not 32 bytes",
      payloadText({ instanceKey: "AAAA" }),
    ],
    [
      "with no association",
      JSON.stringify({ ...testPayload(), association: undefined }),
    ],
  ])("refuses a payload %s, though the signature verifies", (_, payload) => {
    const file = issueLicence({ key: issuer, payload });
    expect(readLicenceEnvelope(file).ok).toBe(true);
    expect(verifiedPayload(file, publicKey)).toBeNull();
  });

  it("refuses payload bytes that are not UTF-8", () => {
    const file = issueLicence({
      key: issuer,
      payload: Buffer.from([0x7b, 0xff, 0x7d]),
    });
    expect(verifiedPayload(file, publicKey)).toBeNull();
  });
});
