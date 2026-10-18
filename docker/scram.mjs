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
// applies before it hashes one and libpq before it signs in, and of the
// password as it is where SASLprep fails, as PostgreSQL does then too
// (docker/saslprep.mjs). So every password is set as a verifier, one with a
// ligature, a full width letter or a non-breaking space as much as a generated
// one, and signs in as it would have.
//
// Node built-ins only, like the rest of docker/, so this stays readable and
// runnable inside the image an operator is debugging.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

import { saslprep } from "./saslprep.mjs";

/** PostgreSQL's defaults: scram_iterations, and the salt's length in bytes. */
const ITERATIONS = 4096;
const SALT_LENGTH = 16;

function hmac(key, text) {
  return createHmac("sha256", key).update(text).digest();
}

/**
 * The SCRAM-SHA-256 verifier of `password`, in the form PostgreSQL keeps in
 * pg_authid (RFC 5802 and RFC 7677). `salt` is for the tests; a deploy takes a
 * new one each time, as the server does.
 */
export function rolePassword(password, salt = randomBytes(SALT_LENGTH)) {
  const salted = pbkdf2Sync(saslprep(password), salt, ITERATIONS, 32, "sha256");
  const storedKey = createHash("sha256")
    .update(hmac(salted, "Client Key"))
    .digest();
  const serverKey = hmac(salted, "Server Key");
  return (
    `SCRAM-SHA-256$${ITERATIONS}:${salt.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}
