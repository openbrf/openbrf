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
 * loses no quality. A colour profile is kept whole: its header has a date and
 * device fields, but a phone embeds a generic profile (sRGB, Display P3), not
 * one about the photo.
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
 * bytes is, it cannot say that stretch holds no coordinates. So is a file of
 * more segments, chunks or blocks than any picture has, since the walk runs
 * on every upload, the board mailbox's anonymous attachments among them.
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
 * The most segments, chunks or blocks a walk passes before it refuses the file.
 *
 * A long animation has a few thousand frames and a photo a few dozen segments,
 * while a file made of nothing but two-byte markers would have millions.
 */
const MAX_IMAGE_STRUCTURES = 65_536;

/**
 * What the stripped image may grow by: the minimal EXIF can be longer than the
 * orientation it replaces, and a WebP chunk that ended the file without its pad
 * byte gets one. Everything else kept is a copy or a shortening.
 */
const OUTPUT_MARGIN = 64;

/**
 * The stripped image, written into one buffer as the walk goes.
 *
 * Nothing is allocated for each segment, chunk or block kept, so a file made of
 * millions of tiny ones costs no more memory than its own size. The walk counts
 * what it passes here as well, and gives up past MAX_IMAGE_STRUCTURES.
 */
class StrippedImage {
  private readonly bytes: Buffer;
  private written = 0;
  private structures = 0;

  constructor(original: Buffer) {
    this.bytes = Buffer.allocUnsafe(original.length + OUTPUT_MARGIN);
  }

  get length(): number {
    return this.written;
  }

  /** Counts one structure passed; false once there are more than any picture has. */
  count(): boolean {
    this.structures += 1;
    return this.structures <= MAX_IMAGE_STRUCTURES;
  }

  write(source: Buffer, start = 0, end = source.length): void {
    if (this.written + (end - start) > this.bytes.length) {
      // Buffer.copy would cut the bytes off without a word.
      throw new RangeError("The stripped image outgrew the original.");
    }
    this.written += source.copy(this.bytes, this.written, start, end);
  }

  byteAt(at: number): number {
    return this.bytes[at] ?? 0;
  }

  setByte(at: number, value: number): void {
    this.bytes[at] = value;
  }

  setUInt32LE(at: number, value: number): void {
    this.bytes.writeUInt32LE(value, at);
  }

  result(): Buffer {
    return this.bytes.subarray(0, this.written);
  }
}

const EXIF_IDENTIFIER = Buffer.from("Exif\0\0", "latin1");

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
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
 * The orientation an EXIF structure declares, when it declares one a viewer
 * should act on (2 to 8; 1 is the default and is not worth keeping).
 *
 * Takes the TIFF structure with or without the identifier a JPEG puts before
 * it: a WebP or PNG should hold the TIFF structure alone, but some writers
 * (Pillow's animated WebP among them) leave the identifier in.
 *
 * Reads only what it needs and gives up on anything out of bounds, because the
 * structure is the uploader's.
 */
function readOrientation(exif: Buffer): number | null {
  const tiff = startsWith(exif, EXIF_IDENTIFIER)
    ? exif.subarray(EXIF_IDENTIFIER.length)
    : exif;
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

const ICC_IDENTIFIER = Buffer.from("ICC_PROFILE\0", "latin1");
const ADOBE_IDENTIFIER = Buffer.from("Adobe", "latin1");
const JFIF_IDENTIFIER = Buffer.from("JFIF\0", "latin1");

/** The identifier, the version and the two flag words of an Adobe segment, then its colour transform. */
const ADOBE_LENGTH = 12;

/**
 * Segments that decode the picture, besides the application segments that
 * colour it: the frame headers (SOF, every coding process), Huffman and
 * arithmetic tables, quantisation tables, the start of a scan, the number of
 * lines, the restart interval and the hierarchical markers. Reserved and
 * extension markers are not among them.
 */
const JPEG_KEPT_SEGMENTS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd,
  0xce, 0xcf, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
]);

function stripJpeg(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
    return null;
  }

  const out = new StrippedImage(bytes);
  out.write(bytes, 0, 2);
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
      out.write(bytes, offset, offset + 2);
      return out.result();
    }
    if (!out.count()) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      // A marker without a payload, out of place between segments; a decoder
      // skips it, so it is not kept.
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

    if (marker >= 0xe0 && marker <= 0xef) {
      const payload = bytes.subarray(offset + 4, end);
      if (writeJpegApplicationSegment(out, marker, payload, exifSeen)) {
        exifSeen = true;
      }
    } else if (JPEG_KEPT_SEGMENTS.has(marker)) {
      out.write(bytes, offset, end);
      if (marker === 0xda) {
        // Start of scan: entropy-coded data follows, running to the next
        // marker that is not byte stuffing (ff 00) or a restart (ff d0 to
        // ff d7).
        const scanEnd = endOfScan(bytes, end);
        out.write(bytes, end, scanEnd);
        offset = scanEnd;
        continue;
      }
    }
    // Anything else, a comment or a reserved or extension marker, is dropped
    // with its payload.
    offset = end;
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

