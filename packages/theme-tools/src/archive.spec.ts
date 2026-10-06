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
  /** Bytes written over the header before its checksum is computed. */
  patches?: readonly { start: number; bytes: readonly number[] }[];
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
  for (const patch of options.patches ?? []) {
    header.set(patch.bytes, patch.start);
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

  it("reads the numeric fields of GNU tar, bsdtar and older tars", () => {
    // Trailing space instead of a NUL, leading spaces, and blank fields.
    const archive = rawArchive([
      rawHeader({
        name: "theme.json",
        size: 0,
        typeFlag: "0",
        patches: [
          { start: 100, bytes: [...encoder.encode("   644 \0")] },
          { start: 108, bytes: [...encoder.encode("0001750 ")] },
          { start: 116, bytes: [...encoder.encode("        ")] },
          { start: 136, bytes: [...encoder.encode("14013235625 ")] },
          { start: 329, bytes: [...encoder.encode("0000000 ")] },
        ],
      }),
    ]);
    expect(unpack(archive)).toEqual({ "theme.json": "" });
  });

  it("reads a name with multibyte characters", () => {
    const archive = rawArchive([
      rawHeader({ name: "fonts/Åkesson.woff2", size: 0, typeFlag: "0" }),
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
    ]);
    expect(Object.keys(unpack(archive)).sort()).toEqual([
      "fonts/Åkesson.woff2",
      "theme.json",
    ]);
  });

  it("keeps a byte order mark, so it does not merge two names", () => {
    const archive = rawArchive([
      rawHeader({ name: "\uFEFFtheme.json", size: 0, typeFlag: "0" }),
      rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
    ]);
    expect(Object.keys(unpack(archive)).sort()).toEqual([
      "theme.json",
      "\uFEFFtheme.json",
    ]);
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

  describe("a malformed numeric field in a later header", () => {
    const NO_BREAK_SPACE = [0xc2, 0xa0];
    const fields = [
      { field: "mode", start: 100, length: 8 },
      { field: "uid", start: 108, length: 8 },
      { field: "gid", start: 116, length: 8 },
      { field: "mtime", start: 136, length: 12 },
      { field: "devmajor", start: 329, length: 8 },
      { field: "devminor", start: 337, length: 8 },
    ];
    const malformed = [
      { form: "a non-octal digit", bytes: [...encoder.encode("00008\0")] },
      { form: "trailing text", bytes: [...encoder.encode("0644x\0")] },
      { form: "a second number", bytes: [...encoder.encode("12 34\0")] },
      { form: "a sign", bytes: [...encoder.encode("-1\0")] },
      {
        form: "a no-break space a text trim would drop",
        bytes: [0x31, ...NO_BREAK_SPACE, 0],
      },
      { form: "a GNU base-256 value", bytes: [0x80, 0, 0, 0, 0, 0, 1, 0] },
    ];

    for (const { field, start } of fields) {
      for (const { form, bytes } of malformed) {
        it(`refuses ${form} in ${field}`, () => {
          const archive = rawArchive([
            rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
            rawHeader({
              name: "hidden.json",
              size: 0,
              typeFlag: "0",
              patches: [{ start, bytes }],
            }),
          ]);
          expect(() => readThemeArchive(archive)).toThrow(
            "The archive has a malformed numeric field.",
          );
        });
      }
    }

    it("refuses a malformed checksum field", () => {
      const header = rawHeader({ name: "hidden.json", size: 0, typeFlag: "0" });
      header.set([0x30, 0x30, 0x31, 0x32, 0xc2, 0xa0, 0, 0x20], 148);
      const archive = rawArchive([
        rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
        header,
      ]);
      expect(() => readThemeArchive(archive)).toThrow(
        "The archive has a malformed numeric field.",
      );
    });

    it("refuses a malformed size field", () => {
      const archive = rawArchive([
        rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
        rawHeader({
          name: "hidden.json",
          size: 0,
          typeFlag: "0",
          patches: [{ start: 124, bytes: [0x31, ...NO_BREAK_SPACE, 0] }],
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(
        "The archive has a malformed numeric field.",
      );
    });
  });

  describe("names that are not UTF-8", () => {
    const invalidName = [0x61, 0xff, 0x62, 0];

    it("refuses an invalid byte in a name in a later header", () => {
      // Read without fatal decoding, 0xff and 0xfe both become U+FFFD and
      // these two names are one path.
      const archive = rawArchive([
        rawHeader({ name: "theme.json", size: 0, typeFlag: "0" }),
        rawHeader({
          name: "x",
          size: 0,
          typeFlag: "0",
          patches: [{ start: 0, bytes: invalidName }],
        }),
        rawHeader({
          name: "x",
          size: 0,
          typeFlag: "0",
          patches: [{ start: 0, bytes: [0x61, 0xfe, 0x62, 0] }],
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(
        "The archive has a name that is not UTF-8.",
      );
    });

    it("refuses an invalid byte in a prefix", () => {
      const archive = rawArchive([
        rawHeader({
          name: "theme.json",
          size: 0,
          typeFlag: "0",
          patches: [{ start: 345, bytes: invalidName }],
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(
        "The archive has a name that is not UTF-8.",
      );
    });

    it("refuses an invalid byte in a directory name", () => {
      const archive = rawArchive([
        rawHeader({
          name: "x",
          size: 0,
          typeFlag: "5",
          patches: [{ start: 0, bytes: invalidName }],
        }),
      ]);
      expect(() => readThemeArchive(archive)).toThrow(
        "The archive has a name that is not UTF-8.",
      );
    });
  });
});
