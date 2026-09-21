import { Transform, type TransformCallback } from "node:stream";

import sodium from "sodium-native";

/**
 * Stored files, encrypted at rest (ADR 0015).
 *
 * libsodium's crypto_secretstream_xchacha20poly1305: one file split into
 * chunks, each chunk authenticated, their order fixed, and the last one tagged
 * final so that a file cut short is told apart from a whole one. The code here
 * decides nothing cryptographic. It buffers bytes to chunk boundaries, counts
 * them, and refuses what libsodium does not verify.
 *
 * The object format: the 24-byte header, then each chunk of
 * STORED_FILE_CHUNK_BYTES of the file followed by its 17-byte tag, the last
 * chunk holding the rest of the file and tagged final. Nothing else is written,
 * and no additional data is bound into a chunk: the key belongs to one file
 * alone, so an object moved under another file's row does not verify there.
 *
 * This is the only file in the API that imports sodium-native, the rule the
 * field encryption keeps for ciphersweet-js, so that moving both onto one
 * libsodium build later is a change in two files.
 */

/** Plaintext bytes in every chunk but the last. */
export const STORED_FILE_CHUNK_BYTES = 64 * 1024;

/**
 * The content type an encrypted object is stored under, whatever the file is.
 * The file's own type is on its row; the storage sees ciphertext and is told
 * so.
 */
export const SEALED_FILE_CONTENT_TYPE = "application/octet-stream";

const KEY_BYTES = sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES;
const HEADER_BYTES = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
const TAG_BYTES = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
const STATE_BYTES = sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES;
const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

/** A chunk as stored: its plaintext and the tag libsodium appends. */
const SEALED_CHUNK_BYTES = STORED_FILE_CHUNK_BYTES + TAG_BYTES;

/**
 * A sealed file that does not open: a header, a chunk or an ending that does
 * not verify, or a length other than the row records. The message names which,
 * and never carries a byte of the file.
 */
export class SealedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedFileError";
  }
}

/** A new key for one file: random bytes from libsodium. */
export function newFileKey(): Buffer {
  const key = Buffer.alloc(KEY_BYTES);
  sodium.crypto_secretstream_xchacha20poly1305_keygen(key);
  return key;
}

/** The length of a sealed file, from the length of the file. */
export function sealedLength(plaintextBytes: number): number {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 1) {
    throw new RangeError("A sealed file holds at least one byte.");
  }
  const chunks = Math.ceil(plaintextBytes / STORED_FILE_CHUNK_BYTES);
  return HEADER_BYTES + plaintextBytes + chunks * TAG_BYTES;
}

/**
 * Seals a whole file held in memory, as an upload is: the secretstream header,
 * then each chunk with its tag, the last tagged final.
 *
 * An empty file is a programming error: the media service refuses one before
 * it gets here, and a stream of no chunks would have no final tag to show that
 * it is whole.
 */
export function sealFile(plaintext: Buffer, key: Buffer): Buffer {
  assertKey(key);
  const sealed = Buffer.alloc(sealedLength(plaintext.length));
  const state = Buffer.alloc(STATE_BYTES);

  sodium.crypto_secretstream_xchacha20poly1305_init_push(
    state,
    sealed.subarray(0, HEADER_BYTES),
    key,
  );

  let read = 0;
  let written = HEADER_BYTES;
  while (read < plaintext.length) {
    const end = Math.min(read + STORED_FILE_CHUNK_BYTES, plaintext.length);
    const message = plaintext.subarray(read, end);
    const chunk = sealed.subarray(
      written,
      written + message.length + TAG_BYTES,
    );
    sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      chunk,
      message,
      null,
      end === plaintext.length ? TAG_FINAL : TAG_MESSAGE,
    );
    read = end;
    written += chunk.length;
  }

  return sealed;
}

