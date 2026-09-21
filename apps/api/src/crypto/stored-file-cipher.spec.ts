import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";

import {
  newFileKey,
  openSealedFile,
  SealedFileError,
  sealedLength,
  sealFile,
  STORED_FILE_CHUNK_BYTES,
} from "./stored-file-cipher";
import {
  SEALED_FIXTURE,
  SEALED_FIXTURE_KEY,
  SEALED_FIXTURE_PLAINTEXT_BYTES,
  sealedFixturePlaintext,
} from "./testing/sealed-file-fixture";

/**
 * The stored-file cipher, with the real libsodium.
 *
 * What these cases are for is the code around libsodium, which is ours: it
 * cuts arriving bytes into chunks, decides when the stream may end, and counts.
 * Each refusal below is a way that code could otherwise hand out bytes that
 * were never verified, or end cleanly on a file that is not whole.
 */

const CHUNK = STORED_FILE_CHUNK_BYTES;
const HEADER = 24;
const TAG = 17;
const SEALED_CHUNK = CHUNK + TAG;

interface Opened {
  /** Every byte the stream emitted, whether or not it then failed. */
  emitted: Buffer;
  error: unknown;
}

/**
 * Feeds sealed bytes through the opener in the slices given, and keeps what
 * came out before any failure, because the property under test is as much
 * what was not emitted as whether the stream failed.
 */
async function open(
  slices: Buffer[],
  key: Buffer,
  plaintextBytes: number,
): Promise<Opened> {
  const opener = openSealedFile(key, plaintextBytes);
  const emitted: Buffer[] = [];
  opener.on("data", (chunk: Buffer) => {
    emitted.push(chunk);
  });
  try {
    await pipeline(Readable.from(slices), opener);
    return { emitted: Buffer.concat(emitted), error: null };
  } catch (error) {
    return { emitted: Buffer.concat(emitted), error };
  }
}

function slicesOf(bytes: Buffer, size: number): Buffer[] {
  const slices: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    slices.push(bytes.subarray(offset, offset + size));
  }
  return slices;
}

/** A copy with one bit of the byte at `offset` flipped. */
function flipped(bytes: Buffer, offset: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[offset] = (copy[offset] ?? 0) ^ 0x01;
  return copy;
}

/** Where the sealed form of chunk `index` starts. */
function chunkOffset(index: number): number {
  return HEADER + index * SEALED_CHUNK;
}

describe("sealing and opening", () => {
  it.each([
    ["one byte", 1],
    ["one byte short of a chunk", CHUNK - 1],
    ["exactly one chunk", CHUNK],
    ["one byte over a chunk", CHUNK + 1],
    ["exactly three chunks", 3 * CHUNK],
    ["ten mebibytes", 10 * 1024 * 1024],
  ])("round-trips %s, at the length sealedLength states", async (_, size) => {
    const plaintext = randomBytes(size);
    const key = newFileKey();

    const sealed = sealFile(plaintext, key);
    const opened = await open([sealed], key, size);

    expect(sealed.length).toBe(sealedLength(size));
    expect(opened.error).toBeNull();
    expect(opened.emitted.equals(plaintext)).toBe(true);
  });

  it("does not hold the file in the clear", () => {
    const plaintext = Buffer.alloc(3 * CHUNK, "stadgar ");
    const sealed = sealFile(plaintext, newFileKey());

    expect(sealed.includes(Buffer.from("stadgar "))).toBe(false);
  });

  it("opens the same whether the sealed bytes arrive a byte at a time or a mebibyte at a time", async () => {
    const plaintext = randomBytes(2 * CHUNK + 5);
    const key = newFileKey();
    const sealed = sealFile(plaintext, key);

    const byByte = await open(slicesOf(sealed, 1), key, plaintext.length);
    const byMebibyte = await open(
      slicesOf(sealed, 1024 * 1024),
      key,
      plaintext.length,
    );

    expect(byByte.error).toBeNull();
    expect(byMebibyte.error).toBeNull();
    expect(byByte.emitted.equals(plaintext)).toBe(true);
    expect(byMebibyte.emitted.equals(plaintext)).toBe(true);
  });

  it("seals one file differently each time", () => {
    const plaintext = randomBytes(1000);
    const key = newFileKey();

    expect(sealFile(plaintext, key).equals(sealFile(plaintext, key))).toBe(
      false,
    );
  });

  it("opens the committed fixture to its plaintext", async () => {
    // Sealed by an earlier build. A library that can no longer open it would
    // lose every file an instance holds.
    const opened = await open(
      [Buffer.from(SEALED_FIXTURE, "base64")],
      Buffer.from(SEALED_FIXTURE_KEY, "hex"),
      SEALED_FIXTURE_PLAINTEXT_BYTES,
    );

    expect(opened.error).toBeNull();
    expect(opened.emitted.equals(sealedFixturePlaintext())).toBe(true);
  });
});