function writeJpegSegment(
  out: StrippedImage,
  marker: number,
  parts: Buffer[],
): void {
  const length = parts.reduce((sum, part) => sum + part.length, 2);
  out.write(Buffer.from([0xff, marker, length >> 8, length & 0xff]));
  for (const part of parts) {
    out.write(part);
  }
}

/** Writes what is kept of an application segment; true if it was an EXIF segment. */
function writeJpegApplicationSegment(
  out: StrippedImage,
  marker: number,
  payload: Buffer,
  exifSeen: boolean,
): boolean {
  if (marker === 0xe1 && startsWith(payload, EXIF_IDENTIFIER)) {
    // Only the first EXIF segment is the image's own.
    const orientation = exifSeen ? null : readOrientation(payload);
    if (orientation !== null) {
      writeJpegSegment(out, 0xe1, [EXIF_IDENTIFIER, minimalExif(orientation)]);
    }
    return true;
  }
  if (
    marker === 0xe0 &&
    startsWith(payload, JFIF_IDENTIFIER) &&
    payload.length >= 14
  ) {
    // The version, units and density; the embedded thumbnail is not kept, so
    // its dimensions are written as zero.
    writeJpegSegment(out, 0xe0, [payload.subarray(0, 12), Buffer.alloc(2)]);
  } else if (marker === 0xe2 && startsWith(payload, ICC_IDENTIFIER)) {
    writeJpegSegment(out, 0xe2, [payload]);
  } else if (marker === 0xee && startsWith(payload, ADOBE_IDENTIFIER)) {
    // Says how the channels are to be read, so the colours depend on it.
    writeJpegSegment(out, 0xee, [payload.subarray(0, ADOBE_LENGTH)]);
  }
  return false;
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

  const out = new StrippedImage(bytes);
  out.write(PNG_SIGNATURE);
  let exifSeen = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    if (!out.count()) {
      return null;
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      return null;
    }

    if (PNG_KEPT_CHUNKS.has(type)) {
      out.write(bytes, offset, end);
    } else if (type === "eXIf" && !exifSeen) {
      exifSeen = true;
      const orientation = readOrientation(
        bytes.subarray(offset + 8, offset + 8 + length),
      );
      if (orientation !== null) {
        out.write(pngChunk("eXIf", minimalExif(orientation)));
      }
    }

    offset = end;
    if (type === "IEND") {
      return out.result();
    }
  }

  return null;
}

/* ------------------------------------------------------------------ WebP */

/** Chunks that draw, animate or colour the picture. EXIF and XMP are not among them, and ANMF is rebuilt. */
const WEBP_KEPT_CHUNKS = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ICCP",
  "ALPH",
  "ANIM",
]);

/** Chunks an animation frame is drawn with: its transparency and its picture. */
const WEBP_FRAME_CHUNKS = new Set(["ALPH", "VP8 ", "VP8L"]);

/** An animation frame's position, size, duration and flags, before its chunks. */
const WEBP_FRAME_HEADER_LENGTH = 16;

const VP8X_FLAG_XMP = 0x04;
const VP8X_FLAG_EXIF = 0x08;

const PAD = Buffer.alloc(1);

