import { constants, deflateRawSync } from "node:zlib";

/**
 * A minimal document, built byte by byte.
 *
 * Enough structure to be identified and no more: what the upload path reads is
 * the signature, the version and the end-of-file marker, so a document written
 * by a real producer would add pages of object definitions that no assertion
 * here looks at. Building it by hand is also what makes the negative cases
 * possible, since a truncated or unterminated file has to be constructible.
 */

/** A PDF: a versioned header, one trivial body, and the end-of-file marker. */
export function pdfBytes(version = "1.7"): Buffer {
  return Buffer.from(
    `%PDF-${version}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

/** A PDF header with nothing closing it: opens as one, is not one. */
export function truncatedPdfBytes(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n", "latin1");
}

/**
 * A PDF a parser opens: one page per string, each drawn in Helvetica, with a
 * cross-reference table whose offsets are counted rather than guessed.
 *
 * A line break in a string starts a new line on the page, since a line wider
 * than the page is drawn past its edge, where a reader does not see it. Null
 * draws a page with nothing on it, which is what a scan is to a text reader:
 * an image and no text layer. `locked` adds a password. The text is encoded as WinAnsi, so
 * "Föreningsstämma" reaches the page as the producer of a Swedish document
 * would write it.
 */
export function textPdfBytes(
  pages: readonly (string | null)[],
  options: { locked?: boolean } = {},
): Buffer {
  const escape = (text: string): string =>
    text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  return pagedPdfBytes(
    pages.map((text) => ({
      dictionary: "",
      stream:
        text === null
          ? ""
          : `BT /F1 12 Tf 14 TL 72 720 Td ${text
              .split("\n")
              .map((line) => `(${escape(line)}) Tj`)
              .join(" T* ")} ET`,
    })),
    options,
  );
}

/**
 * A PDF of one page whose content stream is compressed and inflates to
 * `inflatedBytes` bytes of blank space: a decompression bomb.
 *
 * `flate` is how a real producer compresses, and pdf.js inflates it in Node's
 * own decompressor, a chunk at a time, with its event loop running between
 * them. The file stays about a thousandth of what it inflates to, so one under
 * any upload cap can ask for gigabytes. `run-length` is a sixty-fourth, and
 * pdf.js expands it in JavaScript as it lexes, with its event loop held: only
 * a watch from outside the parser sees that memory grow.
 *
 * The flate stream is built without holding what it inflates to. Deflate
 * blocks ended by a full flush stand alone, so one block for a mebibyte of
 * spaces is written as many times as it takes, and the checksum zlib ends with
 * is counted for the spaces rather than over them.
 */
export function inflatingPdfBytes(
  inflatedBytes: number,
  filter: "flate" | "run-length" = "flate",
): Buffer {
  if (filter === "run-length") {
    // Each pair is a run of 128 spaces; 128 ends the data.
    const runs = Math.ceil(inflatedBytes / 128);
    const encoded = Buffer.alloc(runs * 2 + 1, Buffer.from([0x81, 0x20]));
    encoded[runs * 2] = 0x80;
    return pagedPdfBytes([
      {
        dictionary: " /Filter /RunLengthDecode",
        stream: encoded.toString("latin1"),
      },
    ]);
  }
  const mebibyte = 1024 * 1024;
  const copies = Math.ceil(inflatedBytes / mebibyte);
  const block = deflateRawSync(Buffer.alloc(mebibyte, " "), {
    level: 9,
    finishFlush: constants.Z_FULL_FLUSH,
  });
  const compressed = Buffer.concat([
    Buffer.from([0x78, 0xda]),
    ...Array.from({ length: copies }, () => block),
    // The final block, empty, and the Adler-32 of every byte inflated.
    Buffer.from([0x03, 0x00]),
    adler32OfRepeated(0x20, BigInt(copies * mebibyte)),
  ]);
  return pagedPdfBytes([
    {
      dictionary: " /Filter /FlateDecode",
      stream: compressed.toString("latin1"),
    },
  ]);
}

/** The Adler-32 of `count` copies of `byte`, big-endian as zlib writes it. */
function adler32OfRepeated(byte: number, count: bigint): Buffer {
  const modulus = 65521n;
  const value = BigInt(byte);
  // a = 1 + count * byte; b sums a after every byte: count + byte * count(count + 1) / 2.
  const a = (1n + count * value) % modulus;
  const b = (count + (value * count * (count + 1n)) / 2n) % modulus;
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(Number((b << 16n) | a));
  return checksum;
}

/**
 * The file around some pages: a catalog, a page tree, Helvetica, and one
 * content stream per page, written as latin1 so binary streams pass unchanged.
 */
function pagedPdfBytes(
  pages: readonly { dictionary: string; stream: string }[],
  options: { locked?: boolean } = {},
): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach(({ dictionary, stream }, index) => {
    const pageId = pageIds[index] as number;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageId + 1)} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${String(Buffer.byteLength(stream, "latin1"))}${dictionary} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${String(id)} 0 obj\n${objects[id] as string}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  /*
   * A file locked with a password: the standard security handler, whose user
   * key is 32 bytes no empty password produces, so a reader without the
   * password is refused before it reaches a page.
   */
  const lock = options.locked
    ? ` /Encrypt << /Filter /Standard /V 1 /R 2 /P -4 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >> /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`
    : "";
  body += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R${lock} >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
