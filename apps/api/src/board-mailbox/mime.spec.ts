import { describe, expect, it } from "vitest";

import {
  addressFrom,
  decodeEncodedWords,
  htmlToText,
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
});
