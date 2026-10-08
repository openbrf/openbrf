import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  MAX_ARCHIVE_ENTRIES,
  MAX_DIRECTORY_RECORDS,
  MAX_TARBALL_BYTES,
  MAX_TOTAL_BYTES,
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
  prefix?: string;
  ustar?: boolean;
  /** Raw bytes to write over the header at an offset, before the checksum. */
  overwrite?: Record<number, Uint8Array>;
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
  if (options.ustar ?? true) {
    write("ustar\0", 257);
    write("00", 263);
  }
  write(options.prefix ?? "", 345);
  for (const [start, bytes] of Object.entries(options.overwrite ?? {})) {
    header.set(bytes, Number(start));
  }

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function dataBlock(content: string): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(content), 0);
  return block;
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
      dataBlock("{}"),
    ]);

    expect(unpack(archive)).toEqual({ "theme.json": "{}" });
  });

  it("refuses a directory entry that states a size", () => {
    // tar and Python's tarfile read the "data" as the next header, so they
    // would list hidden.json where this reader used to skip over it.
    const archive = rawArchive([
      rawHeader({ name: "fonts", size: 512, typeFlag: "5" }),
      rawHeader({ name: "hidden.json", size: 0, typeFlag: "0" }),
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(
      "The archive has a directory entry that states a size.",
    );
  });

  it("refuses a header after a lone zero block", () => {
    // tar and Python's tarfile stop at the first zero block and would never
    // show hidden.json.
    const archive = rawArchive([
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
      new Uint8Array(512),
      rawHeader({ name: "hidden.json", size: 0, typeFlag: "0" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(
      "The archive has a lone zero block before its last entry.",
    );
  });

  it("accepts an archive that ends with a single zero block", () => {
    const tarball = new Uint8Array(1024);
    tarball.set(rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }), 0);
    expect(unpack(new Uint8Array(gzipSync(tarball)))).toEqual({
      "theme.json": "",
    });
  });

  it("joins the prefix to the name in a ustar header", () => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        prefix: "example-theme",
        size: 0,
        typeFlag: "0",
      }),
      rawHeader({ name: "readme.md", size: 0, typeFlag: "0" }),
    ]);
    expect(Object.keys(unpack(archive)).sort()).toEqual([
      "example-theme/theme.json",
      "readme.md",
    ]);
  });

  it("refuses a prefix in a header without the ustar magic", () => {
    // bsdtar and GNU tar list this as theme.json, Python's tarfile as
    // example-theme/theme.json.
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        prefix: "example-theme",
        size: 0,
        typeFlag: "0",
        ustar: false,
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(
      "The archive has a path prefix in a header that is not ustar.",
    );
  });

  it("refuses a prefix in a directory header without the ustar magic", () => {
    const archive = rawArchive([
      rawHeader({
        name: "fonts",
        prefix: "example-theme",
        size: 0,
        typeFlag: "5",
        ustar: false,
      }),
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(
      "The archive has a path prefix in a header that is not ustar.",
    );
  });

  it("reads a ustar directory header that has a prefix", () => {
    const archive = rawArchive([
      rawHeader({
        name: "fonts",
        prefix: "example-theme",
        size: 0,
        typeFlag: "5",
      }),
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
    ]);
    expect(unpack(archive)).toEqual({ "theme.json": "" });
  });

  it("reads a header without the ustar magic by its name", () => {
    const archive = rawArchive([
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0", ustar: false }),
    ]);
    expect(unpack(archive)).toEqual({ "theme.json": "" });
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

  it("counts every file record toward the cap, repeated paths included", () => {
    const records = (count: number): Uint8Array =>
      rawArchive(
        Array.from({ length: count }, () =>
          rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
        ),
      );

    expect(() => readThemeArchive(records(MAX_ARCHIVE_ENTRIES + 1))).toThrow(
      `The archive contains more than ${String(MAX_ARCHIVE_ENTRIES)} files.`,
    );
    expect([...readThemeArchive(records(MAX_ARCHIVE_ENTRIES)).keys()]).toEqual([
      "theme.json",
    ]);
  });

  it("caps directory records apart from files", () => {
    const directories = (count: number): Uint8Array =>
      rawArchive(
        Array.from({ length: count }, (_, index) =>
          rawHeader({ name: `d-${String(index)}`, size: 0, typeFlag: "5" }),
        ),
      );

    expect(() =>
      readThemeArchive(directories(MAX_DIRECTORY_RECORDS + 1)),
    ).toThrow(
      `The archive contains more than ${String(MAX_DIRECTORY_RECORDS)} directory entries.`,
    );
    expect(readThemeArchive(directories(MAX_DIRECTORY_RECORDS)).size).toBe(0);
  });

  it("unzips the largest package tar writes within the limits", () => {
    // Every file and directory the limits allow, each file in its own folder,
    // content adding up to the total cap with as much block padding as the
    // sizes allow, and the tarball padded out to a whole tar record.
    const blocks: Uint8Array[] = [];
    let remaining = MAX_TOTAL_BYTES;
    for (let index = 0; index < MAX_ARCHIVE_ENTRIES; index += 1) {
      const size = index === MAX_ARCHIVE_ENTRIES - 1 ? remaining : 81 * 512 + 1;
      remaining -= size;
      blocks.push(
        rawHeader({ name: `d-${String(index)}`, size: 0, typeFlag: "5" }),
        rawHeader({ name: `d-${String(index)}/f`, size, typeFlag: "0" }),
        new Uint8Array(Math.ceil(size / 512) * 512),
      );
    }
    blocks.push(new Uint8Array(1024));
    const length = blocks.reduce((sum, block) => sum + block.length, 0);
    const tarball = new Uint8Array(Math.ceil(length / 10240) * 10240);
    let offset = 0;
    for (const block of blocks) {
      tarball.set(block, offset);
      offset += block.length;
    }

    expect(tarball.length).toBeLessThanOrEqual(MAX_TARBALL_BYTES);
    // Past what the files alone could occupy, so the directories' share of
    // the ceiling is what lets it through.
    expect(tarball.length).toBeGreaterThan(
      MAX_TARBALL_BYTES - MAX_DIRECTORY_RECORDS * 512,
    );
    const files = readThemeArchive(new Uint8Array(gzipSync(tarball)));
    expect(files.size).toBe(MAX_ARCHIVE_ENTRIES);
  });

  it("refuses a small gzip that inflates past the cap", () => {
    const bomb = new Uint8Array(
      gzipSync(new Uint8Array(MAX_TARBALL_BYTES + 1)),
    );
    expect(bomb.length).toBeLessThan(MAX_TARBALL_BYTES / 100);
    expect(() => readThemeArchive(bomb)).toThrow(ThemeArchiveError);
    expect(() => readThemeArchive(bomb)).toThrow(/It was not unpacked/);
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

  it("refuses a header whose checksum matches only the signed sum", () => {
    const header = rawHeader({ name: "theme.json", size: 0, typeFlag: "0" });
    // One byte of 0x80 or more makes the signed and unsigned sums differ by
    // 256. node-tar computes only the unsigned one and would skip this header.
    header[300] = 0xff;
    let signed = 0;
    for (const [index, byte] of header.entries()) {
      const value = index >= 148 && index < 156 ? 0x20 : byte;
      signed += value > 127 ? value - 256 : value;
    }
    header.set(
      encoder.encode(`${signed.toString(8).padStart(6, "0")}\0 `),
      148,
    );
    expect(() => readThemeArchive(rawArchive([header]))).toThrow(/corrupt/);
  });

  it("reads a header with a byte >= 0x80 and the unsigned checksum", () => {
    // "ö" is 0xc3 0xb6 in UTF-8, so the signed and unsigned sums of this header
    // differ by 512. A reader that sign-extended bytes would refuse it.
    const name = "fonts/Brödtext.css";
    const content = "body{}";
    const header = rawHeader({ name, size: content.length, typeFlag: "0" });
    expect(header.some((byte) => byte >= 0x80)).toBe(true);

    // A second root keeps the reader from stripping "fonts/".
    const manifest = rawHeader({ name: "theme.json", size: 2, typeFlag: "0" });

    expect(
      unpack(
        rawArchive([header, dataBlock(content), manifest, dataBlock("{}")]),
      ),
    ).toEqual({ [name]: content, "theme.json": "{}" });
  });

  it("keeps a name with a leading byte order mark apart from the plain one", () => {
    const files = readThemeArchive(
      rawArchive([
        rawHeader({ name: "theme.json", size: 1, typeFlag: "0" }),
        dataBlock("a"),
        rawHeader({ name: "\ufefftheme.json", size: 1, typeFlag: "0" }),
        dataBlock("b"),
      ]),
    );
    expect([...files.keys()].sort()).toEqual([
      "theme.json",
      "\ufefftheme.json",
    ]);
  });

  it("refuses a byte order mark as the prefix of a header without the ustar magic", () => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        ustar: false,
        overwrite: { 345: new Uint8Array([0xef, 0xbb, 0xbf]) },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(
      "The archive has a path prefix in a header that is not ustar.",
    );
  });

  it("refuses a name that is not UTF-8", () => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        overwrite: { 0: new Uint8Array([0xff]) },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/not UTF-8/);
  });

  const octalFields: [string, number][] = [
    ["size", 124],
    ["mtime", 136],
    ["mode", 100],
    ["uid", 108],
    ["gid", 116],
    ["devmajor", 329],
    ["devminor", 337],
  ];
  const badOctal: [string, Uint8Array][] = [
    ["a letter", encoder.encode("12x4")],
    ["a non-breaking space", new Uint8Array([0x31, 0xc2, 0xa0, 0x31])],
    ["a tab", encoder.encode("1\t2")],
    ["an 8", encoder.encode("8")],
  ];
  const badOctalCases = octalFields.flatMap(([field, at]) =>
    badOctal.map(([label, bad]) => [field, at, label, bad] as const),
  );

  it.each(badOctalCases)(
    "refuses a %s field with %s",
    (_field, at, _label, bad) => {
      const archive = rawArchive([
        rawHeader({
          name: "theme.json",
          size: 0,
          typeFlag: "0",
          overwrite: { [at]: bad },
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(/malformed numeric/);
    },
  );

  const nulLeads = ["\0", "\0\0", " \0"];
  const nulCases = octalFields.flatMap(([field, at]) =>
    nulLeads.map((lead) => [field, at, JSON.stringify(lead), lead] as const),
  );

  it.each(nulCases)(
    "refuses a %s field with a NUL before the digits (%s)",
    (_field, at, _label, lead) => {
      const archive = rawArchive([
        rawHeader({
          name: "theme.json",
          size: 0,
          typeFlag: "0",
          overwrite: { [at]: encoder.encode(`${lead}0002000`) },
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(/malformed numeric/);
    },
  );

  it("refuses a checksum with a leading NUL on a header that is not the first", () => {
    const second = rawHeader({ name: "evil.js", size: 0, typeFlag: "0" });
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (second[index] ?? 0);
    }
    second.set(encoder.encode(`\0${sum.toString(8).padStart(5, "0")}\0 `), 148);
    const archive = rawArchive([
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
      second,
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/malformed numeric/);
  });

  it("reads base-256 uid and a negative mtime, as GNU tar writes them", () => {
    const uid = new Uint8Array(8);
    uid[0] = 0x80;
    uid.set([0x2d, 0xc6, 0xc0], 5);
    const mtime = new Uint8Array(12).fill(0xff);
    mtime[11] = 0x9c;
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 1,
        typeFlag: "0",
        overwrite: { 108: uid, 136: mtime },
      }),
      dataBlock("a"),
    ]);
    expect([...readThemeArchive(archive).keys()]).toEqual(["theme.json"]);
  });

  it.each([
    ["uid", 108, new Uint8Array(8).fill(0xff).fill(0x80, 0, 1)],
    ["mtime", 136, new Uint8Array(12).fill(0).fill(0xff, 0, 1)],
  ])("refuses a base-256 %s beyond a safe integer", (_, at, bytes) => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        overwrite: { [at]: bytes },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/malformed numeric/);
  });

  it("refuses a base-256 checksum", () => {
    const header = rawHeader({ name: "theme.json", size: 0, typeFlag: "0" });
    const checksumOf = () => {
      let total = 0;
      for (let index = 0; index < 512; index += 1) {
        total += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
      }
      return total;
    };
    // Make the low byte a NUL, so the field reaches the numeric decoder.
    header[500] = (256 - (checksumOf() % 256)) % 256;
    const sum = checksumOf();
    header.set([0x80, 0, 0, 0, 0, 0, sum >> 8, sum & 0xff], 148);
    expect(() => readThemeArchive(rawArchive([header]))).toThrow(
      /malformed numeric/,
    );
  });

  it("refuses an eight-digit checksum with no terminator", () => {
    const header = rawHeader({ name: "theme.json", size: 0, typeFlag: "0" });
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    header.set(encoder.encode(sum.toString(8).padStart(8, "0")), 148);
    expect(() => readThemeArchive(rawArchive([header]))).toThrow(
      /corrupt header/,
    );
  });

  it.each([
    ["x", "theme.json"],
    ["\0\nx", "theme.json"],
    ["x", "assets"],
  ])("refuses a file or directory with linkname %j", (linkname, name) => {
    const isDirectory = name === "assets";
    const archive = rawArchive([
      rawHeader({
        name,
        size: 0,
        typeFlag: isDirectory ? "5" : "0",
        overwrite: { 157: encoder.encode(linkname) },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/link name/);
  });

  it("refuses a . segment in a path the writer is given", () => {
    expect(() =>
      writeThemeArchive(new Map([["a/./b", new Uint8Array(1)]])),
    ).toThrow(/"\." segment/);
  });

  it("refuses a base-256 size", () => {
    const size = new Uint8Array(12);
    size[0] = 0x80;
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        overwrite: { 124: size },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/malformed numeric/);
  });

  it("refuses theme.json next to ./theme.json", () => {
    const archive = rawArchive([
      rawHeader({ name: "theme.json", size: 1, typeFlag: "0" }),
      dataBlock("a"),
      rawHeader({ name: "./theme.json", size: 1, typeFlag: "0" }),
      dataBlock("b"),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/"\." segment/);
  });

  it("refuses a . segment inside a path", () => {
    const archive = rawArchive([
      rawHeader({ name: "a/./b", size: 1, typeFlag: "0" }),
      dataBlock("a"),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/"\." segment/);
  });

  it("reads an archive whose every name is ./-prefixed", () => {
    const archive = rawArchive([
      rawHeader({ name: "./", size: 0, typeFlag: "5" }),
      rawHeader({ name: "./theme.json", size: 1, typeFlag: "0" }),
      dataBlock("a"),
      rawHeader({ name: "./fonts/body.woff2", size: 1, typeFlag: "0" }),
      dataBlock("b"),
    ]);
    expect([...readThemeArchive(archive).keys()].sort()).toEqual([
      "fonts/body.woff2",
      "theme.json",
    ]);
  });

  it.each([
    ["name", 0, "theme.json\0\nX"],
    ["prefix", 345, "pkg\0\nX"],
  ])("refuses a %s with bytes after its first NUL", (_, at, value) => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        overwrite: { [at]: encoder.encode(value) },
      }),
    ]);
    expect(() => readThemeArchive(archive)).toThrow(/after its end/);
  });

  it("reads numeric fields padded with spaces and NULs", () => {
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 1,
        typeFlag: "0",
        overwrite: {
          100: encoder.encode("  644 \0\0"),
          136: new Uint8Array(12),
        },
      }),
      dataBlock("a"),
    ]);
    expect([...readThemeArchive(archive).keys()]).toEqual(["theme.json"]);
  });
});
