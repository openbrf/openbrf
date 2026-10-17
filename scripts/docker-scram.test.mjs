/**
 * The verifier docker/scram.mjs gives a role's PASSWORD clause in place of the
 * password: the one PostgreSQL itself makes of the same password and salt, so
 * that a client signs in with the password exactly as before, and the password
 * as it is wherever SASLprep would change it. Run with `node --test` from
 * `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { rolePassword } from "../docker/scram.mjs";

/**
 * What PostgreSQL 18 - the image docker-compose.prod.yml pins - stored in
 * pg_authid for `CREATE ROLE ... PASSWORD '<password>'` under its default
 * password_encryption and scram_iterations. Each salt is the server's own,
 * taken out of its verifier and handed back to rolePassword().
 */
const POSTGRES_VERIFIERS = [
  {
    described: "a generated password",
    password:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    verifier:
      "SCRAM-SHA-256$4096:GqqBJu+/4tw9ijavh98c+w==$gfd9Z1q9aOgsKn9Ux1IzQiq9Lw/O+KMA/omz3xdY2hY=:RSKtHWAyiUW5d5VqBjET9XHMPQtc0+wpsqcNbt5D/Fk=",
  },
  {
    described: "one with a URL's delimiters and a trailing space",
    password: "p:a/s@s?w#o%rd ",
    verifier:
      "SCRAM-SHA-256$4096:1hMxfKkU/qNuzb04fNF2CQ==$u8GvgwK+biATVt/I74rJMoXUz850eS72eVURH5kzV+Q=:6ee2bW67X7Mpj80wSH4efJA6f3fM6mQZ75T4jq/QL1A=",
  },
  {
    described: "one outside ASCII that SASLprep leaves alone",
    password: "lösenord-åäö",
    verifier:
      "SCRAM-SHA-256$4096:fLVcz9JTbvCqqVWizgI9Nw==$IwA4EXROtv5Lq1Wf5m01W3fy6CsARazfJt9KRL4MQLg=:vd2Zf+s2X1TssTpAa76YkfADlWl03MpFVnqHG1JJtK8=",
  },
  {
    described: "one with a control character, which SASLprep prohibits",
    password: "tab\there",
    verifier:
      "SCRAM-SHA-256$4096:WbVPcXMCzY0SScoqrkfNQQ==$gswQ5E1kPHMqxP/ZvfEOExhNmOehJB9UUvxs0ZN0XWo=:XLqWgJBFL4jec/9h2oBEy4IY56tSmCIQYJ50KESi4eU=",
  },
];

/** The salt in a verifier, as bytes. */
function saltOf(verifier) {
  return Buffer.from(verifier.split("$")[1].split(":")[1], "base64");
}

for (const { described, password, verifier } of POSTGRES_VERIFIERS) {
  test(`the verifier of ${described} is the one PostgreSQL makes`, () => {
    assert.equal(rolePassword(password, saltOf(verifier)), verifier);
  });
}

test("each verifier has a salt of its own and holds nothing of the password", () => {
  const password = "0123456789abcdef0123456789abcdef";
  const first = rolePassword(password);
  const second = rolePassword(password);
  assert.match(
    first,
    /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
  );
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
});

test("a password SASLprep would change is handed on as it is, for the server to prepare", () => {
  for (const password of [
    "ﬁnance", // a ligature, which NFKC takes apart
    "ＡＢＣ123", // full width letters
    "two\u00a0words", // a non-breaking space, mapped to a space
    "soft\u00adhyphen", // mapped to nothing
    "e\u0301", // a combining accent, which NFKC composes
  ]) {
    assert.equal(rolePassword(password), password, JSON.stringify(password));
  }
});
