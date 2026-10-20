import { describe, expect, it } from "vite-plus/test";

import { readImageHeader } from "./image-bytes";
import { stripImageMetadata } from "./image-metadata";
import {
  exifWithGps,
  GPS_MARKER,
  gifBytes,
  jpegBytes,
  jpegMetadataSegments,
  jpegSegment,
  pngBytes,
  pngChunk,
  webpLosslessBytes,
  webpLossyBytes,
} from "./testing/image-fixtures";

/**
 * Taking metadata out of an image.
 *
 * Every case asserts two things: that what identifies a person is gone, by
 * looking for the text the fixture hid in it, and that the picture is still the
 * same picture, by reading the header back and comparing the bytes that make
 * it up.
 */

function strip(bytes: Buffer): Buffer {
  const header = readImageHeader(bytes);
  const stripped = stripImageMetadata(bytes, header?.contentType ?? "");
  if (stripped === null) {
    throw new Error("The fixture could not be followed.");
  }
  return stripped;
}

function holdsMarker(bytes: Buffer): boolean {
  return bytes.includes(GPS_MARKER);
}

/** The orientation of a stored JPEG, read the way a viewer does: from its APP1. */
function jpegOrientation(bytes: Buffer): number | null {
  const at = bytes.indexOf(Buffer.from("Exif\0\0", "latin1"));
  if (at < 0) {
    return null;
  }
  const tiff = bytes.subarray(at + 6);
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (offset: number) =>
    little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const directory = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  for (let index = 0; index < u16(directory); index += 1) {
    const entry = directory + 2 + index * 12;
    if (u16(entry) === 0x0112) {
      return u16(entry + 8);
    }
  }
  return null;
}

describe("a JPEG", () => {
  it("loses its GPS position, XMP, IPTC and comment", () => {
    const original = jpegBytes(64, 32, jpegMetadataSegments());
    expect(holdsMarker(original)).toBe(true);

    const stripped = strip(original);

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.includes("xmpmeta")).toBe(false);
    expect(stripped.includes("Photoshop")).toBe(false);
    // Nothing about the position, not even the pointer to where it was.
    expect(stripped.includes("Exif")).toBe(false);
  });

  it("is byte for byte what it was when there was nothing to remove", () => {
    const plain = jpegBytes(64, 32);

    expect(strip(plain).equals(plain)).toBe(true);
  });

  it("keeps the same picture under the same header", () => {
    const stripped = strip(jpegBytes(64, 32, jpegMetadataSegments()));

    expect(readImageHeader(stripped)).toEqual({
      contentType: "image/jpeg",
      width: 64,
      height: 32,
    });
    // The scan, with its stuffed ff 00, and the end of the image.
    expect(stripped.subarray(-6)).toEqual(
      Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]),
    );
  });

  it.each([2, 3, 6, 8])(
    "keeps orientation %i, so a portrait photo does not turn on its side",
    (orientation) => {
      const stripped = strip(
        jpegBytes(64, 32, jpegMetadataSegments(orientation)),
      );

      expect(jpegOrientation(stripped)).toBe(orientation);
      expect(holdsMarker(stripped)).toBe(false);
    },
  );

  it("drops an orientation that says nothing", () => {
    const stripped = strip(jpegBytes(64, 32, jpegMetadataSegments(1)));

    expect(jpegOrientation(stripped)).toBeNull();
  });

  it("keeps a colour profile", () => {
    const profile = jpegSegment(
      0xe2,
      Buffer.from("ICC_PROFILE\0\x01\x01profile-bytes", "latin1"),
    );

    const stripped = strip(jpegBytes(64, 32, [profile]));

    expect(stripped.includes(profile)).toBe(true);
  });

  it("drops the thumbnail a JFIF header announces", () => {
    const withThumbnail = jpegBytes(64, 32);
    // Start of image (2), marker and length (4), then the payload; the
    // thumbnail dimensions are its last two bytes.
    withThumbnail[18] = 1;
    withThumbnail[19] = 1;

    const stripped = strip(withThumbnail);

    expect(stripped.equals(jpegBytes(64, 32))).toBe(true);
  });

  it("drops what follows the end of the image, where a motion photo keeps its video", () => {
    const trailer = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegMetadataSegments()[0] as Buffer,
      Buffer.from("trailing video"),
    ]);

    const stripped = strip(Buffer.concat([jpegBytes(64, 32), trailer]));

    expect(stripped.equals(jpegBytes(64, 32))).toBe(true);
  });

  it("is refused when it ends before the image does", () => {
    const plain = jpegBytes(64, 32, jpegMetadataSegments());

    expect(
      stripImageMetadata(plain.subarray(0, plain.length - 2), "image/jpeg"),
    ).toBeNull();
  });

  it("is refused when a segment claims more than the file holds", () => {
    const cut = jpegBytes(64, 32, jpegMetadataSegments()).subarray(0, 40);

    expect(stripImageMetadata(cut, "image/jpeg")).toBeNull();
  });
});

