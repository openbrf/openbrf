import { describe, expect, it } from "vitest";

import { readImageHeader } from "./image-bytes";
import {
  gifBytes,
  jpegBytes,
  pngBytes,
  webpLosslessBytes,
  webpLossyBytes,
} from "./testing/image-fixtures";

/**
 * Identifying a file from its bytes.
 *
 * The cases that matter are the negative ones. An upload declares its own
 * content type and carries its own file name, and both are written by whoever
 * sent it, so the only thing standing between "this is a PNG" and a browser
 * executing something else is this function.
 */

describe("reading an image header", () => {
  it("identifies a PNG and its dimensions", () => {
    expect(readImageHeader(pngBytes(120, 40))).toEqual({
      contentType: "image/png",
      width: 120,
      height: 40,
    });
  });

  it("identifies a JPEG and its dimensions", () => {
    expect(readImageHeader(jpegBytes(64, 32))).toEqual({
      contentType: "image/jpeg",
      width: 64,
      height: 32,
    });
  });

  it("identifies a lossy WebP and its dimensions", () => {
    expect(readImageHeader(webpLossyBytes(300, 100))).toEqual({
      contentType: "image/webp",
      width: 300,
      height: 100,
    });
  });

  it("identifies a lossless WebP and its dimensions", () => {
    expect(readImageHeader(webpLosslessBytes(48, 24))).toEqual({
      contentType: "image/webp",
      width: 48,
      height: 24,
    });
  });

  it("identifies a GIF and its dimensions", () => {
    expect(readImageHeader(gifBytes(16, 16))).toEqual({
      contentType: "image/gif",
      width: 16,
      height: 16,
    });
  });

  it("refuses an SVG, which is a document that can carry script", () => {
    /*
     * Deliberately not supported. These files are served from the housing
     * cooperative's own origin, and a vector image that a browser treats as a
     * document is a way to run script there. A logo ships as a raster image.
     */
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8",
    );

    expect(readImageHeader(svg)).toBeNull();
  });

  it("refuses HTML wearing an image's name", () => {
    expect(readImageHeader(Buffer.from("<html><body>hi", "utf8"))).toBeNull();
  });

  it("refuses a file that is only a PNG signature", () => {
    // The magic bytes alone are not evidence: without a coherent header there
    // is nothing to check the dimensions against.
    const signature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    expect(readImageHeader(signature)).toBeNull();
  });

  it("refuses a PNG whose first chunk is not the header chunk", () => {
    const bytes = pngBytes(10, 10);
    bytes.write("IDAT", 12, "latin1");

    expect(readImageHeader(bytes)).toBeNull();
  });

  it("refuses a WebP without the key frame sync code", () => {
    const bytes = webpLossyBytes(10, 10);
    bytes[24] = 0x00;

    expect(readImageHeader(bytes)).toBeNull();
  });

  it("refuses an empty file", () => {
    expect(readImageHeader(Buffer.alloc(0))).toBeNull();
  });

  it("refuses a canvas far larger than anything that would be uploaded", () => {
    // A header can declare a size that costs nothing to send and a great deal
    // to decode.
    expect(readImageHeader(pngBytes(60_000, 60_000))).toBeNull();
  });

  it("refuses a zero-sized canvas", () => {
    expect(readImageHeader(pngBytes(0, 10))).toBeNull();
  });
});
