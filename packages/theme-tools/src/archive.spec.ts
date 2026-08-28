import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  MAX_ARCHIVE_ENTRIES,
  readThemeArchive,
  ThemeArchiveError,
  writeThemeArchive,
} from "./archive.ts";

/**
 * The archive reader is pointed at third-party content downloaded from a
 * catalog, so the tests that matter are the refusals: a path that escapes the
 * package, an entry that is not a file, and an archive that expands without
 * bound.
 */

const encoder = new TextEncoder();

function pack(entries: Record<string, string>): Uint8Array {
  return writeThemeArchive(
    new Map(
      Object.entries(entries).map(([path, content]) => [
        path,
        encoder.encode(content),
      ]),
    ),
  );
}

function unpack(archive: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder("utf8");
  return Object.fromEntries(
    [...readThemeArchive(archive)].map(([path, content]) => [
      path,
      decoder.decode(content),
    ]),
  );
}

/** A raw ustar header, so a test can write one the writer refuses to produce. */
function rawHeader(options: {
  name: string;
  size: number;
  typeFlag: string;
}): Uint8Array {
  const header = new Uint8Array(512);
  const write = (value: string, start: number): void => {
    header.set(encoder.encode(value), start);
  };
  write(options.name, 0);
  write("0000644\0", 100);
  write("0000000\0", 108);
  write("0000000\0", 116);
  write(`${options.size.toString(8).padStart(11, "0")}\0`, 124);
  write("00000000000\0", 136);
  write("        ", 148);
  write(options.typeFlag, 156);
  write("ustar\0", 257);
  write("00", 263);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function rawArchive(blocks: readonly Uint8Array[]): Uint8Array {
  const all = [...blocks, new Uint8Array(1024)];
  const total = all.reduce((sum, block) => sum + block.length, 0);
  const tarball = new Uint8Array(total);
  let offset = 0;
  for (const block of all) {
    tarball.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(gzipSync(tarball, { level: 9 }));
}

describe("writeThemeArchive and readThemeArchive", () => {
  it("round-trips files", () => {
    const archive = pack({
      "theme.json": '{"name":"example-theme"}',
      "fonts/body.woff2": "not really a font",
    });

    expect(unpack(archive)).toEqual({
      "theme.json": '{"name":"example-theme"}',
      "fonts/body.woff2": "not really a font",
    });
  });

  it("packs the same files into the same bytes", () => {
    // The catalog identifies a package by its sha512, so packing twice has to
    // produce identical bytes or the checksum means nothing.
    const first = pack({ "theme.json": "{}", "readme.md": "hello" });
    const second = pack({ "readme.md": "hello", "theme.json": "{}" });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("strips the single directory the package is rooted at", () => {
    const archive = pack({
      "example-theme/theme.json": "{}",
      "example-theme/fonts/body.woff2": "font",
    });

    expect(Object.keys(unpack(archive)).sort()).toEqual([
      "fonts/body.woff2",
      "theme.json",
    ]);
  });

  it("keeps paths when entries do not share a root", () => {
    const archive = pack({ "theme.json": "{}", "fonts/body.woff2": "font" });
    expect(Object.keys(unpack(archive)).sort()).toEqual([
      "fonts/body.woff2",
      "theme.json",
    ]);
  });

  it("refuses to pack a path that escapes the package", () => {
    expect(() =>
      writeThemeArchive(new Map([["../outside.json", encoder.encode("{}")]])),
    ).toThrow(ThemeArchiveError);
  });
});

describe("readThemeArchive refusals", () => {
  it("refuses an entry whose path escapes the package", () => {
    const archive = rawArchive([
      rawHeader({ name: "../../etc/passwd", size: 0, typeFlag: "0" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/escapes the package/);
  });

  it("refuses an absolute path", () => {
    const archive = rawArchive([
      rawHeader({ name: "/etc/passwd", size: 0, typeFlag: "0" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/absolute/);
  });

  it("refuses a symbolic link", () => {
    const archive = rawArchive([
      rawHeader({ name: "logo.png", size: 0, typeFlag: "2" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/not a regular file/);
  });

  it("skips directory entries rather than treating them as files", () => {
    const archive = rawArchive([
      rawHeader({ name: "fonts", size: 0, typeFlag: "5" }),
      rawHeader({ name: "theme.json", size: 2, typeFlag: "0" }),
      (() => {
        const block = new Uint8Array(512);
        block.set(encoder.encode("{}"), 0);
        return block;
      })(),
    ]);

    expect(unpack(archive)).toEqual({ "theme.json": "{}" });
  });

  it("refuses more entries than the cap allows", () => {
    const files = new Map<string, Uint8Array>();
    for (let index = 0; index <= MAX_ARCHIVE_ENTRIES; index += 1) {
      files.set(`file-${String(index)}.txt`, encoder.encode("x"));
    }
    expect(() => readThemeArchive(writeThemeArchive(files))).toThrow(
      /more than/,
    );
  });

  it("refuses something that is not a gzip archive", () => {
    expect(() => readThemeArchive(encoder.encode("not an archive"))).toThrow(
      /not a gzip archive/,
    );
  });

  it("refuses a corrupt header", () => {
    const header = rawHeader({ name: "theme.json", size: 0, typeFlag: "0" });
    header[0] = 0x41;
    expect(() => readThemeArchive(rawArchive([header]))).toThrow(/corrupt/);
  });
});