/** Copies a chunk and writes its pad byte, which a file may leave off at its very end. */
function writeRiffChunk(
  out: StrippedImage,
  bytes: Buffer,
  offset: number,
  dataEnd: number,
): void {
  out.write(bytes, offset, dataEnd);
  if ((dataEnd - offset) % 2 === 1) {
    out.write(PAD);
  }
}

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

  const out = new StrippedImage(bytes);
  // The RIFF size is written once the length is known.
  out.write(bytes, 0, 12);
  let exifSeen = false;
  let orientation: number | null = null;
  let extendedAt: number | null = null;
  let offset = 12;

  while (offset + 8 <= end) {
    if (!out.count()) {
      return null;
    }
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    // A chunk is padded to an even length; the padding may be missing at the
    // very end of a file.
    const chunkEnd = Math.min(dataEnd + (size % 2), end);
    if (dataEnd > end) {
      return null;
    }

    if (type === "ANMF") {
      if (!writeWebpFrame(out, bytes, offset, dataEnd)) {
        return null;
      }
    } else if (WEBP_KEPT_CHUNKS.has(type)) {
      if (type === "VP8X") {
        if (size < 10) {
          return null;
        }
        extendedAt = out.length;
      }
      writeRiffChunk(out, bytes, offset, dataEnd);
    } else if (type === "EXIF" && !exifSeen) {
      exifSeen = true;
      orientation = readOrientation(bytes.subarray(offset + 8, dataEnd));
    }

    offset = chunkEnd;
  }
  if (offset !== end || out.length === 12) {
    return null;
  }

  if (extendedAt !== null) {
    if (orientation !== null) {
      const exif = minimalExif(orientation);
      const head = Buffer.alloc(8);
      head.write("EXIF", 0, "latin1");
      head.writeUInt32LE(exif.length, 4);
      out.write(head);
      out.write(exif);
    }
    // Flags describe the chunks that follow, so they have to follow what is
    // actually left.
    const flags = extendedAt + 8;
    out.setByte(
      flags,
      (out.byteAt(flags) & ~(VP8X_FLAG_XMP | VP8X_FLAG_EXIF)) |
        (orientation === null ? 0 : VP8X_FLAG_EXIF),
    );
  }
  // EXIF is only defined in the extended format; a simple file is left
  // without it rather than upgraded.

  out.setUInt32LE(4, out.length - 8);
  return out.result();
}

/**
 * Writes an animation frame with its header, its transparency and its picture
 * only, and its size made to match; false for a frame that cannot be followed.
 *
 * A frame holds chunks of its own, and may hold ones nobody defined after its
 * picture, so an XMP chunk can sit inside a frame as well as beside it.
 */
function writeWebpFrame(
  out: StrippedImage,
  bytes: Buffer,
  offset: number,
  dataEnd: number,
): boolean {
  const chunksStart = offset + 8 + WEBP_FRAME_HEADER_LENGTH;
  if (chunksStart > dataEnd) {
    return false;
  }
  const frameAt = out.length;
  out.write(bytes, offset, chunksStart);

  let pictures = 0;
  let at = chunksStart;
  while (at < dataEnd) {
    if (!out.count() || at + 8 > dataEnd) {
      return false;
    }
    const type = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const chunkDataEnd = at + 8 + size;
    // Inside a frame the padding is never optional: the frame's size counts it.
    const chunkEnd = chunkDataEnd + (size % 2);
    if (chunkEnd > dataEnd) {
      return false;
    }
    if (WEBP_FRAME_CHUNKS.has(type)) {
      writeRiffChunk(out, bytes, at, chunkDataEnd);
      if (type !== "ALPH") {
        pictures += 1;
      }
    }
    at = chunkEnd;
  }

  out.setUInt32LE(frameAt + 4, out.length - frameAt - 8);
  return pictures === 1;
}

/* ------------------------------------------------------------------- GIF */

/** Application extensions that make the picture move; others (XMP among them) carry data about it. */
const GIF_KEPT_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

const GIF_TERMINATOR = Buffer.alloc(1);

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
  const out = new StrippedImage(bytes);
  out.write(bytes, 0, offset);

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

  /**
   * Writes an extension from its start up to its first data sub-block, that
   * sub-block and a terminator: what the extensions kept here define is a
   * single sub-block, and any after it is room for something else. Writes
   * nothing when there is no data sub-block.
   */
  const writeFirstSubBlock = (start: number, subBlock: number): void => {
    const size = bytes[subBlock] ?? 0;
    if (size > 0) {
      out.write(bytes, start, subBlock + 1 + size);
      out.write(GIF_TERMINATOR);
    }
  };

  while (offset < bytes.length) {
    const introducer = bytes[offset];

    if (introducer === 0x3b) {
      out.write(bytes, offset, offset + 1);
      return out.result();
    }
    if (!out.count()) {
      return null;
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
        // Graphic control: the frame's delay, disposal and transparency.
        writeFirstSubBlock(offset, offset + 2);
      } else if (label === 0xff) {
        // The identifier is the first sub-block, eleven bytes long.
        const application = bytes.toString("latin1", offset + 3, offset + 14);
        if (
          bytes[offset + 2] === 11 &&
          GIF_KEPT_APPLICATIONS.has(application)
        ) {
          writeFirstSubBlock(offset, offset + 14);
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
      out.write(bytes, offset, end);
      offset = end;
      continue;
    }

    return null;
  }

  return null;
}
