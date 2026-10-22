import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  verify,
} from "node:crypto";

import {
  isCalendarDay,
  LICENCE_FILE_MAX_BYTES,
  LICENCE_FORMAT,
  LICENCE_PRESENTATION_FORMAT,
  licenceKeyIdSchema,
  pluginIdSchema,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

import { parseStrictJson } from "./strict-json";

/**
 * The two formats of ADR 0042, read and written one way.
 *
 * Only the issuer writes a licence, but the instance and the issuer's services
 * verify it with different code, and the two must never read one signed file
 * two ways. So everything is refused that another reader could take
 * differently: a value that is not canonical base64url, bytes that are not
 * UTF-8, an object that repeats a key, a field the format does not define, a
 * date that is not a real day. The payload is not parsed until its signature
 * has verified, and the signed prefix is this module's constant, never text
 * taken from the file.
 */

const LICENCE_SIGNED_PREFIX = Buffer.from(`${LICENCE_FORMAT}\n`, "utf8");
export const PRESENTATION_SIGNED_PREFIX = Buffer.from(
  `${LICENCE_PRESENTATION_FORMAT}\n`,
  "utf8",
);

/** Why a file is not a licence this instance can read. */
export type LicenceFileRefusal =
  "too-large" | "unsupported-format" | "not-a-licence";

export interface LicenceEnvelope {
  keyId: string;
  /** The payload's bytes, base64url-decoded: what the signature covers. */
  payload: Buffer;
  signature: Buffer;
}

export interface LicencePayload {
  licenceId: string;
  issuedOn: string;
  instanceId: string;
  instanceKey: string;
  association: { name: string; organizationNumber?: string };
  entitlements: Record<
    string,
    { validUntil?: string | undefined; updatesUntil?: string | undefined }
  >;
}

/**
 * The decoded value when `text` is canonical base64url without padding, the
 * one spelling of its bytes, and null otherwise. Node's decoder skips
 * characters it does not know, so the re-encoding is what refuses them.
 */
export function decodeBase64Url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/** UTF-8 that refuses invalid bytes, and keeps a byte-order mark as text. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/** Strict JSON from bytes, or null. */
export function readJsonBytes(bytes: Uint8Array): unknown {
  const text = decodeUtf8(bytes);
  if (text === null) {
    return null;
  }
  try {
    return parseStrictJson(text);
  } catch {
    return null;
  }
}

const base64UrlSchema = z.string().max(LICENCE_FILE_MAX_BYTES * 2);

const envelopeSchema = z.strictObject({
  format: z.literal(LICENCE_FORMAT),
  keyId: licenceKeyIdSchema,
  payload: base64UrlSchema.min(1),
  signature: base64UrlSchema,
});

/**
 * Reads a licence file's envelope, without verifying anything.
 *
 * `format` is compared before anything else, so a later version is told
 * apart from a file that is not a licence at all.
 */
export function readLicenceEnvelope(file: Uint8Array):
  | { ok: true; envelope: LicenceEnvelope }
  | {
      ok: false;
      reason: LicenceFileRefusal;
    } {
  if (file.byteLength > LICENCE_FILE_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const json = readJsonBytes(file);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, reason: "not-a-licence" };
  }
  const format = (json as { format?: unknown }).format;
  if (typeof format === "string" && format !== LICENCE_FORMAT) {
    return {
      ok: false,
      reason: format.startsWith("openbrf-licence/")
        ? "unsupported-format"
        : "not-a-licence",
    };
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: "not-a-licence" };
  }
  const payload = decodeBase64Url(parsed.data.payload);
  const signature = decodeBase64Url(parsed.data.signature);
  if (payload === null || signature?.length !== 64) {
    return { ok: false, reason: "not-a-licence" };
  }
  return {
    ok: true,
    envelope: { keyId: parsed.data.keyId, payload, signature },
  };
}

/** An Ed25519 public key from its 32 raw bytes. */
export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(raw).toString("base64url"),
    },
    format: "jwk",
  });
}

