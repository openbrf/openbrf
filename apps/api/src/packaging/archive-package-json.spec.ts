import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { extract } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArchivePackageJson } from "./archive-package-json";

/**
 * The installer reads an archive's package.json with this before npm sees the
 * archive, so the property under test is agreement with npm: whatever this
 * returns is the package.json npm would act on, and an archive it does not
 * return that for is refused.
 *
 * npm's reading is reproduced below as pacote does it - node-tar, not strict,
 * the top directory stripped, links dropped, only files written - and every
 * archive here is checked against it.
 */

const run = promisify(execFile);

let directory: string;
let scratch: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-archive-json-"));
  scratch = join(directory, "scratch");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Entry {
  /** The name field, as bytes when it has to hold something odd. */
  path: string | Buffer;
  body?: string | Buffer;
  type?: string;
  prefix?: string;
  linkname?: string;
  /** The checksum written without the terminator tar tools add. */
  unterminatedChecksum?: boolean;
}

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  (typeof entry.path === "string"
    ? Buffer.from(entry.path, "utf8")
    : entry.path
  ).copy(block, 0, 0, 100);
  block.write("0000644\0", 100, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write(entry.type ?? "0", 156, "ascii");
  block.write(entry.linkname ?? "", 157, 100, "utf8");
  block.write("ustar\u000000", 257, "binary");
  block.write(entry.prefix ?? "", 345, 155, "utf8");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(
    entry.unterminatedChecksum === true
      ? sum.toString(8).padStart(8, "0")
      : `${sum.toString(8).padStart(6, "0")}\0 `,
    148,
    "ascii",
  );
  return block;
}

