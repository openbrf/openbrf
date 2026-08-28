import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Reading and writing a theme package.
 *
 * A theme package is a gzipped ustar archive holding regular files only. The
 * reader here is deliberately narrower than a general tar implementation,
 * because it is pointed at third-party content downloaded from a catalog:
 *
 *   Only regular files and directory entries are accepted. Symbolic links,
 *   hard links, character and block devices, FIFOs and the GNU long-name and
 *   pax extension records are all refused. Every one of them is a way for an
 *   archive to name a path the header does not show, or to place something on
 *   disk that is not a file.
 *
 *   Every path is validated before it is kept: no absolute path, no parent
 *   segment, no backslash. Extraction never joins a path this reader has not
 *   already accepted.
 *
 *   Entry count, per-entry size and total size are capped, so a small download
 *   cannot expand into an unbounded write.
 *
 * The whole archive is held in memory. A theme is colours, a manifest and a
 * few font files; the cap below is the ceiling on that, not a streaming limit.
 */

const BLOCK_SIZE = 512;

export const MAX_ARCHIVE_ENTRIES = 200;
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export class ThemeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeArchiveError";
  }
}

/** The files an archive contained, keyed by their path inside the package. */
export type ThemeArchiveFiles = ReadonlyMap<string, Uint8Array>;

function decodeString(
  block: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder("utf8").decode(
    end === -1 ? slice : slice.subarray(0, end),
  );
}

function decodeOctal(block: Uint8Array, start: number, length: number): number {
  const text = decodeString(block, start, length).trim().replace(/\0+$/, "");
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new ThemeArchiveError("The archive has a malformed numeric field.");
  }
  return Number.parseInt(text, 8);
}

/**
 * Verifies the header checksum.
 *
 * Cheap, and it turns "this is not a tar archive at all" into a clear refusal
 * rather than a nonsensical path or a huge size read out of arbitrary bytes.
 */
