/**
 * Taking the personal data out of an image before it is stored.
 *
 * A photograph carries more than its pixels: EXIF holds where and when it was
 * taken and with what, XMP and IPTC hold names and captions, and a PNG or GIF
 * has text chunks and comments for the same. A camera writes the position
 * without being asked, so a photo of a leak in a stairwell arrives with the
 * reporter's coordinates, and every account that may open the file is handed
 * them along with it.
 *
 * So what is stored is the image with that taken out, by an allowlist: a
 * segment, chunk or block survives only if the picture cannot be drawn without
 * it (or, for a colour profile, drawn correctly). Whatever a format adds later
 * is dropped rather than kept. The compressed picture data itself is copied
 * byte for byte, so nothing is decoded, nothing is recompressed and a photo
 * loses no quality.
 *
 * One item of EXIF is rewritten rather than removed: the orientation. Phones
 * store a portrait photo as a landscape one with a flag, and without the flag
 * it is shown on its side. The flag is a number between 1 and 8 and says
 * nothing about anyone, so a minimal EXIF holding only that number is put
 * where the original was.
 *
 * Data appended after the end of the image is dropped too, which is where a
 * phone keeps a motion photo's video and a second, full-size EXIF.
 *
 * A file whose structure cannot be followed to its end is refused (null)
 * rather than stored as it came: if the walk cannot tell what a stretch of
 * bytes is, it cannot say that stretch holds no coordinates.
 */

import { crc32 } from "node:zlib";

/** The image without its metadata, or null for a file that cannot be followed. */
export function stripImageMetadata(
  bytes: Buffer,
  contentType: string,
): Buffer | null {
  switch (contentType) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "image/gif":
      return stripGif(bytes);
    default:
      // A type this does not know how to clean is not passed through.
      return null;
  }
}

/**
 * EXIF holding the orientation and nothing else, as a TIFF structure.
 *
 * Big-endian, one entry in the first directory, no further directory.
 */
function minimalExif(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // offset of the first directory
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // one value
  tiff.writeUInt16BE(orientation, 18);
  // The value field is four bytes, of which the SHORT fills two; the offset
  // of a next directory (none) follows at 22.
  return tiff;
}

/**
 * The orientation a TIFF structure declares, when it declares one a viewer
 * should act on (2 to 8; 1 is the default and is not worth keeping).
 *
 * Reads only what it needs and gives up on anything out of bounds, because the
 * structure is the uploader's.
 */
function readOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) {
    return null;
  }
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") {
    return null;
  }
  const little = order === "II";
  const u16 = (at: number) =>
    little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) =>
    little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);

  if (u16(2) !== 42) {
    return null;
  }
  const directory = u32(4);
  if (directory + 2 > tiff.length) {
    return null;
  }
  const entries = u16(directory);
  for (let index = 0; index < entries; index += 1) {
    const at = directory + 2 + index * 12;
    if (at + 12 > tiff.length) {
      return null;
    }
    if (u16(at) === 0x0112) {
      // Type SHORT with a single value, held in the entry itself.
      if (u16(at + 2) !== 3 || u32(at + 4) !== 1) {
        return null;
      }
      const value = u16(at + 8);
      return value >= 2 && value <= 8 ? value : null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ JPEG */

const EXIF_IDENTIFIER = Buffer.from("Exif\0\0", "latin1");
const ICC_IDENTIFIER = Buffer.from("ICC_PROFILE\0", "latin1");
const ADOBE_IDENTIFIER = Buffer.from("Adobe", "latin1");
const JFIF_IDENTIFIER = Buffer.from("JFIF\0", "latin1");

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

function stripJpeg(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
    return null;
  }

  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let exifSeen = false;
  let offset = 2;

  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      // Fill byte before the next marker.
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) {
      return null;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) {
      return null;
    }
    const payload = bytes.subarray(offset + 4, end);

    if (marker >= 0xe0 && marker <= 0xef) {
      const kept = keepJpegApplicationSegment(marker, payload, exifSeen);
      if (kept.exif) {
        exifSeen = true;
      }
      if (kept.segment !== null) {
        out.push(kept.segment);
      }
      offset = end;
      continue;
    }
    if (marker === 0xfe) {
      // A comment: free text.
      offset = end;
      continue;
    }

    out.push(bytes.subarray(offset, end));
    offset = end;

    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows, running to the next marker
      // that is not byte stuffing (ff 00) or a restart (ff d0 to ff d7).
      const scanEnd = endOfScan(bytes, offset);
      out.push(bytes.subarray(offset, scanEnd));
      offset = scanEnd;
    }
  }

  // Ran out of bytes before the end-of-image marker.
  return null;
}

