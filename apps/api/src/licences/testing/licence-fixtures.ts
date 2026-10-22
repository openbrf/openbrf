import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
  verify,
} from "node:crypto";

import {
  LICENCE_FILE_MAX_BYTES,
  LICENCE_FORMAT,
  LICENCE_PRESENTATION_FORMAT,
  LICENCE_PRESENTATION_MAX_BYTES,
} from "@openbrf/plugin-sdk";

import {
  decodeBase64Url,
  ed25519PublicKey,
  type LicencePayload,
  PRESENTATION_SIGNED_PREFIX,
  readJsonBytes,
  verifiedPayload,
} from "../licence-file";

/**
 * A throwaway issuer and a reference verifier for the licence tests
 * (ADR 0042).
 *
 * The issuer signs with a key generated in the test, as a plugin's own tests
 * do; no test here holds a key anybody issues with. The verifier checks a
 * presentation as the ADR says an issuer's service does, minus the ledger and
 * the nonce store, which are the service's own: it is what proves a
 * presentation this host writes can be accepted, and that one it should not
 * write cannot.
 */

export interface TestKey {
  privateKey: KeyObject;
  /** The 32 raw bytes. */
  raw: Buffer;
  /** As a manifest declares it: base64, padded. */
  manifest: string;
  /** As a licence names an instance key: base64url, unpadded. */
  base64url: string;
}

export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x ?? "";
  const raw = Buffer.from(x, "base64url");
  return {
    privateKey,
    raw,
    manifest: raw.toString("base64"),
    base64url: x,
  };
}

export function testPayload(
  overrides: Partial<LicencePayload> = {},
): LicencePayload {
  return {
    licenceId: randomUUID(),
    issuedOn: "2026-01-05",
    instanceId: randomUUID(),
    instanceKey: testKey().base64url,
    association: { name: "Brf Talgoxen 4", organizationNumber: "769600-0000" },
    entitlements: { "mcp-connector": { validUntil: "2027-11-30" } },
    ...overrides,
  };
}

/**
 * A licence file. The payload may be given as text or bytes to write what a
 * JSON serialiser would not, and the envelope's fields may be replaced or padded.
 */
export function issueLicence(input: {
  key: TestKey;
  keyId?: string;
  payload: LicencePayload | string | Buffer;
  envelope?: Record<string, unknown>;
  /** Pads the file with spaces to this many bytes. */
  padTo?: number;
}): Buffer {
  const payloadBytes = Buffer.isBuffer(input.payload)
    ? input.payload
    : Buffer.from(
        typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload),
        "utf8",
      );
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(`${LICENCE_FORMAT}\n`), payloadBytes]),
    input.key.privateKey,
  );
  const text = JSON.stringify({
    format: LICENCE_FORMAT,
    keyId: input.keyId ?? "test-1",
    payload: payloadBytes.toString("base64url"),
    signature: signature.toString("base64url"),
    ...input.envelope,
  });
  const padding =
    input.padTo === undefined ? 0 : input.padTo - Buffer.byteLength(text);
  return Buffer.from(text + " ".repeat(Math.max(0, padding)), "utf8");
}

/** A manifest's `licence` and `released` for a test plugin. */
export function testLicenceManifest(input: {
  entitlement?: string;
  keys: Record<string, TestKey>;
  audiences?: string[];
  released?: string;
}) {
  return {
    licence: {
      entitlement: input.entitlement ?? "mcp-connector",
      issuer: { name: "Test Issuer AB", url: "https://issuer.example/licence" },
      keys: Object.fromEntries(
        Object.entries(input.keys).map(([keyId, key]) => [keyId, key.manifest]),
      ),
      audiences: input.audiences ?? [],
    },
    released: input.released ?? "2026-12-01",
  };
}

export type PresentationVerdict =
  | { ok: true; payload: LicencePayload; claims: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Checks a presentation as an issuer's service would: the size before
 * parsing, the licence under the issuer's key, the claims' licence id against
 * the licence's, the signature under the instance key the licence names, the
 * audience and the entitlement, and `issuedAt` within five minutes.
 */
export function verifyPresentation(
  text: string,
  expected: {
    issuerKey: TestKey;
    audience: string;
    entitlement: string;
    now: Date;
  },
): PresentationVerdict {
  if (Buffer.byteLength(text, "utf8") > LICENCE_PRESENTATION_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const outer = readJsonBytes(Buffer.from(text, "utf8")) as Record<
    string,
    unknown
  > | null;
  if (
    outer === null ||
    outer.format !== LICENCE_PRESENTATION_FORMAT ||
    Object.keys(outer).length !== 4 ||
    typeof outer.licence !== "string" ||
    typeof outer.claims !== "string" ||
    typeof outer.signature !== "string"
  ) {
    return { ok: false, reason: "not-a-presentation" };
  }
  const file = decodeBase64Url(outer.licence);
  const claimBytes = decodeBase64Url(outer.claims);
  const signature = decodeBase64Url(outer.signature);
  if (
    file === null ||
    claimBytes === null ||
    signature?.length !== 64 ||
    file.length > LICENCE_FILE_MAX_BYTES
  ) {
    return { ok: false, reason: "not-a-presentation" };
  }
  const payload = verifiedPayload(
    file,
    ed25519PublicKey(expected.issuerKey.raw),
  );
  if (payload === null) {
    return { ok: false, reason: "licence-invalid" };
  }
  const claims = readJsonBytes(claimBytes) as Record<string, unknown> | null;
  if (claims === null || claims.licenceId !== payload.licenceId) {
    return { ok: false, reason: "claims-licence-mismatch" };
  }
  const instanceKey = decodeBase64Url(payload.instanceKey);
  if (
    instanceKey === null ||
    !verify(
      null,
      Buffer.concat([PRESENTATION_SIGNED_PREFIX, claimBytes]),
      ed25519PublicKey(instanceKey),
      signature,
    )
  ) {
    return { ok: false, reason: "instance-signature-invalid" };
  }
  if (claims.audience !== expected.audience) {
    return { ok: false, reason: "wrong-audience" };
  }
  if (
    claims.entitlement !== expected.entitlement ||
    payload.entitlements[expected.entitlement] === undefined
  ) {
    return { ok: false, reason: "wrong-entitlement" };
  }
  const issuedAt = Date.parse(String(claims.issuedAt));
  if (
    Number.isNaN(issuedAt) ||
    Math.abs(issuedAt - expected.now.getTime()) > 5 * 60_000
  ) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, payload, claims };
}

/** A key's fingerprint, as the store records it. */
export function fingerprintOf(key: TestKey): string {
  return createHash("sha256").update(key.raw).digest("hex");
}
