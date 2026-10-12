import { describe, expect, it, vi } from "vitest";

import {
  addressFrom,
  decodeEncodedWords,
  htmlToText,
  MAX_TEXT_CHARACTERS,
  readMessage,
} from "./mime";

/**
 * The MIME reader, against the shapes a Swedish correspondent's mail client
 * actually produces.
 *
 * Every case here is one that fails silently rather than loudly. A charset that
 * is not decoded does not throw, it turns a letter about a balkong into
 * mojibake; an HTML alternative chosen over the plain-text one does not throw
 * either, it shows the board a rendering instead of the words; and a boundary
 * matched inside a line rather than at the start of one splits a letter wherever
 * the sender chose to put the string.
 */

/** Assembles a message with CRLF line endings, which is what arrives. */
function raw(...lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n"), "latin1");
}

describe("readMessage", () => {
  it("reads a plain message", () => {
    const message = readMessage(
      raw(
        "From: Astrid Lindqvist <Astrid@Example.TEST>",
        "Subject: Fraga om balkongen",
        "Message-ID: <abc-123@example.test>",
        "Date: Tue, 01 Sep 2026 09:15:00 +0200",
        "",
        "Hej styrelsen,",
        "",
        "Far man satta upp en markis?",
        "",
      ),
    );

    expect(message.subject).toBe("Fraga om balkongen");
    // Lowercased, because an address is matched against itself later and a
    // correspondent's client is not consistent about case.
    expect(message.fromAddress).toBe("astrid@example.test");
    expect(message.fromName).toBe("Astrid Lindqvist");
    expect(message.messageId).toBe("abc-123@example.test");
    expect(message.date?.toISOString()).toBe("2026-09-01T07:15:00.000Z");
    expect(message.text).toContain("Hej styrelsen,");
    expect(message.textFromHtml).toBe(false);
  });

  it("decodes an encoded subject line and joins its folded words", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Subject: =?UTF-8?Q?Fr=C3=A5ga_om?= =?UTF-8?Q?_balkongen?=",
        "",
        "Hej",
        "",
      ),
    );

    // The space between two encoded words is the fold, not a space the sender
    // typed, so the two halves join into one word boundary and no more.
    expect(message.subject).toBe("Fråga om balkongen");
  });

  it("unfolds a header split across lines", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Subject: En ganska lang rubrik som",
        "\tfortsatter pa nasta rad",
        "",
        "Hej",
        "",
      ),
    );

    expect(message.subject).toBe(
      "En ganska lang rubrik som fortsatter pa nasta rad",
    );
  });

  it("reads an encoded subject that decodes to a line break as one line", () => {
    // The subject of an answer is built from this one, and a line break in it
    // would start a header of the sender's choosing.
    const encoded = Buffer.from("Hej\r\nBcc: nagon@annan.example").toString(
      "base64",
    );
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        `Subject: =?UTF-8?B?${encoded}?=`,
        "",
        "Hej",
        "",
      ),
    );

    expect(message.subject).toBe("Hej Bcc: nagon@annan.example");
  });

  it("decodes quoted-printable in a non-UTF-8 character set", () => {
    // ISO-8859-1 is what an old client still sends, and it is exactly the case
    // where getting it wrong produces a letter the board can half read.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Subject: Test",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Det =E4r vatten p=E5 golvet i tv=E4ttstugan.",
        "",
      ),
    );

    expect(message.text).toContain("Det är vatten på golvet i tvättstugan.");
  });

  it("joins a quoted-printable soft line break", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Det ar en mycket lang mening som klienten har brutit =",
        "mitt i.",
        "",
      ),
    );

    expect(message.text).toContain(
      "Det ar en mycket lang mening som klienten har brutit mitt i.",
    );
  });

  it("prefers the plain-text alternative over the HTML one", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Vad sagt av avsandaren",
        "--SEP",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>En rendering av det</p>",
        "--SEP--",
        "",
      ),
    );

    // What the sender typed, rather than a rendering of it.
    expect(message.text).toContain("Vad sagt av avsandaren");
    expect(message.text).not.toContain("En rendering av det");
    expect(message.textFromHtml).toBe(false);
    expect(message.textHtml).toBeNull();
    // And the alternative is not turned into an attachment: it is the same
    // message written twice, not a file.
    expect(message.attachments).toHaveLength(0);
  });

  it("reads an HTML-only message as text and keeps no markup", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><head><style>p{color:red}</style></head><body>",
        "<script>alert(1)</script>",
        "<p>Forsta stycket</p><p>Andra stycket</p>",
        "</body></html>",
        "",
      ),
    );

    expect(message.textFromHtml).toBe(true);
    expect(message.text).toContain("Forsta stycket");
    // The markup is kept beside the text, whole, for a caller that has to know
    // what a client shows rather than what the words are.
    expect(message.textHtml).toContain("<style>p{color:red}</style>");
    expect(message.text).toContain("Andra stycket");
    // Nothing markup-shaped survives, so nothing downstream can render it.
    expect(message.text).not.toContain("<");
    expect(message.text).not.toContain(">");
    // The script's contents are dropped whole rather than flattened into the
    // words: they are not something the sender wrote to the board.
    expect(message.text).not.toContain("alert");
    // And the two paragraphs are still two.
    expect(message.text.split("\n").filter((line) => line !== "")).toEqual([
      "Forsta stycket",
      "Andra stycket",
    ]);
  });

  it("keeps a base64 attachment and the name the sender gave it", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Se bifogad bild.",
        "--SEP",
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="tak.png"',
        "",
        Buffer.from("not really a png").toString("base64"),
        "--SEP--",
        "",
      ),
    );

    expect(message.text).toContain("Se bifogad bild.");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.fileName).toBe("tak.png");
    expect(message.attachments[0]?.bytes.toString("utf8")).toBe(
      "not really a png",
    );
  });

  it("decodes an RFC 2231 filename and refuses to let it be a path", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment;",
        "\tfilename*=utf-8''%2E%2E%2F%2E%2E%2Fprotokoll%20%C3%A5rsm%C3%B6te.pdf",
        "",
        Buffer.from("pdf bytes").toString("base64"),
        "--SEP--",
        "",
      ),
    );

    // The name is decoded so the board reads what the sender called it, and it
    // is reduced to its last segment so it cannot read as a path anywhere it is
    // shown or offered as a download.
    expect(message.attachments[0]?.fileName).toBe("protokoll årsmöte.pdf");
  });

  it("strips the characters that reorder a file name from it", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment;",
        "\tfilename*=utf-8''faktura%E2%80%AEfdp.exe%E2%81%A6",
        "",
        Buffer.from("pdf bytes").toString("base64"),
        "--SEP--",
        "",
      ),
    );

    // A right-to-left override would show this as "fakturaexe.pdf", and the name
    // is what a board member decides whether to open it by.
    expect(message.attachments[0]?.fileName).toBe("fakturafdp.exe");
  });

  it("does not treat an inline part with no name as an attachment", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "En signatur kanske",
        "--SEP--",
        "",
      ),
    );

    // Otherwise every message a mail client ever sent would arrive with an
    // "attachment" the board cannot open and did not receive.
    expect(message.attachments).toHaveLength(0);
  });

  it("splits on a boundary only at the start of a line", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Jag skrev --SEP mitt i raden och det ska inte dela brevet.",
        "Andra raden.",
        "--SEP--",
        "",
      ),
    );

    // The whole paragraph is one part. A reader that matched the boundary
    // anywhere would let the sender decide where their own letter is cut.
    expect(message.text).toContain(
      "mitt i raden och det ska inte dela brevet.",
    );
    expect(message.text).toContain("Andra raden.");
  });

  it("takes the message being answered from References when In-Reply-To is absent", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "References: <first@example.test> <second@example.test>",
        "",
        "Hej",
        "",
      ),
    );

    // The last entry is the message being answered; the ones before it are the
    // conversation behind it.
    expect(message.inReplyTo).toBe("second@example.test");
  });

  it("keeps an identifier only when it is one", () => {
    // The value goes back out in the In-Reply-To of the board's answer, inside
    // brackets this instance writes. One that carries its own bracket, or that
    // is not a Message-ID at all, makes a header that says something else.
    const answered = readMessage(
      raw(
        "From: <sender@example.test>",
        "Message-ID: foo>bar",
        "In-Reply-To: <not an identifier>",
        "",
        "Hej",
        "",
      ),
    );

    expect(answered.messageId).toBeNull();
    expect(answered.inReplyTo).toBeNull();
  });

  it("does not fall back to an older reference when the newest is unreadable", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "References: <first@example.test> <second>",
        "",
        "Hej",
        "",
      ),
    );

    // The older entry names a message this letter is not a reply to, so the
    // letter opens its own thread instead of joining that one.
    expect(message.inReplyTo).toBeNull();
  });

  it("reads a multipart nested past the cap as text rather than running out of stack", () => {
    const lines = ["From: <sender@example.test>", "Subject: Djupt"];
    for (let level = 0; level < 5000; level += 1) {
      const boundary = `x${String(level)}x`;
      lines.push(
        `Content-Type: multipart/mixed; boundary=${boundary}`,
        "",
        `--${boundary}`,
      );
    }
    lines.push("Content-Type: text/plain", "", "Hej", "");

    // The module promises never to throw on malformed input, and the collector
    // takes that promise: an exception here would end the whole collection, and
    // because nothing is deleted from the mailbox it would end every collection
    // after it as well.
    const message = readMessage(raw(...lines));

    // And the letter still arrives. Not throwing is half of what the cap has to
    // do: a message silently emptied is what this file calls the worst of the
    // three outcomes, so the degradation is pinned here rather than left to be
    // replaced by an empty body that would pass the line above.
    expect(message.subject).toBe("Djupt");
    expect(message.fromAddress).toBe("sender@example.test");
    // The raw text of the level the walk stopped at, which is what a multipart
    // read as one text part is. Not "Hej": the part that holds it sits past the
    // cap and is never reached.
    expect(message.text).toContain("multipart/mixed");
    expect(message.text.length).toBeGreaterThan(0);
  });

  it("answers null for a message with no readable sender", () => {
    const message = readMessage(raw("Subject: Ingen avsandare", "", "Hej", ""));

    // Which is what makes the collector leave it in the mailbox: a thread whose
    // correspondent cannot be answered would be a conversation with nobody.
    expect(message.fromAddress).toBeNull();
  });

  it("reads a message that uses bare line feeds", () => {
    const message = readMessage(
      Buffer.from(
        "From: <sender@example.test>\nSubject: Test\n\nHej styrelsen\n",
        "utf8",
      ),
    );

    // The specification says CRLF and some clients send LF. A reader that
    // insisted would treat the whole letter as one header block with no body.
    expect(message.subject).toBe("Test");
    expect(message.text).toContain("Hej styrelsen");
  });

  it("reads a multipart whose closing boundary never arrives", () => {
    // A truncated message, which is what a mailbox holds after a transfer that
    // was cut off. The parts that did arrive are still a letter to the board, so
    // the reader hands them over rather than refusing the whole thing.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Halva brevet kom fram.",
        "",
      ),
    );

    expect(message.text).toContain("Halva brevet kom fram.");
  });

  it("reads a multipart that declares a boundary it never uses", () => {
    // The structure says multipart and the body is one flat part. Falling back
    // to reading it as a leaf is what keeps the letter readable; refusing would
    // lose it for a mistake the sender's client made.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "Ingen avgransare nagonstans.",
        "",
      ),
    );

    expect(message.text).toContain("Ingen avgransare nagonstans.");
  });

  it("bounds a header long enough to be an attack", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        `Subject: ${"A".repeat(200_000)}`,
        "",
        "Hej",
        "",
      ),
    );

    // Kept, bounded, and the letter is still readable. A header composed by
    // somebody outside the association decides its own length, so the reader
    // decides how much of it this instance holds.
    expect(message.subject.length).toBeLessThanOrEqual(8 * 1024);
    expect(message.text).toContain("Hej");
  });

  it("bounds a header folded across thousands of lines", () => {
    const folded = Array.from({ length: 5000 }, () => " AAAAAAAAAAAAAAAAAAAA");

    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Subject: start",
        ...folded,
        "",
        "Hej",
        "",
      ),
    );

    /*
     * What this asserts is the bound on the value, which is what a later reader
     * of the header gets. That the fold is also stopped while it is assembled -
     * so the whole of it is never held at once - is a property of memory rather
     * than of the answer, and no assertion on the answer can tell the two apart:
     * bounding only at the end produces exactly this string. It is stated in
     * `parseHeaders` and is deliberately not claimed here.
     */
    expect(message.subject.length).toBeLessThanOrEqual(8 * 1024 + 32);
    expect(message.text).toContain("Hej");
  });

  it("reads a body that is not valid in the character set it declares", () => {
    // A lone continuation byte, which is not valid UTF-8 anywhere. The reader is
    // lenient by design: a letter with one broken word in it is worth more to a
    // board than no letter at all.
    const message = readMessage(
      Buffer.concat([
        Buffer.from(
          [
            "From: <sender@example.test>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Det ar vatten pa golvet ",
          ].join("\r\n"),
          "latin1",
        ),
        Buffer.from([0xff, 0xfe, 0x80]),
        Buffer.from("\r\n", "latin1"),
      ]),
    );

    expect(message.text).toContain("Det ar vatten pa golvet");
    // Replacement characters rather than a thrown error or a dropped message.
    expect(message.text).toContain("\uFFFD");
  });

  it("keeps no control character in a plain-text body but the line breaks and tabs", () => {
    // PostgreSQL stores no NUL in a text column, so a body carrying one is a
    // letter the collector cannot write at all.
    const message = readMessage(
      Buffer.concat([
        raw("From: <sender@example.test>", "", "Ett"),
        Buffer.from([0x00, 0x07, 0x1b]),
        raw("\ttva", "tre", ""),
      ]),
    );

    expect(message.text).toBe("Ett\ttva\ntre\n");
  });

  it("keeps no control character in a body that arrives encoded", () => {
    // The same bytes behind a transfer encoding, which is where a reader that
    // only looked at the raw message would miss them.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Ett=00=0Btva",
        "",
      ),
    );

    expect(message.text).toBe("Etttva\n");
  });

  it("keeps no control character in a body read from HTML", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("<p>Ett\u0000tva &#0;&#x0;&#00;tre</p>").toString("base64"),
        "",
      ),
    );

    expect(message.text).toBe("Etttva tre");
  });

  it("reads a character set it does not know as UTF-8 rather than failing", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/plain; charset=x-not-a-charset",
        "",
        "Hej styrelsen",
        "",
      ),
    );

    expect(message.text).toContain("Hej styrelsen");
  });

  it("walks a multipart nested inside a multipart", () => {
    // What every mail client with an attachment and an HTML body actually
    // sends: mixed on the outside, alternative inside it, the file beside them.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=OUTER",
        "",
        "--OUTER",
        "Content-Type: multipart/alternative; boundary=INNER",
        "",
        "--INNER",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Texten avsandaren skrev",
        "--INNER",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>En rendering</p>",
        "--INNER--",
        "--OUTER",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="offert.pdf"',
        "",
        Buffer.from("pdf bytes").toString("base64"),
        "--OUTER--",
        "",
      ),
    );

    // The plain-text half of the inner alternative, not the HTML twin.
    expect(message.text).toContain("Texten avsandaren skrev");
    expect(message.text).not.toContain("En rendering");
    expect(message.textFromHtml).toBe(false);
    // And the file beside it, once.
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.fileName).toBe("offert.pdf");
  });

  it("hands over an attachment's bytes without believing its declared type", () => {
    /*
     * The sender says PDF and sends a PNG. This reader does not adjudicate that
     * - it records the declaration and hands over the bytes, and the media layer
     * identifies the file from its own header exactly as it does for an upload
     * from a browser. A reader that trusted the declaration would be the place
     * where a mail decides what a file on this instance is served as.
     */
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="rapport.pdf"',
        "",
        png.toString("base64"),
        "--SEP--",
        "",
      ),
    );

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.declaredContentType).toBe("application/pdf");
    // The bytes as they arrived, so the layer that decides can decide.
    expect(message.attachments[0]?.bytes.subarray(0, 8)).toEqual(png);
  });

  it("reads a body no further than the bound, and says it was cut", () => {
    const message = readMessage(
      raw("From: <sender@example.test>", "", "a".repeat(5_000_000), ""),
    );

    expect(message.text).toHaveLength(MAX_TEXT_CHARACTERS);
    expect(message.textTruncated).toBe(true);
  });

  it("does not call a body that fits cut", () => {
    const message = readMessage(
      raw("From: <sender@example.test>", "", "a".repeat(MAX_TEXT_CHARACTERS)),
    );

    expect(message.text).toHaveLength(MAX_TEXT_CHARACTERS);
    expect(message.textTruncated).toBe(false);
  });

  it("does not read an HTML body past the bound, and says it was cut", () => {
    // Text that sits behind more markup than the reader reads is not reached,
    // and the board is told the letter was cut although the text it got is
    // short.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/html",
        "",
        `<!--${"x".repeat(10 * MAX_TEXT_CHARACTERS)}--><p>Hej</p>`,
        "",
      ),
    );

    expect(message.text).toBe("");
    expect(message.textTruncated).toBe(true);
  });

  it("decodes no more of a body's bytes than the bound, and says it was cut", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const message = readMessage(
        raw("From: <sender@example.test>", "", "a".repeat(3_000_000), ""),
      );

      const longest = Math.max(
        ...decode.mock.calls.map(([input]) =>
          ArrayBuffer.isView(input) ? input.byteLength : 0,
        ),
      );
      expect(longest).toBeLessThan(2_000_000);
      expect(message.textTruncated).toBe(true);
    } finally {
      decode.mockRestore();
    }
  });

  it("says a body was cut when its cut bytes decode to nothing", () => {
    // Soft line breaks decode to nothing, so no cut after decoding sees how much
    // of the body there was.
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        `${"=\r\n".repeat(1_000_000)}Hej`,
        "",
      ),
    );

    expect(message.text).not.toContain("Hej");
    expect(message.textTruncated).toBe(true);
  });

  it("reads each part of nested alternatives once", () => {
    // Each level is one alternative around the next, with an HTML letter at the
    // bottom. Reading every level's children twice - once for plain text, once
    // for anything - reads that letter 2^levels times.
    const levels = 12;
    const lines = ["From: <sender@example.test>"];
    for (let level = 0; level < levels; level += 1) {
      const boundary = `alt${String(level)}x`;
      lines.push(
        `Content-Type: multipart/alternative; boundary=${boundary}`,
        "",
        `--${boundary}`,
      );
    }
    lines.push("Content-Type: text/html; charset=utf-8", "", "<p>Hej</p>", "");

    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const message = readMessage(raw(...lines));

      expect(message.text).toBe("Hej");
      expect(message.textFromHtml).toBe(true);
      expect(decode.mock.calls.length).toBeLessThanOrEqual(levels + 1);
    } finally {
      decode.mockRestore();
    }
  });

  it("prefers plain text inside a nested alternative over a later HTML one", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=OUTER",
        "",
        "--OUTER",
        "Content-Type: multipart/alternative; boundary=INNER",
        "",
        "--INNER",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Inre rendering</p>",
        "--INNER",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Vad avsandaren skrev",
        "--INNER--",
        "--OUTER",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Yttre rendering</p>",
        "--OUTER--",
        "",
      ),
    );

    expect(message.text).toBe("Vad avsandaren skrev");
    expect(message.textFromHtml).toBe(false);
  });

  it("takes the last HTML alternative when no alternative is plain text", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Forsta</p>",
        "--SEP",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Sista</p>",
        "--SEP--",
        "",
      ),
    );

    expect(message.text).toBe("Sista");
    expect(message.textFromHtml).toBe(true);
  });

  it("does not split a character when it cuts a body", () => {
    const message = readMessage(
      Buffer.from(
        [
          "From: <sender@example.test>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          `${"a".repeat(MAX_TEXT_CHARACTERS - 1)}\u{1f3e0} och mer`,
        ].join("\r\n"),
        "utf8",
      ),
    );

    expect(message.text).toBe("a".repeat(MAX_TEXT_CHARACTERS - 1));
    expect(message.textTruncated).toBe(true);
  });

  it("keeps a date the sender's clock produced", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Date: not a date at all",
        "",
        "Hej",
        "",
      ),
    );

    // Null rather than an invalid date, so the caller never stores one.
    expect(message.date).toBeNull();
  });

  it("reads when the mailbox received a letter from the topmost Received header", () => {
    const message = readMessage(
      raw(
        "Received: from mx.example.test (mx.example.test [192.0.2.1])",
        "\tby pop.example.test; Mon, 05 Oct 2026 10:00:00 +0200 (CEST)",
        // Written by the sender, below the one their mailbox's server added.
        "Received: from client; Sat, 01 Jan 2005 00:00:00 +0000",
        "From: <sender@example.test>",
        "Date: Sat, 01 Jan 2005 00:00:00 +0000",
        "",
        "Hej",
        "",
      ),
    );

    expect(message.receivedAt?.toISOString()).toBe("2026-10-05T08:00:00.000Z");
    // The sender's own clock is still read, for the caller to weigh.
    expect(message.date?.toISOString()).toBe("2005-01-01T00:00:00.000Z");
  });

  it("answers null for a letter with no Received header, or none that has a date", () => {
    const without = readMessage(
      raw("From: <sender@example.test>", "", "Hej", ""),
    );
    const undated = readMessage(
      raw(
        "Received: from mx.example.test by pop.example.test",
        "From: <sender@example.test>",
        "",
        "Hej",
        "",
      ),
    );

    expect(without.receivedAt).toBeNull();
    expect(undated.receivedAt).toBeNull();
  });

  it("counts no part unread in a letter written as text and HTML", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=ALT",
        "",
        "--ALT",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hej",
        "--ALT",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hej</p>",
        "--ALT--",
        "",
      ),
    );

    // The HTML is the same letter written again, and an attachment is kept.
    expect(message.unreadParts).toBe(0);
  });

  it("reads the text on both sides of an inline picture, as Apple Mail writes it", () => {
    const message = readMessage(
      raw(
        "From: Astrid Lindqvist <astrid@example.test>",
        "Subject: Taket",
        "Mime-Version: 1.0 (Mac OS X Mail 16.0)",
        'Content-Type: multipart/mixed; boundary="Apple-Mail=_5B1C2D3E"',
        "",
        "",
        "--Apple-Mail=_5B1C2D3E",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Type: text/plain;",
        "\tcharset=utf-8",
        "",
        "Hej styrelsen,",
        "",
        "H=C3=A4r =C3=A4r en bild p=C3=A5 l=C3=A4ckan:",
        "",
        "--Apple-Mail=_5B1C2D3E",
        "Content-Disposition: inline;",
        "\tfilename=tak.jpg",
        "Content-Type: image/jpeg;",
        "\tx-unix-mode=0644;",
        "\tname=tak.jpg",
        "Content-Transfer-Encoding: base64",
        "",
        "/9j/4AAQSkZJRgABAQ==",
        "--Apple-Mail=_5B1C2D3E",
        "Content-Transfer-Encoding: 7bit",
        "Content-Type: text/plain;",
        "\tcharset=us-ascii",
        "",
        "",
        "Det droppar in vid skorstenen.",
        "",
        "Mvh Astrid",
        "--Apple-Mail=_5B1C2D3E--",
        "",
      ),
    );

    // Both parts, in order, with a blank line where the picture stood.
    expect(message.text).toBe(
      "Hej styrelsen,\n\nHär är en bild på läckan:\n\nDet droppar in vid skorstenen.\n\nMvh Astrid",
    );
    expect(message.textTruncated).toBe(false);
    expect(message.textFromHtml).toBe(false);
    expect(message.attachments.map((file) => file.fileName)).toEqual([
      "tak.jpg",
    ]);
    expect(message.unreadParts).toBe(0);
  });

  it("reads a text part beside a letter written as text and HTML", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: multipart/alternative; boundary=ALT",
        "",
        "--ALT",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--ALT",
        "Content-Type: text/html",
        "",
        "<p>Hej</p>",
        "--ALT--",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Och det har ocksa",
        "--SEP",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="tak.png"',
        "",
        "AAAA",
        "--SEP--",
        "",
      ),
    );

    // The HTML is the same letter written again, and is not read twice.
    expect(message.text).toBe("Hej\n\nOch det har ocksa");
    expect(message.attachments).toHaveLength(1);
    expect(message.unreadParts).toBe(0);
  });

  it("says an HTML part was read when one of the joined parts is HTML", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: text/html",
        "",
        "<p>Mvh <b>Astrid</b></p>",
        "--SEP--",
        "",
      ),
    );

    expect(message.text).toBe("Hej\n\nMvh Astrid");
    expect(message.textFromHtml).toBe(true);
  });

  it("leaves no gap for a text part that holds only line breaks", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Mvh Astrid",
        "--SEP--",
        "",
      ),
    );

    expect(message.text).toBe("Hej\n\nMvh Astrid");
  });

  it("holds joined parts to the bound, and says the letter was cut", () => {
    const part = "a".repeat(MAX_TEXT_CHARACTERS / 2);
    const lines = [
      "From: <sender@example.test>",
      "Content-Type: multipart/mixed; boundary=SEP",
      "",
    ];
    for (let index = 0; index < 4; index += 1) {
      lines.push("--SEP", "Content-Type: text/plain", "", part);
    }
    lines.push("--SEP--", "");

    const message = readMessage(raw(...lines));

    expect(message.text).toHaveLength(MAX_TEXT_CHARACTERS);
    expect(message.textTruncated).toBe(true);
    // The parts past the bound are not read, and are counted as unread.
    expect(message.unreadParts).toBe(2);
  });

  it("says a letter was cut when a text part past the bound was not read", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "a".repeat(MAX_TEXT_CHARACTERS),
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Och mer",
        "--SEP--",
        "",
      ),
    );

    expect(message.text).toHaveLength(MAX_TEXT_CHARACTERS);
    expect(message.text).not.toContain("Och mer");
    expect(message.textTruncated).toBe(true);
  });

  it("does not call a letter cut when only files follow the bound", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "a".repeat(MAX_TEXT_CHARACTERS),
        "--SEP",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="rapport.pdf"',
        "",
        "AAAA",
        "--SEP--",
        "",
      ),
    );

    expect(message.textTruncated).toBe(false);
    expect(message.attachments).toHaveLength(1);
  });

  it("reads only the document of a multipart/related, and counts a text resource beside it as unread", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/related; boundary=REL",
        "",
        "--REL",
        "Content-Type: text/html",
        "",
        "<p>Hej</p>",
        "--REL",
        "Content-Type: text/css",
        "Content-ID: <stil@example.test>",
        "",
        "p { color: red }",
        "--REL--",
        "",
      ),
    );

    expect(message.text).toBe("Hej");
    expect(message.unreadParts).toBe(1);
  });

  it("reads no text type into the letter but plain text and HTML", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/mixed; boundary=SEP",
        "",
        "--SEP",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--SEP",
        "Content-Type: text/calendar; method=REQUEST",
        "",
        "BEGIN:VCALENDAR",
        "END:VCALENDAR",
        "--SEP",
        "Content-Type: text/vcard",
        "",
        "BEGIN:VCARD",
        "END:VCARD",
        "--SEP",
        "Content-Type: text/rfc822-headers",
        "",
        "Received: from mx.example.test",
        "--SEP",
        "Content-Type: text/csv",
        "",
        "lagenhet,belopp",
        "--SEP--",
        "",
      ),
    );

    // An invitation, a contact card, a bounced letter's headers and a table
    // are data a client shows as something else, not the letter's words.
    expect(message.text).toBe("Hej");
    expect(message.textTruncated).toBe(false);
    expect(message.unreadParts).toBe(4);
  });

  it("reads the other forms of a letter beside the one it chose", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=ALT",
        "",
        "--ALT",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--ALT",
        "Content-Type: text/html",
        "",
        "<p>Ett <b>annat</b> brev</p>",
        "--ALT--",
        "",
      ),
    );

    expect(message.text).toBe("Hej");
    // A client that shows HTML shows the other letter, so a caller that judges
    // the letter by its text has to be able to see it.
    expect(message.alternatives).toEqual([
      {
        text: "Ett annat brev",
        truncated: false,
        fromHtml: true,
        html: "<p>Ett <b>annat</b> brev</p>",
      },
    ]);
    expect(message.unreadParts).toBe(0);
  });

  it("counts a form of the letter that is not text as unread", () => {
    const message = readMessage(
      raw(
        "From: <sender@example.test>",
        "Content-Type: multipart/alternative; boundary=ALT",
        "",
        "--ALT",
        "Content-Type: text/plain",
        "",
        "Hej",
        "--ALT",
        "Content-Type: application/octet-stream",
        "",
        "AAAA",
        "--ALT--",
        "",
      ),
    );

    expect(message.text).toBe("Hej");
    expect(message.alternatives).toEqual([]);
    expect(message.unreadParts).toBe(1);
  });

  it("reads a letter of many parts in time that grows with their number", () => {
    // A sender decides how many parts a letter has, and a part that says
    // nothing adds nothing to the bound on the text, so every one is read.
    // Finding each read part again by a search from the top would cost the
    // square of their number.
    const parts = 50_000;
    const lines = [
      "From: <sender@example.test>",
      "Content-Type: multipart/mixed; boundary=SEP",
      "",
    ];
    for (let index = 0; index < parts; index += 1) {
      lines.push("--SEP", "Content-Type: text/plain", "", "\u0001");
    }
    lines.push("--SEP", "Content-Type: text/plain", "", "Hej", "--SEP--", "");

    // Joined here rather than spread into raw(), which has a stack to run out of.
    const letter = Buffer.from(lines.join("\r\n"), "latin1");

    const started = performance.now();
    const message = readMessage(letter);

    expect(message.text).toBe("Hej");
    expect(message.unreadParts).toBe(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("addressFrom", () => {
  it("takes the address out of the angle brackets", () => {
    expect(addressFrom('"Lindqvist, Astrid" <astrid@example.test>')).toBe(
      "astrid@example.test",
    );
  });

  it("accepts a bare address", () => {
    expect(addressFrom("astrid@example.test")).toBe("astrid@example.test");
  });

  it("refuses something that is not an address", () => {
    expect(addressFrom("Astrid Lindqvist")).toBeNull();
    expect(addressFrom("<not an address>")).toBeNull();
  });

  it("refuses an address that carries a control character", () => {
    // The address becomes the recipient of the board's answer.
    expect(addressFrom("<a\u0000b@example.test>")).toBeNull();
    expect(addressFrom("a\u001bb@example.test")).toBeNull();
    expect(addressFrom("<ab@example.test\u007f>")).toBeNull();
  });
});

describe("decodeEncodedWords", () => {
  it("decodes the base64 form", () => {
    expect(decodeEncodedWords("=?utf-8?B?RnLDpWdh?=")).toBe("Fråga");
  });

  it("reads underscore as a space in the Q form", () => {
    // The one way Q differs from quoted-printable, and the difference between
    // "Fraga om balkongen" and "Fraga_om_balkongen".
    expect(decodeEncodedWords("=?utf-8?Q?Fraga_om_balkongen?=")).toBe(
      "Fraga om balkongen",
    );
  });

  it("keeps text that is not an encoded word", () => {
    expect(decodeEncodedWords("Re: =?utf-8?Q?Fraga?= igen")).toBe(
      "Re: Fraga igen",
    );
  });
});

describe("htmlToText", () => {
  it("turns block elements into line breaks", () => {
    expect(htmlToText("<div>Ett</div><div>Tva</div>")).toBe("Ett\nTva");
  });

  it("decodes an escaped entity exactly once", () => {
    // "&amp;lt;" is the text "&lt;", not the character "<". Resolving "&amp;"
    // last is what keeps that true, and getting it wrong would put a character
    // back that the sender had escaped.
    expect(htmlToText("<p>&amp;lt;p&amp;gt;</p>")).toBe("&lt;p&gt;");
  });

  it("drops a comment rather than reading it as words", () => {
    expect(htmlToText("<p>Ett<!-- dolt -->Tva</p>")).toBe("EttTva");
  });

  it("drops a comment that is never closed", () => {
    expect(htmlToText("<p>Ett<!-- dolt</p>")).toBe("Ett");
  });

  it("drops a script whose closing tag carries attributes", () => {
    // A closing tag may carry attributes, which the tokeniser discards. Reading
    // the element to a closing tag written only as "</script>" ends it too late
    // and puts the code that follows into the letter as words.
    expect(htmlToText("<p>Ett</p><script>alert(1)</script foo>")).toBe("Ett");
    expect(htmlToText("<p>Ett</p><style>a{b:c}</style foo>")).toBe("Ett");
  });

  it("drops a script that is never closed", () => {
    expect(htmlToText("<p>Ett</p><script>alert(1)")).toBe("Ett");
  });

  it("keeps a comparison the sender wrote", () => {
    // A "<" that no element name follows is a character, not a tag, and the
    // words after it are the sentence rather than the inside of markup.
    expect(htmlToText("<p>1 < 2 och 3 > 2</p>")).toBe("1 < 2 och 3 > 2");
  });

  it("reads an attribute value that holds a closing bracket", () => {
    expect(htmlToText('<p title="a > b">Ett</p>')).toBe("Ett");
  });

  it("gives an escaped tag back as the characters it spelled", () => {
    // The result is text and is handled as text: entity decoding restores the
    // characters the sender escaped, which is what the sender meant by them.
    expect(htmlToText("<p>&lt;script&gt;</p>")).toBe("<script>");
  });

  it("decodes an entity for code point zero to nothing", () => {
    expect(htmlToText("<p>Ett&#0;tva&#x0000;tre</p>")).toBe("Etttvatre");
  });

  it("decodes no entity to a control character but a line break or a tab", () => {
    expect(htmlToText("<p>Ett&#27;&#x7;tva&#9;tre&#10;fyra</p>")).toBe(
      "Etttva\ttre\nfyra",
    );
  });

  it("drops the spaces and tabs that end a line", () => {
    expect(htmlToText("<p>Ett \t </p>tva\t<br>tre   fyra")).toBe(
      "Ett\ntva\ntre   fyra",
    );
  });

  it("reads a long run of spaces with no line break after it in linear time", () => {
    const started = performance.now();
    const text = htmlToText(`<p>${" ".repeat(200_000)}x</p>`);

    expect(performance.now() - started).toBeLessThan(1000);
    expect(text).toBe("x");
  });
});