function endOfScan(bytes: Buffer, from: number): number {
  let at = from;
  while (at + 1 < bytes.length) {
    if (bytes[at] === 0xff) {
      const next = bytes[at + 1] ?? 0;
      if (next === 0xff) {
        at += 1;
        continue;
      }
      if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) {
        return at;
      }
      at += 2;
      continue;
    }
    at += 1;
  }
  return bytes.length;
}

function keepJpegApplicationSegment(
  marker: number,
  payload: Buffer,
  exifSeen: boolean,
): { segment: Buffer | null; exif: boolean } {
  if (marker === 0xe1 && startsWith(payload, EXIF_IDENTIFIER)) {
    // Only the first EXIF segment is the image's own.
    const orientation = exifSeen
      ? null
      : readOrientation(payload.subarray(EXIF_IDENTIFIER.length));
    return {
      exif: true,
      segment:
        orientation === null
          ? null
          : segment(
              0xe1,
              Buffer.concat([EXIF_IDENTIFIER, minimalExif(orientation)]),
            ),
    };
  }
  if (
    marker === 0xe0 &&
    startsWith(payload, JFIF_IDENTIFIER) &&
    payload.length >= 14
  ) {
    // The version, units and density; the embedded thumbnail is not kept.
    const head = Buffer.from(payload.subarray(0, 14));
    head[12] = 0;
    head[13] = 0;
    return { segment: segment(0xe0, head), exif: false };
  }
  if (marker === 0xe2 && startsWith(payload, ICC_IDENTIFIER)) {
    return { segment: segment(0xe2, payload), exif: false };
  }
  if (marker === 0xee && startsWith(payload, ADOBE_IDENTIFIER)) {
    // Says how the channels are to be read, so the colours depend on it.
    return { segment: segment(0xee, payload), exif: false };
  }
  return { segment: null, exif: false };
}

/* ------------------------------------------------------------------- PNG */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Chunks the picture, its colours or its animation need. Text, time and EXIF are not among them. */
const PNG_KEPT_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "hIST",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function stripPng(bytes: Buffer): Buffer | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  const out: Buffer[] = [PNG_SIGNATURE];
  let exifSeen = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      return null;
    }

    if (PNG_KEPT_CHUNKS.has(type)) {
      out.push(bytes.subarray(offset, end));
    } else if (type === "eXIf" && !exifSeen) {
      exifSeen = true;
      const orientation = readOrientation(
        bytes.subarray(offset + 8, offset + 8 + length),
      );
      if (orientation !== null) {
        out.push(pngChunk("eXIf", minimalExif(orientation)));
      }
    }

    offset = end;
    if (type === "IEND") {
      return Buffer.concat(out);
    }
  }

  return null;
}

/* ------------------------------------------------------------------ WebP */

/** Chunks that draw, animate or colour the picture. EXIF and XMP are not among them. */
const WEBP_KEPT_CHUNKS = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ICCP",
  "ALPH",
  "ANIM",
  "ANMF",
]);

const VP8X_FLAG_XMP = 0x04;
const VP8X_FLAG_EXIF = 0x08;