/**
 * Opens a sealed file as it streams.
 *
 * Emits a chunk's plaintext only after libsodium has verified that chunk.
 * Fails the stream, and never ends it cleanly, on: a header or chunk that does
 * not verify; a final tag with bytes after it; an end with no final tag; and a
 * total that is not `plaintextBytes`.
 */
export function openSealedFile(key: Buffer, plaintextBytes: number): Transform {
  assertKey(key);
  return new SealedFileOpener(key, plaintextBytes);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`A file key is ${String(KEY_BYTES)} bytes.`);
  }
}

class SealedFileOpener extends Transform {
  private readonly state = Buffer.alloc(STATE_BYTES);
  /** Where libsodium writes the tag of the chunk it has just verified. */
  private readonly tag = Buffer.alloc(1);
  /** Bytes that arrived and are not yet a whole header or chunk. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private headerRead = false;
  private finalOpened = false;
  private openedBytes = 0;

  constructor(
    private readonly key: Buffer,
    private readonly plaintextBytes: number,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      this.openAvailable(false);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.openAvailable(true);
      if (!this.finalOpened) {
        throw new SealedFileError(
          "The sealed file ends before its last chunk.",
        );
      }
      if (this.openedBytes !== this.plaintextBytes) {
        throw new SealedFileError(
          "The sealed file holds fewer bytes than its row records.",
        );
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  /**
   * Opens every whole chunk that has arrived.
   *
   * Every chunk but the last is exactly SEALED_CHUNK_BYTES, so a chunk of that
   * length is opened as soon as it is here and its tag says whether it was the
   * last. Anything shorter is opened only once the input has ended, and has to
   * be the last.
   */
  private openAvailable(ended: boolean): void {
    if (!this.headerRead) {
      if (this.pendingBytes < HEADER_BYTES) {
        if (ended) {
          throw new SealedFileError(
            "The sealed file is shorter than its header.",
          );
        }
        return;
      }
      sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        this.state,
        this.takePending(HEADER_BYTES),
        this.key,
      );
      this.headerRead = true;
    }

    while (
      this.pendingBytes >= SEALED_CHUNK_BYTES ||
      (ended && this.pendingBytes > 0)
    ) {
      if (this.finalOpened) {
        throw new SealedFileError(
          "The sealed file continues after its last chunk.",
        );
      }
      this.openChunk(
        this.takePending(Math.min(this.pendingBytes, SEALED_CHUNK_BYTES)),
      );
    }
  }

  private openChunk(sealed: Buffer): void {
    if (sealed.length <= TAG_BYTES) {
      throw new SealedFileError("A chunk of the sealed file is truncated.");
    }

    const message = Buffer.alloc(sealed.length - TAG_BYTES);
    try {
      sodium.crypto_secretstream_xchacha20poly1305_pull(
        this.state,
        message,
        this.tag,
        sealed,
        null,
      );
    } catch {
      throw new SealedFileError(
        "A chunk of the sealed file does not verify under its key.",
      );
    }

    // The tag is a number in the pinned sodium-native and is compared as one;
    // a comparison written for the 3.x Buffer would never match here.
    const tag = this.tag[0];
    if (tag === TAG_FINAL) {
      this.finalOpened = true;
    } else if (tag !== TAG_MESSAGE || sealed.length !== SEALED_CHUNK_BYTES) {
      // Never written by sealFile: a chunk before the last is full length and
      // carries the message tag, and no other tag is ever pushed.
      throw new SealedFileError(
        "A chunk of the sealed file is not one this format writes.",
      );
    }

    if (this.openedBytes + message.length > this.plaintextBytes) {
      throw new SealedFileError(
        "The sealed file holds more bytes than its row records.",
      );
    }
    this.openedBytes += message.length;
    this.push(message);
  }

  /** The next `length` pending bytes, which the caller has checked are here. */
  private takePending(length: number): Buffer {
    const pending =
      this.pending.length === 1
        ? (this.pending[0] as Buffer)
        : Buffer.concat(this.pending, this.pendingBytes);
    const rest = pending.subarray(length);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
    return pending.subarray(0, length);
  }
}