/** A key's fingerprint: the SHA-256 of its 32 raw bytes, hex. */
export function keyFingerprint(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** The SHA-256 of a file, hex. */
export function fileSha256(file: Uint8Array): string {
  return createHash("sha256").update(file).digest("hex");
}

/** Whether `key` signed this envelope's payload as a licence. */
export function verifyLicenceSignature(
  envelope: LicenceEnvelope,
  key: KeyObject,
): boolean {
  return verify(
    null,
    Buffer.concat([LICENCE_SIGNED_PREFIX, envelope.payload]),
    key,
    envelope.signature,
  );
}

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "must be a lowercase UUID",
  );

const daySchema = z.string().refine(isCalendarDay, "must be YYYY-MM-DD");

/** base64url of 32 bytes, unpadded, in its one spelling. */
const rawKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "must be a 32-byte key");

const payloadSchema = z.strictObject({
  licenceId: uuidSchema,
  issuedOn: daySchema,
  instanceId: uuidSchema,
  instanceKey: rawKeySchema,
  association: z.strictObject({
    name: z.string().min(1).max(200),
    organizationNumber: z.string().min(1).max(32).optional(),
  }),
  entitlements: z
    .record(
      pluginIdSchema,
      z.strictObject({
        validUntil: daySchema.optional(),
        updatesUntil: daySchema.optional(),
      }),
    )
    .refine((entitlements) => {
      const count = Object.keys(entitlements).length;
      return count >= 1 && count <= 64;
    }, "must carry one to 64 entitlements"),
});

/**
 * Reads a payload whose signature has verified. Null when it is not a payload
 * of this format version, which refuses a field it does not know.
 */
export function readLicencePayload(payload: Buffer): LicencePayload | null {
  const parsed = payloadSchema.safeParse(readJsonBytes(payload));
  return parsed.success ? parsed.data : null;
}

/**
 * Reads a licence file and verifies it with one key: the payload, or null for
 * a file that does not verify under it or does not read.
 */
export function verifiedPayload(
  file: Uint8Array,
  key: KeyObject,
): LicencePayload | null {
  const read = readLicenceEnvelope(file);
  if (!read.ok || !verifyLicenceSignature(read.envelope, key)) {
    return null;
  }
  return readLicencePayload(read.envelope.payload);
}

export interface PresentationClaims {
  audience: string;
  licenceId: string;
  entitlement: string;
  /** An instant in UTC to the second, `2026-12-03T09:14:05Z`. */
  issuedAt: string;
  nonce: string;
}

/**
 * A presentation of a licence file, signed by the instance key.
 *
 * Compact JSON throughout, the claims in the order the ADR lists them. The
 * licence travels as base64url of the bytes that were entered, so its size in
 * the presentation does not depend on how the file was written. The signature
 * is asked of `sign`, so the private key stays with whoever holds it.
 */
export async function writePresentation(
  input: {
    file: Uint8Array;
    audience: string;
    licenceId: string;
    entitlement: string;
    now: Date;
  },
  sign: (message: Buffer) => Promise<Buffer>,
): Promise<string> {
  const claims: PresentationClaims = {
    audience: input.audience,
    licenceId: input.licenceId,
    entitlement: input.entitlement,
    issuedAt: `${input.now.toISOString().slice(0, 19)}Z`,
    nonce: randomBytes(16).toString("base64url"),
  };
  const claimBytes = Buffer.from(JSON.stringify(claims), "utf8");
  const signature = await sign(
    Buffer.concat([PRESENTATION_SIGNED_PREFIX, claimBytes]),
  );
  return JSON.stringify({
    format: LICENCE_PRESENTATION_FORMAT,
    licence: Buffer.from(input.file).toString("base64url"),
    claims: claimBytes.toString("base64url"),
    signature: signature.toString("base64url"),
  });
}

/** An Ed25519 private key from its 32-byte seed and public key, base64url. */
export function ed25519PrivateKey(seed: string, publicKey: string): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKey, d: seed },
    format: "jwk",
  });
}
