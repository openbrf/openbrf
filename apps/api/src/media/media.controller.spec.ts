import { describe, expect, it } from "vitest";

import { contentDisposition } from "./media.controller";

/**
 * The file name on the way out.
 *
 * A header value is ASCII, and this product's file names are not: a board
 * uploads "gård.png" and "föreningsstämma.jpg" without thinking about it. The
 * cases below are about that being the normal case rather than an exception.
 */
describe("the content disposition of a served file", () => {
  it("shows the file rather than offering it as a download", () => {
    // These are images in a page, not attachments.
    expect(contentDisposition("logotyp.png")).toMatch(/^inline;/);
  });

  it("carries a Swedish name in the extended parameter", () => {
    const value = contentDisposition("gård.png");

    // Percent-encoded UTF-8, which is what RFC 5987 defines and what a
    // quoted ASCII parameter cannot express.
    expect(value).toContain("filename*=UTF-8''g%C3%A5rd.png");
  });

  it("never emits a non-ASCII byte in the plain parameter", () => {
    const value = contentDisposition("föreningsstämma.jpg");

    // The whole header, not just the fallback: a byte above 0x7e anywhere in
    // the value is what reaches the client as mojibake.
    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(value).toContain('filename="f_reningsst_mma.jpg"');
  });

  it("encodes the characters the extended parameter reserves", () => {
    /*
     * encodeURIComponent leaves these alone and they are not attr-char. The
     * apostrophe matters most: it is the delimiter inside filename* itself, so
     * an unescaped one would end the character set and language fields early.
     */
    const value = contentDisposition("kvarterets (gård)'s fest.png");

    expect(value).toContain("%27");
    expect(value).toContain("%28");
    expect(value).toContain("%29");
  });

  it("leaves an ordinary name untouched in both parameters", () => {
    const value = contentDisposition("logotyp-2026.png");

    expect(value).toBe(
      `inline; filename="logotyp-2026.png"; filename*=UTF-8''logotyp-2026.png`,
    );
  });
});
