import { crc32 } from "node:zlib";

/**
 * Minimal images, built byte by byte.
 *
 * Headers only, with just enough structure to be identified: what the upload
 * path checks is the header, so a real encoder would add megabytes of pixel
 * data that no assertion here looks at. Building them also makes the negative
 * cases possible, since a corrupted header has to be constructible.
 */

/** One PNG chunk, with the checksum a decoder would check. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG: the signature, an IHDR chunk, some picture data and the end.
 *
 * The data is not a valid zlib stream, which nothing here decodes; it is
 * `payloadLength` bytes of a repeating pattern, for a test that wants a file
 * of several stored chunks. `extraChunks` go between the header and the data.
 */
export function pngBytes(
  width: number,
  height: number,
  payloadLength = 4,
  extraChunks: Buffer[] = [],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha

  const payload = Buffer.alloc(payloadLength);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...extraChunks,
    pngChunk("IDAT", payload),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG: start of image, a JFIF segment, any `segments` given, a frame, a scan
 * and the end of the image.
 */
export function jpegBytes(
  width: number,
  height: number,
  segments: Buffer[] = [],
): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");
  app0.writeUInt16BE(0x0102, 9); // version 1.02

  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(9, 2);
  frame[4] = 8; // sample precision
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 1; // one component
  frame[10] = 1;

  // Start of scan for the one component, then entropy-coded bytes in which
  // ff is stuffed as ff 00, and the end of the image.
  const scan = Buffer.from([
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff,
    0x00, 0x34,
  ]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    ...segments,
    frame,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A lossy WebP: the RIFF container, a VP8 chunk and its key frame header. */
export function webpLossyBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8 ", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  // Frame tag, then the key frame sync code.
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes;
}

/** A lossless WebP: a VP8L chunk with its 14-bit packed dimensions. */
export function webpLosslessBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8L", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes;
}

/** A GIF: the header, a screen descriptor and the trailer, with `blocks` before it. */
export function gifBytes(
  width: number,
  height: number,
  blocks: Buffer[] = [],
): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return Buffer.concat([bytes, ...blocks, Buffer.from([0x3b])]);
}

/** The text a metadata fixture hides in every format, which no stored file may still contain. */
export const GPS_MARKER = "GPSLatitude-59.3293N";

/**
 * An EXIF TIFF structure with a GPS directory, and an orientation when given.
 *
 * Little-endian, so that a reader which assumed the other byte order would
 * find nothing. The GPS directory holds the marker as an ASCII value, which is
 * what makes "the coordinates are gone" a search for a string.
 */
export function exifWithGps(orientation?: number): Buffer {
  const marker = Buffer.from(`${GPS_MARKER}\0`, "latin1");
  const entries = orientation === undefined ? 1 : 2;
  const ifd0Size = 2 + entries * 12 + 4;
  const gpsOffset = 8 + ifd0Size;
  const gpsSize = 2 + 12 + 4;
  const markerOffset = gpsOffset + gpsSize;

  const tiff = Buffer.alloc(markerOffset + marker.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);

  let at = 8;
  tiff.writeUInt16LE(entries, at);
  at += 2;
  if (orientation !== undefined) {
    tiff.writeUInt16LE(0x0112, at);
    tiff.writeUInt16LE(3, at + 2);
    tiff.writeUInt32LE(1, at + 4);
    tiff.writeUInt16LE(orientation, at + 8);
    at += 12;
  }
  // The pointer to the GPS directory, which tag order puts last.
  tiff.writeUInt16LE(0x8825, at);
  tiff.writeUInt16LE(4, at + 2);
  tiff.writeUInt32LE(1, at + 4);
  tiff.writeUInt32LE(gpsOffset, at + 8);

  tiff.writeUInt16LE(1, gpsOffset);
  tiff.writeUInt16LE(0x0002, gpsOffset + 2); // GPSLatitude
  tiff.writeUInt16LE(2, gpsOffset + 4); // ASCII
  tiff.writeUInt32LE(marker.length, gpsOffset + 6);
  tiff.writeUInt32LE(markerOffset, gpsOffset + 10);
  marker.copy(tiff, markerOffset);

  return tiff;
}

/** A JPEG application segment with a payload. */
export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** The metadata segments a phone camera writes: EXIF with GPS, XMP, IPTC and a comment. */
export function jpegMetadataSegments(orientation?: number): Buffer[] {
  return [
    jpegSegment(
      0xe1,
      Buffer.concat([
        Buffer.from("Exif\0\0", "latin1"),
        exifWithGps(orientation),
      ]),
    ),
    jpegSegment(
      0xe1,
      Buffer.from(
        `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS_MARKER}</x:xmpmeta>`,
        "latin1",
      ),
    ),
    jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${GPS_MARKER}`, "latin1")),
    jpegSegment(0xfe, Buffer.from(GPS_MARKER, "latin1")),
  ];
}