/** One entry as it sits in an archive: its header, its body, its padding. */
function entryBytes(entry: Entry): Buffer {
  const body = Buffer.isBuffer(entry.body)
    ? entry.body
    : Buffer.from(entry.body ?? "", "utf8");
  return Buffer.concat([
    header(entry, body.length),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

/** A gzipped tar archive holding exactly `entries`, in order. */
async function archive(entries: Entry[]): Promise<string> {
  const path = join(directory, `archive-${String(Math.random())}.tgz`);
  await writeFile(
    path,
    gzipSync(Buffer.concat([...entries.map(entryBytes), Buffer.alloc(1024)])),
  );
  return path;
}

function pax(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      // The length counts its own digits.
      const record = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(record);
      while (String(length).length + Buffer.byteLength(record) !== length) {
        length = String(length).length + Buffer.byteLength(record);
      }
      return `${String(length)}${record}`;
    })
    .join("");
}

/** The package.json npm reads from `path`, or undefined when there is none. */
async function npmReads(path: string): Promise<unknown> {
  const cwd = join(directory, `npm-${String(Math.random())}`);
  await mkdir(cwd);
  await extract({
    file: path,
    cwd,
    strip: 1,
    preserveOwner: false,
    noChmod: true,
    noMtime: true,
    onwarn: () => {
      // pacote logs these and carries on.
    },
    filter: (_path, entry) => {
      if (!("type" in entry) || !entry.type.endsWith("File")) {
        return false;
      }
      entry.mode = (entry.mode ?? 0) | 0o600;
      return true;
    },
  });
  try {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** What the reader makes of `path`: the package.json, or the refusal. */
function read(path: string): Promise<unknown> {
  return readArchivePackageJson(path, scratch).catch((cause: unknown) => cause);
}

const manifest = JSON.stringify({ name: "openbrf-plugin-x", version: "1.0.0" });

/** A second package.json, declaring what the first one does not. */
const smuggled = JSON.stringify({
  name: "openbrf-plugin-x",
  version: "1.0.0",
  dependencies: { x: "file:../x" },
});

const root = { path: "package/package.json", body: manifest };

describe("readArchivePackageJson", () => {
  it("reads the package.json of an archive npm packed", async () => {
    const source = join(directory, "source");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "openbrf-plugin-packed",
        version: "2.1.0",
        dependencies: { "local-package": "file:/elsewhere" },
      }),
    );
    await writeFile(join(source, "dist", "server.cjs"), "module.exports={}\n");
    const { stdout } = await run(
      "npm",
      ["pack", "--json", "--pack-destination", directory],
      { cwd: source },
    );
    const packed = JSON.parse(stdout) as { filename: string }[];

    await expect(
      readArchivePackageJson(
        join(directory, packed[0]?.filename ?? ""),
        scratch,
      ),
    ).resolves.toMatchObject({
      name: "openbrf-plugin-packed",
      version: "2.1.0",
      dependencies: { "local-package": "file:/elsewhere" },
    });
  });

  it("reads past the files in front of it", async () => {
    const path = await archive([
      { path: "package/dist/server.cjs", body: "x".repeat(70_000) },
      root,
    ]);

    await expect(readArchivePackageJson(path, scratch)).resolves.toEqual(
      JSON.parse(manifest),
    );
  });

  it("does not take a nested package.json for the package's own", async () => {
    const path = await archive([
      { path: "package/node_modules/x/package.json", body: "{}" },
      root,
    ]);

    await expect(readArchivePackageJson(path, scratch)).resolves.toEqual(
      JSON.parse(manifest),
    );
  });

  it("follows a pax path, as npm does", async () => {
    const path = await archive([
      {
        path: "PaxHeader",
        type: "x",
        body: pax({ path: "package/package.json" }),
      },
      { path: "package/innocent.txt", body: manifest },
    ]);

    await expect(readArchivePackageJson(path, scratch)).resolves.toEqual(
      JSON.parse(manifest),
    );
  });

  it("leaves nothing unpacked behind", async () => {
    const path = await archive([root]);

    await readArchivePackageJson(path, scratch);

    await expect(readFile(join(scratch, "package.json"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("refuses a corrupt header", async () => {
    const path = join(directory, "corrupt.tgz");
    await writeFile(path, gzipSync(Buffer.alloc(512, 0x41)));

    await expect(readArchivePackageJson(path, scratch)).rejects.toThrow();
  });

  it("refuses an archive with no package.json", async () => {
    const path = await archive([{ path: "package/index.js", body: "" }]);

    await expect(readArchivePackageJson(path, scratch)).rejects.toThrow(
      "holds no package.json",
    );
  });

  it("refuses a package.json that is a link, which npm does not unpack", async () => {
    const path = await archive([
      { path: "package/package.json", type: "2", linkname: "elsewhere" },
    ]);

    await expect(readArchivePackageJson(path, scratch)).rejects.toThrow(
      "holds no package.json",
    );
  });

  it("refuses a package.json that is not JSON", async () => {
    const path = await archive([
      { path: "package/package.json", body: "{ not json" },
    ]);

    await expect(readArchivePackageJson(path, scratch)).rejects.toThrow(
      "not valid JSON",
    );
  });
});

/**
 * Archives holding a plain package.json and, after it, a second one only some
 * tar readers take for the package's own. npm keeps the one it unpacks last,
 * so whatever the reader returns has to be what npm reads - here, the copy
 * declaring a dependency - or the archive has to be refused.
 */
describe("readArchivePackageJson against npm", () => {
  // A whole entry, held as the body of another so only some readers see it.
  const carried = entryBytes({ path: "package/package.json", body: smuggled });

  it.each<[string, Entry[], boolean]>([
    // Each case says whether npm reaches the second copy at all: where it
    // does, the case is one a reader could get wrong.
    ["the same path twice", [root, { ...root, body: smuggled }], true],
    [
      "a copy behind a dot segment",
      [root, { path: "package/./package.json", body: smuggled }],
      true,
    ],
    [
      "a copy behind a doubled slash",
      [root, { path: "package//package.json", body: smuggled }],
      true,
    ],
    [
      "a copy under another top directory",
      [root, { path: "other/package.json", body: smuggled }],
      true,
    ],
    [
      "a copy a ustar prefix places",
      [root, { path: "package.json", prefix: "package", body: smuggled }],
      true,
    ],
    [
      "a name that continues past a NUL",
      [
        root,
        {
          path: Buffer.from(`\0\n${"/".repeat(86)}package.json`, "binary"),
          body: smuggled,
        },
      ],
      true,
    ],
    [
      "a pax path broken by a newline",
      [
        root,
        {
          path: "PaxHeader",
          type: "x",
          body: pax({ path: "package/x\ny" }),
        },
        { path: "package/package.json", body: smuggled },
      ],
      true,
    ],
    [
      "a pax path that continues past a NUL",
      [
        root,
        {
          path: "PaxHeader",
          type: "x",
          body: pax({ path: "package/package.json\0z" }),
        },
        { path: "package/other", body: smuggled },
      ],
      true,
    ],
    [
      "a Windows drive in the path",
      [root, { path: "package/c:package.json", body: smuggled }],
      true,
    ],
    [
      "a backslash in the top directory",
      [root, { path: "pkg\\x/package.json", body: smuggled }],
      true,
    ],
    [
      "a file entry carrying a link name",
      [
        root,
        {
          path: "package/carrier",
          linkname: "anything",
          body: carried,
        },
      ],
      true,
    ],
    [
      "a checksum that runs into the type",
      [
        root,
        {
          path: "package/carrier",
          unterminatedChecksum: true,
          body: carried,
        },
      ],
      true,
    ],
    [
      "a global pax record",
      [{ path: "pax_global", type: "g", body: pax({ comment: "x" }) }, root],
      false,
    ],
    [
      "a GNU long name",
      [
        root,
        { path: "././@LongLink", type: "L", body: "package/package.json" },
        { path: "package/other", body: smuggled },
      ],
      true,
    ],
    [
      "a directory entry that carries content",
      [root, { path: "package/dist/", type: "5", body: carried }],
      true,
    ],
  ])(
    "returns what npm reads, or refuses, for %s",
    async (_case, entries, reaches) => {
      const path = await archive(entries);
      const npm = await npmReads(path);

      // The fixture does what it says: npm ends up with the copy it expects.
      expect(npm).toEqual(JSON.parse(reaches ? smuggled : manifest));

      const result = await read(path);
      if (!(result instanceof Error)) {
        expect(result).toEqual(npm);
      }
      if (reaches) {
        expect(result).not.toEqual(JSON.parse(manifest));
      }
    },
  );
});