function stripWebp(bytes: Buffer): Buffer | null {
  if (
    bytes.length < 12 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 12) {
    return null;
  }

  const chunks: Buffer[] = [];
  let exifSeen = false;
  let orientation: number | null = null;
  let extendedAt: number | null = null;
  let offset = 12;

  while (offset + 8 <= end) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    // A chunk is padded to an even length; the padding may be missing at the
    // very end of a file.
    const chunkEnd = Math.min(dataEnd + (size % 2), end);
    if (dataEnd > end) {
      return null;
    }

    if (WEBP_KEPT_CHUNKS.has(type)) {
      if (type === "VP8X") {
        extendedAt = chunks.length;
      }
      chunks.push(Buffer.from(bytes.subarray(offset, chunkEnd)));
    } else if (type === "EXIF" && !exifSeen) {
      exifSeen = true;
      orientation = readOrientation(bytes.subarray(offset + 8, dataEnd));
    }

    offset = chunkEnd;
  }
  if (offset !== end || chunks.length === 0) {
    return null;
  }

  if (orientation !== null) {
    const exif = minimalExif(orientation);
    const head = Buffer.alloc(8);
    head.write("EXIF", 0, "latin1");
    head.writeUInt32LE(exif.length, 4);
    chunks.push(Buffer.concat([head, exif]));
  }

  if (extendedAt !== null) {
    const extended = chunks[extendedAt];
    if (extended === undefined || extended.length < 9) {
      return null;
    }
    // Flags describe the chunks that follow, so they have to follow what is
    // actually left.
    extended[8] =
      ((extended[8] ?? 0) & ~(VP8X_FLAG_XMP | VP8X_FLAG_EXIF)) |
      (orientation === null ? 0 : VP8X_FLAG_EXIF);
  } else if (orientation !== null) {
    // EXIF is only defined in the extended format; a simple file is left
    // without it rather than upgraded.
    chunks.pop();
  }

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

/* ------------------------------------------------------------------- GIF */

/** Application extensions that make the picture move; others (XMP among them) carry data about it. */
const GIF_KEPT_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

function stripGif(bytes: Buffer): Buffer | null {
  const signature = bytes.toString("latin1", 0, 6);
  if (bytes.length < 13 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    return null;
  }

  const colourTable = (packed: number) =>
    packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;

  let offset = 13 + colourTable(bytes[10] ?? 0);
  if (offset > bytes.length) {
    return null;
  }
  const out: Buffer[] = [bytes.subarray(0, offset)];

  /** The end of a run of data sub-blocks, past its terminator, or null if cut short. */
  const endOfSubBlocks = (from: number): number | null => {
    let at = from;
    while (at < bytes.length) {
      const size = bytes[at] ?? 0;
      at += 1 + size;
      if (size === 0) {
        return at <= bytes.length ? at : null;
      }
    }
    return null;
  };

  while (offset < bytes.length) {
    const introducer = bytes[offset];

    if (introducer === 0x3b) {
      out.push(Buffer.from([0x3b]));
      return Buffer.concat(out);
    }

    if (introducer === 0x21) {
      const label = bytes[offset + 1];
      if (label === undefined) {
        return null;
      }
      const end = endOfSubBlocks(offset + 2);
      if (end === null) {
        return null;
      }
      if (label === 0xf9) {
        out.push(bytes.subarray(offset, end));
      } else if (label === 0xff) {
        const application = bytes.toString("latin1", offset + 3, offset + 14);
        if (
          bytes[offset + 2] === 11 &&
          GIF_KEPT_APPLICATIONS.has(application)
        ) {
          out.push(bytes.subarray(offset, end));
        }
      }
      offset = end;
      continue;
    }

    if (introducer === 0x2c) {
      // Image descriptor, its local colour table, the code size, then data.
      if (offset + 10 > bytes.length) {
        return null;
      }
      const dataStart = offset + 10 + colourTable(bytes[offset + 9] ?? 0) + 1;
      const end = endOfSubBlocks(dataStart);
      if (end === null) {
        return null;
      }
      out.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }

    return null;
  }

  return null;
}
