import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A certificate no client trusts, for a TLS server on loopback in a test.
 *
 * Signed by its own key and issued to `relay.test`, so a client that checks
 * the chain refuses it as self-signed (`DEPTH_ZERO_SELF_SIGNED_CERT`) before
 * it sends anything. Made with `node:crypto` when a suite starts rather than
 * kept in the repository, so no private key is committed and none expires.
 */
export interface SelfSignedCertificate {
  /** The PKCS #8 private key, PEM. */
  key: string;
  /** The X.509 certificate, PEM. */
  cert: string;
}

/** A DER element: the tag, the length and the content. */
function der(tag: number, content: Buffer): Buffer {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) {
    header = Buffer.from([tag, length]);
  } else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) {
      bytes.unshift(rest & 0xff);
    }
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, content]);
}

const sequence = (...items: Buffer[]): Buffer =>
  der(0x30, Buffer.concat(items));

/** ecdsa-with-SHA256 (1.2.840.10045.4.3.2). */
const ECDSA_WITH_SHA256 = sequence(
  Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
);

/** A name of one common name (2.5.4.3). */
function commonName(value: string): Buffer {
  const attribute = sequence(
    Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
    der(0x0c, Buffer.from(value, "utf8")),
  );
  return sequence(der(0x31, attribute));
}

/** A UTCTime, `YYMMDDHHMMSSZ`, which covers the years 1950 to 2049. */
function utcTime(at: Date): Buffer {
  const text = at.toISOString().replace(/[-:T]/g, "").slice(2, 14).concat("Z");
  return der(0x17, Buffer.from(text, "ascii"));
}

function pem(label: string, body: Buffer): string {
  const lines = body.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function selfSignedCertificate(
  name = "relay.test",
): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const now = Date.now();
  // A positive serial: the first byte's top bit is clear.
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = sequence(
    // Version 3.
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, serial),
    ECDSA_WITH_SHA256,
    commonName(name),
    sequence(
      utcTime(new Date(now - 60 * 60 * 1000)),
      utcTime(new Date(now + 24 * 60 * 60 * 1000)),
    ),
    commonName(name),
    publicKey.export({ type: "spki", format: "der" }),
  );
  // An EC key signs in the DER form X.509 carries.
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(
    tbs,
    ECDSA_WITH_SHA256,
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", certificate),
  };
}
