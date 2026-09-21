/**
 * The part of sodium-native 5.1.0 that stored-file-cipher.ts uses, typed.
 *
 * The package ships no types, and the published ones describe the 2.x API, in
 * which the secretstream tags are one-byte buffers. In 5.1.0 they are numbers:
 * pushed as a number, and written by a pull into a one-byte out-parameter whose
 * first byte is compared against the same number.
 */
declare module "sodium-native" {
  interface SodiumNative {
    readonly crypto_secretstream_xchacha20poly1305_KEYBYTES: number;
    readonly crypto_secretstream_xchacha20poly1305_HEADERBYTES: number;
    readonly crypto_secretstream_xchacha20poly1305_ABYTES: number;
    readonly crypto_secretstream_xchacha20poly1305_STATEBYTES: number;
    readonly crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: number;
    readonly crypto_secretstream_xchacha20poly1305_TAG_FINAL: number;

    crypto_secretstream_xchacha20poly1305_keygen(key: Uint8Array): void;
    crypto_secretstream_xchacha20poly1305_init_push(
      state: Uint8Array,
      header: Uint8Array,
      key: Uint8Array,
    ): void;
    crypto_secretstream_xchacha20poly1305_push(
      state: Uint8Array,
      ciphertext: Uint8Array,
      message: Uint8Array,
      additionalData: Uint8Array | null,
      tag: number,
    ): number;
    crypto_secretstream_xchacha20poly1305_init_pull(
      state: Uint8Array,
      header: Uint8Array,
      key: Uint8Array,
    ): void;
    crypto_secretstream_xchacha20poly1305_pull(
      state: Uint8Array,
      message: Uint8Array,
      tag: Uint8Array,
      ciphertext: Uint8Array,
      additionalData: Uint8Array | null,
    ): number;
  }

  const sodium: SodiumNative;
  export = sodium;
}