describe("a PNG", () => {
  const textChunks = [
    pngChunk("tEXt", Buffer.from(`Comment\0${GPS_MARKER}`, "latin1")),
    pngChunk(
      "iTXt",
      Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${GPS_MARKER}`, "latin1"),
    ),
    pngChunk("zTXt", Buffer.from("Comment\0\0compressed", "latin1")),
    pngChunk("tIME", Buffer.from([7, 234, 10, 20, 12, 0, 0])),
    pngChunk("eXIf", exifWithGps()),
  ];

  it("loses its text, XMP, timestamp and EXIF chunks", () => {
    const original = pngBytes(120, 40, 4, textChunks);
    expect(holdsMarker(original)).toBe(true);

    const stripped = strip(original);

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.equals(pngBytes(120, 40))).toBe(true);
  });

  it("keeps the chunks the picture is drawn with", () => {
    const palette = pngChunk("PLTE", Buffer.from([1, 2, 3]));
    const gamma = pngChunk("gAMA", Buffer.from([0, 1, 0x86, 0xa0]));
    const original = pngBytes(10, 10, 4, [palette, ...textChunks, gamma]);

    const stripped = strip(original);

    expect(stripped.equals(pngBytes(10, 10, 4, [palette, gamma]))).toBe(true);
  });

  it("keeps an orientation, in an EXIF chunk of its own", () => {
    const stripped = strip(
      pngBytes(10, 10, 4, [pngChunk("eXIf", exifWithGps(6))]),
    );

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.includes("eXIf")).toBe(true);
    expect(stripped.equals(pngBytes(10, 10))).toBe(false);
  });

  it("drops what follows IEND", () => {
    const trailing = Buffer.concat([pngBytes(10, 10), Buffer.from(GPS_MARKER)]);

    expect(strip(trailing).equals(pngBytes(10, 10))).toBe(true);
  });

  it("is refused without its end", () => {
    const plain = pngBytes(10, 10);

    expect(
      stripImageMetadata(plain.subarray(0, plain.length - 12), "image/png"),
    ).toBeNull();
  });

  it("is refused when a chunk claims more than the file holds", () => {
    const plain = pngBytes(10, 10);

    expect(stripImageMetadata(plain.subarray(0, 40), "image/png")).toBeNull();
  });
});

describe("a WebP", () => {
  /** An extended WebP: VP8X, the picture, then the given chunks. */
  function extendedWebp(flags: number, chunks: Buffer[]): Buffer {
    const canvas = Buffer.alloc(18);
    canvas.write("VP8X", 0, "latin1");
    canvas.writeUInt32LE(10, 4);
    canvas[8] = flags;
    canvas.writeUIntLE(63, 12, 3);
    canvas.writeUIntLE(31, 15, 3);

    const picture = webpLossyBytes(64, 32).subarray(12);
    const body = Buffer.concat([canvas, picture, ...chunks]);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(body.length + 4, 4);
    head.write("WEBP", 8, "latin1");
    return Buffer.concat([head, body]);
  }

  function riffChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    const pad = data.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1);
    return Buffer.concat([head, data, pad]);
  }

  const metadata = [
    riffChunk("EXIF", exifWithGps()),
    riffChunk(
      "XMP ",
      Buffer.from(`<x:xmpmeta>${GPS_MARKER}</x:xmpmeta>`, "latin1"),
    ),
  ];

  it("loses its EXIF and XMP chunks and says so in its flags", () => {
    const original = extendedWebp(0x08 | 0x04, metadata);
    expect(holdsMarker(original)).toBe(true);

    const stripped = strip(original);

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.equals(extendedWebp(0, []))).toBe(true);
  });

  it("keeps the flags that are not about metadata", () => {
    const stripped = strip(extendedWebp(0x10 | 0x08 | 0x04, metadata));

    expect(stripped.equals(extendedWebp(0x10, []))).toBe(true);
  });

  it("keeps an orientation, with the flag that announces it", () => {
    const stripped = strip(
      extendedWebp(0x08, [riffChunk("EXIF", exifWithGps(3))]),
    );

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.includes("EXIF")).toBe(true);
    expect(stripped[20] ? stripped[20] & 0x08 : 0).toBe(0x08);
    expect(stripped.readUInt32LE(4) + 8).toBe(stripped.length);
  });

  it.each([
    ["lossy", webpLossyBytes(300, 100)],
    ["lossless", webpLosslessBytes(48, 24)],
  ])(
    "is byte for byte what it was when %s with nothing to remove",
    (_, plain) => {
      expect(strip(plain).equals(plain)).toBe(true);
    },
  );

  it("is refused when a chunk claims more than the file holds", () => {
    const original = extendedWebp(0x08, metadata);
    // The RIFF size is left as it was, so the file ends inside the EXIF chunk.
    const cut = original.subarray(0, original.length - 20);

    expect(stripImageMetadata(cut, "image/webp")).toBeNull();
  });
});

describe("a GIF", () => {
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe, GPS_MARKER.length]),
    Buffer.from(GPS_MARKER, "latin1"),
    Buffer.from([0]),
  ]);
  const xmp = Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from("XMP DataXMP", "latin1"),
    Buffer.from([GPS_MARKER.length]),
    Buffer.from(GPS_MARKER, "latin1"),
    Buffer.from([0]),
  ]);
  const loop = Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from("NETSCAPE2.0", "latin1"),
    Buffer.from([3, 1, 0, 0, 0]),
  ]);
  const image = Buffer.concat([
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
  ]);

  it("loses its comments and XMP, and keeps its loop and its frames", () => {
    const original = gifBytes(1, 1, [comment, loop, xmp, image]);
    expect(holdsMarker(original)).toBe(true);

    const stripped = strip(original);

    expect(holdsMarker(stripped)).toBe(false);
    expect(stripped.equals(gifBytes(1, 1, [loop, image]))).toBe(true);
  });

  it("is refused without its trailer", () => {
    const plain = gifBytes(1, 1, [image]);

    expect(
      stripImageMetadata(plain.subarray(0, plain.length - 1), "image/gif"),
    ).toBeNull();
  });
});

describe("a type it does not know", () => {
  it("is refused rather than passed through", () => {
    expect(
      stripImageMetadata(Buffer.from("%PDF-1.4"), "application/pdf"),
    ).toBeNull();
  });
});