describe("the final chunk", () => {
  /*
   * The tag libsodium writes is a number in the pinned sodium-native and a
   * one-byte Buffer in 3.x, and a comparison written for the other form never
   * matches. These two cases fail in opposite directions if it does not: a
   * whole file would be refused for lacking its final tag, and a file cut at a
   * chunk boundary would be accepted as whole.
   */
  it("ends cleanly on a file whose last chunk is full length and tagged final", async () => {
    const plaintext = randomBytes(2 * CHUNK);
    const key = newFileKey();

    const opened = await open([sealFile(plaintext, key)], key, 2 * CHUNK);

    expect(opened.error).toBeNull();
    expect(opened.emitted.equals(plaintext)).toBe(true);
  });

  it("refuses a file cut at a chunk boundary before its final chunk", async () => {
    const plaintext = randomBytes(3 * CHUNK + 10);
    const key = newFileKey();
    const sealed = sealFile(plaintext, key);

    // Two whole chunks, each verifying on its own, and nothing after them.
    const cut = sealed.subarray(0, chunkOffset(2));
    const opened = await open([cut], key, plaintext.length);

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect((opened.error as Error).message).toMatch(/before its last chunk/);
  });

  it("refuses a file cut inside a chunk", async () => {
    const plaintext = randomBytes(2 * CHUNK + 10);
    const key = newFileKey();
    const sealed = sealFile(plaintext, key);

    const opened = await open(
      [sealed.subarray(0, chunkOffset(1) + 1000)],
      key,
      plaintext.length,
    );

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect(opened.emitted.equals(plaintext.subarray(0, CHUNK))).toBe(true);
  });

  it("refuses the last chunk truncated by a byte", async () => {
    const plaintext = randomBytes(CHUNK + 500);
    const key = newFileKey();
    const sealed = sealFile(plaintext, key);

    const opened = await open(
      [sealed.subarray(0, sealed.length - 1)],
      key,
      plaintext.length,
    );

    expect(opened.error).toBeInstanceOf(SealedFileError);
    // The first chunk verified and went out; nothing of the last one did.
    expect(opened.emitted.equals(plaintext.subarray(0, CHUNK))).toBe(true);
  });

  it("refuses a byte after the final chunk", async () => {
    const plaintext = randomBytes(CHUNK);
    const key = newFileKey();
    const sealed = sealFile(plaintext, key);

    const opened = await open(
      [sealed, Buffer.from([0])],
      key,
      plaintext.length,
    );

    expect(opened.error).toBeInstanceOf(SealedFileError);
  });
});

describe("a changed file", () => {
  const plaintext = randomBytes(3 * CHUNK + 100);
  const key = newFileKey();
  const sealed = sealFile(plaintext, key);

  it.each([
    ["the header", 5, 0],
    ["the first chunk's body", chunkOffset(0) + 10, 0],
    ["the first chunk's tag", chunkOffset(0) + SEALED_CHUNK - 3, 0],
    ["a middle chunk's body", chunkOffset(1) + 100, 1],
    ["the last chunk", sealed.length - 50, 3],
  ])(
    "is refused at %s, and nothing from that chunk on is emitted",
    async (_, offset, firstChangedChunk) => {
      const opened = await open(
        [flipped(sealed, offset)],
        key,
        plaintext.length,
      );

      expect(opened.error).toBeInstanceOf(SealedFileError);
      expect(
        opened.emitted.equals(plaintext.subarray(0, firstChangedChunk * CHUNK)),
      ).toBe(true);
    },
  );

  it("is refused when two chunks change places", async () => {
    const swapped = Buffer.concat([
      sealed.subarray(0, chunkOffset(0)),
      sealed.subarray(chunkOffset(1), chunkOffset(2)),
      sealed.subarray(chunkOffset(0), chunkOffset(1)),
      sealed.subarray(chunkOffset(2)),
    ]);

    const opened = await open([swapped], key, plaintext.length);

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect(opened.emitted.length).toBe(0);
  });

  it("is refused under another file's key, at the first chunk", async () => {
    const opened = await open([sealed], newFileKey(), plaintext.length);

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect(opened.emitted.length).toBe(0);
  });
});

describe("the length the row records", () => {
  const plaintext = randomBytes(2 * CHUNK + 100);
  const key = newFileKey();
  const sealed = sealFile(plaintext, key);

  it("fails at the end when the file is shorter than recorded", async () => {
    const opened = await open([sealed], key, plaintext.length + 1);

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect((opened.error as Error).message).toMatch(/fewer bytes/);
  });

  it("fails before emitting a chunk that would run past the recorded length", async () => {
    const opened = await open([sealed], key, CHUNK + 1);

    expect(opened.error).toBeInstanceOf(SealedFileError);
    expect(opened.emitted.equals(plaintext.subarray(0, CHUNK))).toBe(true);
  });
});

describe("what is refused before any bytes", () => {
  it("does not seal an empty file", () => {
    expect(() => sealFile(Buffer.alloc(0), newFileKey())).toThrow(RangeError);
  });

  it("does not take a key of the wrong length", () => {
    expect(() => sealFile(Buffer.from("x"), Buffer.alloc(16))).toThrow(
      RangeError,
    );
    expect(() => openSealedFile(Buffer.alloc(16), 1)).toThrow(RangeError);
  });

  it("refuses a file shorter than its header", async () => {
    const opened = await open([Buffer.alloc(HEADER - 1)], newFileKey(), 1);

    expect(opened.error).toBeInstanceOf(SealedFileError);
  });
});