function checksumMatches(block: Uint8Array): boolean {
  const stated = decodeOctal(block, 148, 8);
  let signed = 0;
  let unsigned = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stated === unsigned || stated === signed;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function assertSafePath(path: string): void {
  if (path.length === 0 || path.length > 200) {
    throw new ThemeArchiveError(
      `The archive names a path of an unusable length.`,
    );
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new ThemeArchiveError(
      `The archive names an absolute or backslashed path: ${path}`,
    );
  }
  if (path.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new ThemeArchiveError(
      `The archive names a path that escapes the package: ${path}`,
    );
  }
}

/**
 * Strips the single directory every entry sits under, when there is one.
 *
 * Packaging tools root an archive at a directory - `npm pack` writes
 * `package/`, `tar -czf` from a parent writes the theme's own folder name - and
 * the manifest paths are relative to the theme root, not to whatever that
 * directory was called. Stripping it here means a theme's `theme.json` is at
 * `theme.json` however it was packed.
 */
function stripCommonRoot(paths: readonly string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  const first = paths[0]?.split("/")[0];
  if (first === undefined || first === "") {
    return null;
  }
  const rooted = paths.every(
    (path) => path.startsWith(`${first}/`) && path.length > first.length + 1,
  );
  return rooted ? first : null;
}

/**
 * Reads a gzipped theme package into its files.
 *
 * Throws ThemeArchiveError on anything the format does not allow, which the
 * installer surfaces as a refusal naming the archive rather than the theme.
 */
export function readThemeArchive(archive: Uint8Array): ThemeArchiveFiles {
  let tarball: Buffer;
  try {
    tarball = gunzipSync(archive);
  } catch (cause) {
    throw new ThemeArchiveError(
      `The package is not a gzip archive: ${(cause as Error).message}`,
    );
  }

  const collected = new Map<string, Uint8Array>();
  let total = 0;
  let offset = 0;
  let trailingZeroBlocks = 0;

  while (offset + BLOCK_SIZE <= tarball.length) {
    const header = tarball.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    if (isZeroBlock(header)) {
      trailingZeroBlocks += 1;
      // Two consecutive zero blocks end the archive; anything after them is
      // padding the format says nothing about, so reading stops here.
      if (trailingZeroBlocks >= 2) {
        break;
      }
      continue;
    }
    trailingZeroBlocks = 0;

    if (!checksumMatches(header)) {
      throw new ThemeArchiveError("The archive has a corrupt header.");
    }

    const typeFlag = decodeString(header, 156, 1);
    const size = decodeOctal(header, 124, 12);
    const dataBlocks = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeFlag === "5") {
      // A directory entry carries no content and creates nothing: extraction
      // makes the directories the files it keeps actually need.
      offset += dataBlocks;
      continue;
    }

    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "") {
      throw new ThemeArchiveError(
        `The archive contains an entry that is not a regular file (type ${typeFlag || "?"}). ` +
          "A theme package holds files only.",
      );
    }

    if (size > MAX_ENTRY_BYTES) {
      throw new ThemeArchiveError(
        `The archive contains a file larger than ${String(MAX_ENTRY_BYTES)} bytes.`,
      );
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new ThemeArchiveError(
        `The archive unpacks to more than ${String(MAX_TOTAL_BYTES)} bytes.`,
      );
    }
    if (collected.size >= MAX_ARCHIVE_ENTRIES) {
      throw new ThemeArchiveError(
        `The archive contains more than ${String(MAX_ARCHIVE_ENTRIES)} files.`,
      );
    }

    const prefix = decodeString(header, 345, 155);
    const name = decodeString(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    assertSafePath(path);

    if (offset + size > tarball.length) {
      throw new ThemeArchiveError("The archive ends inside a file.");
    }
    collected.set(
      path,
      new Uint8Array(tarball.subarray(offset, offset + size)),
    );
    offset += dataBlocks;
  }

  const root = stripCommonRoot([...collected.keys()]);
  if (root === null) {
    return collected;
  }

  const stripped = new Map<string, Uint8Array>();
  for (const [path, content] of collected) {
    stripped.set(path.slice(root.length + 1), content);
  }
  return stripped;
}

function writeString(
  block: Uint8Array,
  value: string,
  start: number,
  length: number,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) {
    throw new ThemeArchiveError(
      `The value "${value}" does not fit the header.`,
    );
  }
  block.set(bytes, start);
}

function writeOctal(
  block: Uint8Array,
  value: number,
  start: number,
  length: number,
): void {
  writeString(
    block,
    value.toString(8).padStart(length - 1, "0"),
    start,
    length,
  );
}

/**
 * Packs files into a gzipped theme package.
 *
 * Deterministic on purpose: entries are sorted, and the ownership and
 * modification-time fields are fixed rather than taken from the filesystem. The
 * catalog identifies a package by its sha512, so packing the same theme twice
 * has to produce the same bytes or the checksum means nothing.
 */
export function writeThemeArchive(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const path of [...files.keys()].sort()) {
    assertSafePath(path);
    const content = files.get(path);
    if (content === undefined) {
      continue;
    }

    const header = new Uint8Array(BLOCK_SIZE);
    // ustar splits a long path across prefix and name; a theme package has no
    // business carrying one, so a path that does not fit is refused instead.
    writeString(header, path, 0, 100);
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    writeString(header, "        ", 148, 8);
    writeString(header, "0", 156, 1);
    writeString(header, "ustar", 257, 6);
    writeString(header, "00", 263, 2);

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    writeOctal(header, checksum, 148, 7);
    header[155] = 0x20;

    blocks.push(header);

    const padded = new Uint8Array(
      Math.ceil(content.length / BLOCK_SIZE) * BLOCK_SIZE,
    );
    padded.set(content, 0);
    blocks.push(padded);
  }

  // Two zero blocks end the archive.
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const tarball = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tarball.set(block, offset);
    offset += block.length;
  }

  return new Uint8Array(gzipSync(tarball, { level: 9 }));
}
