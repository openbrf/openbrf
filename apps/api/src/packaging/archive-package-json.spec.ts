import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArchivePackageJson } from "./archive-package-json";

/**
 * The installer reads an archive's package.json with this before npm sees the
 * archive, so the property under test is agreement with npm: whatever this
 * returns is the package.json npm would act on, and an archive in which the
 * two could disagree is refused.
 */

const run = promisify(execFile);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-archive-json-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Entry {
  path: string;
  body?: string;
  type?: string;
  prefix?: string;
}

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.path, 0, 100, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write(entry.type ?? "0", 156, "ascii");
  block.write("ustar\u000000", 257, "binary");
  block.write(entry.prefix ?? "", 345, 155, "utf8");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A gzipped tar archive holding exactly `entries`, in order. */
async function archive(entries: Entry[]): Promise<string> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "", "utf8");
    blocks.push(header(entry, body.length), body);
    blocks.push(Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const path = join(directory, `archive-${String(Math.random())}.tgz`);
  await writeFile(path, gzipSync(Buffer.concat(blocks)));
  return path;
}

function pax(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      // The length counts its own digits.
      const record = ` ${key}=${value}\n`;
      let length = record.length;
      while (String(length).length + record.length !== length) {
        length = String(length).length + record.length;
      }
      return `${String(length)}${record}`;
    })
    .join("");
}

const manifest = JSON.stringify({ name: "openbrf-plugin-x", version: "1.0.0" });

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
      readArchivePackageJson(join(directory, packed[0]?.filename ?? "")),
    ).resolves.toMatchObject({
      name: "openbrf-plugin-packed",
      version: "2.1.0",
      dependencies: { "local-package": "file:/elsewhere" },
    });
  });

  it("reads past the files in front of it", async () => {
    const path = await archive([
      { path: "package/dist/server.cjs", body: "x".repeat(70_000) },
      { path: "package/package.json", body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).resolves.toEqual(
      JSON.parse(manifest),
    );
  });

  it("does not take a nested package.json for the package's own", async () => {
    const path = await archive([
      { path: "package/node_modules/x/package.json", body: "{}" },
      { path: "package/package.json", body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).resolves.toEqual(
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

    await expect(readArchivePackageJson(path)).resolves.toEqual(
      JSON.parse(manifest),
    );
  });

  /*
   * npm keeps whichever copy it unpacks last, and the copies need not agree:
   * the first could declare nothing and the last a dependency.
   */
  it.each([
    ["the same path twice", "package/package.json"],
    ["a copy differing in case", "package/Package.json"],
    ["a copy behind a dot segment", "package/./package.json"],
    ["a copy behind a doubled slash", "package//package.json"],
    ["a copy under another top directory", "other/package.json"],
  ])("refuses %s", async (_case, second) => {
    const path = await archive([
      { path: "package/package.json", body: manifest },
      { path: second, body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "more than one package.json",
    );
  });

  it("counts a ustar prefix that makes an entry the package.json", async () => {
    const path = await archive([
      { path: "package/package.json", body: manifest },
      { path: "package.json", prefix: "package", body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "more than one package.json",
    );
  });

  it.each([
    ["a global pax record", "g"],
    ["a GNU long name", "L"],
  ])("refuses %s", async (_case, type) => {
    const path = await archive([
      { path: "././@LongLink", type, body: "package/package.json" },
      { path: "package/package.json", body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).rejects.toThrow("not read with");
  });

  it("refuses a package.json that is a link", async () => {
    const path = await archive([{ path: "package/package.json", type: "2" }]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "not a regular file",
    );
  });

  it("refuses a directory entry that carries content", async () => {
    // node-tar reads no body for a directory, so the bytes after it are the
    // next header to npm and part of this entry here.
    const path = await archive([
      { path: "package/dist/", type: "5", body: "x" },
      { path: "package/package.json", body: manifest },
    ]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "directory entry with content",
    );
  });

  it("refuses a corrupt header", async () => {
    const path = join(directory, "corrupt.tgz");
    const block = Buffer.alloc(512, 0x41);
    await writeFile(path, gzipSync(block));

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "corrupt header",
    );
  });

  it("refuses an archive with no package.json", async () => {
    const path = await archive([{ path: "package/index.js", body: "" }]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "holds no package.json",
    );
  });

  it("refuses a package.json that is not JSON", async () => {
    const path = await archive([
      { path: "package/package.json", body: "{ not json" },
    ]);

    await expect(readArchivePackageJson(path)).rejects.toThrow(
      "not valid JSON",
    );
  });
});
