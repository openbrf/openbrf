// What the deploy steps give a role's PASSWORD clause in place of the
// password: its SCRAM-SHA-256 verifier, computed here the way PostgreSQL
// computes it, as psql's \password does.
//
// PostgreSQL stores a verifier it is given as it is, whatever
// password_encryption says, and a client then signs in with the password as
// before. The password itself never reaches the server. A statement that
// carries it would: in pg_stat_activity while it runs, in the server's log
// when it fails - log_min_error_statement is error by default, and a lock
// timeout or a concurrent change to the role is enough - and in the log on
// every run on a server that sets log_statement to ddl or all. That log is the
// db container's, which anyone with Docker or the platform's log view reads.
// The verifier in its place lets nobody sign in, and guessing a generated
// password from it is out of reach.
//
// The verifier is of the password after SASLprep (RFC 4013), which PostgreSQL
// applies before it hashes one and libpq before it signs in. For a password
// SASLprep leaves as it is - every generated one, and any one in ASCII - that
// is the password's own bytes. For one it would change, a full width letter
// or a ligature or a non-breaking space, this hands the password on unchanged
// for the server to hash, as before: SASLprep's tables are not in Node, and a
// verifier of the wrong bytes would set a password nobody could sign in with.
//
// Node built-ins only, like the rest of docker/, so this stays readable and
// runnable inside the image an operator is debugging.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/** PostgreSQL's defaults: scram_iterations, and the salt's length in bytes. */
const ITERATIONS = 4096;
const SALT_LENGTH = 16;

/**
 * The characters SASLprep maps: non-ASCII spaces to a space (RFC 3454, table
 * C.1.2) and those it removes (table B.1).
 */
const SASLPREP_MAPPED = new RegExp(
  "[\\u00A0\\u00AD\\u034F\\u1680\\u1806\\u180B-\\u180D\\u2000-\\u200D" +
    "\\u202F\\u205F\\u2060\\u3000\\uFE00-\\uFE0F\\uFEFF]",
  "u",
);

/**
 * Whether SASLprep leaves the password as it is. It maps the characters above
 * and normalises to NFKC; what fails its later checks PostgreSQL hashes
 * unprepared, which is the password as it is again. Normalisation is stable
 * across Unicode versions, so a password Node's tables leave alone the
 * server's leave alone too.
 */
function saslprepLeavesAlone(password) {
  return (
    !SASLPREP_MAPPED.test(password) && password.normalize("NFKC") === password
  );
}

function hmac(key, text) {
  return createHmac("sha256", key).update(text).digest();
}

/**
 * The SCRAM-SHA-256 verifier of `password`, in the form PostgreSQL keeps in
 * pg_authid (RFC 5802 and RFC 7677), or the password itself when SASLprep
 * would change it (see the top of this file). `salt` is for the tests; a
 * deploy takes a new one each time, as the server does.
 */
export function rolePassword(password, salt = randomBytes(SALT_LENGTH)) {
  if (!saslprepLeavesAlone(password)) {
    return password;
  }
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const storedKey = createHash("sha256")
    .update(hmac(salted, "Client Key"))
    .digest();
  const serverKey = hmac(salted, "Server Key");
  return (
    `SCRAM-SHA-256$${ITERATIONS}:${salt.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}
