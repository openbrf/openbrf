/**
 * Minimal images, built byte by byte.
 *
 * Headers only, with just enough structure to be identified: what the upload
 * path checks is the header, so a real encoder would add megabytes of pixel
 * data that no assertion here looks at. Building them also makes the negative
 * cases possible, since a corrupted header has to be constructible.
 */

/** A PNG: the signature, an IHDR chunk, and nothing else. */
export function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: truecolour with alpha
  return bytes;
}

/** A JPEG: start of image, an APP0 segment to step over, then a frame. */
export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(18, 2);
  app0.write("JFIF\0", 4, "latin1");

  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(9, 2);
  frame[4] = 8; // sample precision
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 1; // one component
  frame[10] = 1;

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
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

export function gifBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}
