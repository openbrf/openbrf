/**
 * The verifier docker/scram.mjs gives a role's PASSWORD clause in place of the
 * password: the one PostgreSQL itself makes of the same password and salt, so
 * that a client signs in with the password exactly as before, whatever SASLprep
 * makes of it (docker/saslprep.mjs). Run with `node --test` from
 * `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { saslprep } from "../docker/saslprep.mjs";
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
  {
    described: "one with a ligature, which SASLprep takes apart",
    password: "ﬁnance",
    verifier:
      "SCRAM-SHA-256$4096:mRn9ASP/WE381rsdFyAILA==$nv4n24tS+RkZWW4fVfsPIdt+KwU4WaMDgBPPDY34reE=:aQkcisOLw9pa5NfUHm38LlZODRVGPhXS3mo+UK8TjhQ=",
  },
  {
    described: "one with full width letters",
    password: "ＡＢＣ123",
    verifier:
      "SCRAM-SHA-256$4096:0Re9v+nHapKUuFwBzF+f9Q==$/2DJXoN1qWw/r8wQ53OTwqA2m/xdvVdtgMF7CXMehlA=:i7ynaxzZ6nNSwDm7tK2IFgLbi4xaXo+jBOnTwf2deYw=",
  },
  {
    described: "one with a non-breaking space, which SASLprep makes a space",
    password: "two\u00a0words",
    verifier:
      "SCRAM-SHA-256$4096:9cxVIztnCD4BVchuzx3Cbw==$dm6Vc96V6tol5MF74d7e18zBHTZeXmoR630VAyPjKVk=:WvGEs+4vi9KVHTB9Yd58UFFSQoEg9q4vRtzyL0QYJNM=",
  },
  {
    described: "one with a soft hyphen, which SASLprep removes",
    password: "soft\u00adhyphen",
    verifier:
      "SCRAM-SHA-256$4096:Qmf0cWPkjnFlyr55L5R/Aw==$oSJ9jRvCMj4Xn8f2jTuBGvNZ8TAee/HlbXMG9NKbeXM=:kXaUbkgh8LZeDec9yvn5la4jjgUEG53nuS8Gpz7pOAE=",
  },
  {
    described: "one with a combining accent, which SASLprep composes",
    password: "e\u0301",
    verifier:
      "SCRAM-SHA-256$4096:UehYzZ7EtDyufF3wqfBbiw==$UT9hMXuz0Kgfp2fEDBsogj/9mHAkEXxtcCdMDBHjzzI=:0H2s4Yh5uwBmoEB4OXueNPwPIVt/Ir3fNTbFuRqw29M=",
  },
  {
    described: "one written right to left, with a ligature",
    password: "\u0645\ufefc",
    verifier:
      "SCRAM-SHA-256$4096:ch9P/NhnKWjhTNR7U/LhmQ==$mQr7bHoZva87FCbyrIq0mk5Zn1SoaItIjucf1IL5QYQ=:J0zBHUp9gA2wwI84UbJ1IjHWmEQZMiqltmFCEbdfUzY=",
  },
  {
    described:
      "one with a ligature and a control character, which SASLprep prohibits",
    password: "ﬁnance\u0007",
    verifier:
      "SCRAM-SHA-256$4096:r/hmCJINavhhG2i7jJ4yHQ==$GTcrR5S5kKkYQYkSppgzxb8wQtd/yTYIuHazxFw7qBs=:/NQot1HYLoRQrS1RHWdOLXf8mKBT4TbJchEVfCq41ls=",
  },
  {
    described:
      "one with a ligature and an emoji, which Unicode 3.2 did not have",
    password: "ﬁnance\u{1f600}",
    verifier:
      "SCRAM-SHA-256$4096:Iuk/EJ2rXnb8IHXCBJXo4A==$O5AwNyGsilardOSt601N8wQMcTPbl5hhplFwTXK+I9g=:556mAcp5uUncr6V5efcw9BU06Y6jRWZL8AAyXgo16kk=",
  },
  {
    described: "one that mixes right to left and left to right",
    password: "\u05d0ﬁ",
    verifier:
      "SCRAM-SHA-256$4096:xONrFlyXRJf8sdKzcS7Y/g==$6X9fnoPgbt/KCpaMkODELCNFYIP1oKGYGF4XBj9OqEQ=:ixDsOPp42/Cy9KphyWAE2lGy/Dz2zoJdkaDfksSiPN0=",
  },
  {
    described: "one that SASLprep maps to nothing at all",
    password: "\u00ad\u200d",
    verifier:
      "SCRAM-SHA-256$4096:2wJHSb/KvUewIcLcDxvN6g==$b4MnPKDaQdObTs0m2FJMPNUZTe3aIOoQ17Tlyl5QdEc=:AmQ+y2rami9a+uiwPw9r+5kNO78IYQrMYIAppJ4nv2Y=",
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

test("every password is set as a verifier, whatever SASLprep makes of it", () => {
  for (const { password } of POSTGRES_VERIFIERS) {
    const verifier = rolePassword(password);
    assert.match(verifier, /^SCRAM-SHA-256\$4096:/, JSON.stringify(password));
    assert.equal(verifier.includes(password), false, JSON.stringify(password));
  }
});

test("SASLprep prepares a password as PostgreSQL does, and leaves alone what it prohibits", () => {
  for (const [password, prepared] of [
    ["ﬁnance", "finance"],
    ["ＡＢＣ123", "ABC123"],
    ["two\u00a0words", "two words"],
    ["soft\u00adhyphen", "softhyphen"],
    ["e\u0301", "\u00e9"],
    ["\u0645\ufefc", "\u0645\u0644\u0627"],
    // ASCII is left alone, control characters included.
    ["tab\there", "tab\there"],
    // Checked before it is normalised, not after, as PostgreSQL does.
    ["ﬁnance\u0007", "ﬁnance\u0007"],
    ["ﬁnance\u{1f600}", "ﬁnance\u{1f600}"],
    ["\u05d0ﬁ", "\u05d0ﬁ"],
    ["\u00ad\u200d", "\u00ad\u200d"],
  ]) {
    assert.equal(saslprep(password), prepared, JSON.stringify(password));
  }
});
