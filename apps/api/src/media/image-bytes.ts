/**
 * What a file actually is, read from its bytes.
 *
 * The content type an upload declares and the extension its name carries are
 * both written by the client, so neither is evidence. A file stored as
 * image/png because the request said so is served back with that type later,
 * and a browser will do whatever the real bytes tell it to - which is how an
 * "image" upload becomes a script running on the association's own origin.
 *
 * So the type is decided here, from the header, and the declared one is only
 * ever compared against this answer.
 *
 * Reading the dimensions out of the same header is not a convenience: it is the
 * evidence that the header is coherent rather than a few magic bytes glued to
 * the front of something else, and it is what lets an absurd canvas be refused
 * before anything tries to render it.
 */

export interface ImageHeader {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

/**
 * Largest canvas accepted, per side.
 *
 * A compressed image declares its dimensions in the header and only costs what
 * it decodes to. 20000 is far past any logo or photograph a housing cooperative
 * uploads and far below the point where a thumbnailer would exhaust a
 * container's memory.
 */
const MAX_DIMENSION = 20_000;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Identifies the bytes, or null when they are not a supported image. */
export function readImageHeader(bytes: Buffer): ImageHeader | null {
  const header =
    readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes) ?? readGif(bytes);

  if (header === null) {
    return null;
  }
  if (
    header.width < 1 ||
    header.height < 1 ||
    header.width > MAX_DIMENSION ||
    header.height > MAX_DIMENSION
  ) {
    return null;
  }
  return header;
}

function readPng(bytes: Buffer): ImageHeader | null {
  // Signature, then the length and type of the first chunk, then IHDR's own
  // 13 bytes. Anything shorter cannot carry the dimensions.
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  // IHDR is required by the format to be the first chunk, so a file whose
  // first chunk is something else is malformed rather than merely unusual.
  if (bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  return {
    contentType: "image/png",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/**
 * Markers that stand alone: they carry no length and no payload, so the scan
 * steps over the marker itself rather than over a segment.
 */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/** Start-of-frame markers, which are the ones carrying the dimensions. */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    // Not frames: DHT (c4), JPG extension (c8) and DAC (cc).
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readJpeg(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
    return null;
  }

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Out of step with the segment structure: this is not a JPEG whose
      // dimensions can be trusted, whatever the first two bytes said.
      return null;
    }

    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      // Fill byte before the next marker.
      offset += 1;
      continue;
    }
    if (isStandaloneMarker(marker)) {
      offset += 2;
      continue;
    }

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) {
      return null;
    }

    if (isStartOfFrame(marker)) {
      // precision (1 byte), height (2), width (2), after the segment length.
      if (offset + 9 > bytes.length) {
        return null;
      }
      return {
        contentType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readWebp(bytes: Buffer): ImageHeader | null {
  if (
    bytes.length < 30 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunk = bytes.toString("latin1", 12, 16);

  if (chunk === "VP8 ") {
    // Lossy: a three-byte frame tag, then the sync code, then two 14-bit
    // dimensions. The sync code is what distinguishes a real key frame.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return {
      contentType: "image/webp",
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) {
      return null;
    }
    // 14 bits of width and 14 of height, minus one each, packed little-endian
    // across the four bytes after the signature.
    const packed = bytes.readUInt32LE(21);
    return {
      contentType: "image/webp",
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === "VP8X") {
    // Extended: the canvas size, as two 24-bit little-endian values minus one.
    return {
      contentType: "image/webp",
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }

  return null;
}

function readGif(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 10) {
    return null;
  }
  const signature = bytes.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  return {
    contentType: "image/gif",
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}
