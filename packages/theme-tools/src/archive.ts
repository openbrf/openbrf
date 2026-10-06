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
 *   File count, directory count, per-entry size and total size are capped, so
 *   a small download cannot expand into an unbounded write.
 *
 *   Where tar implementations read the same bytes differently, the archive is
 *   refused rather than read one way. Otherwise `tar -tzf` or Python's tarfile
 *   would list one set of files for a reviewer while this reader kept another.
 *
 * The whole archive is held in memory. A theme is colours, a manifest and a
 * few font files; the cap below is the ceiling on that, not a streaming limit.
 */

const BLOCK_SIZE = 512;

export const MAX_ARCHIVE_ENTRIES = 200;
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/**
 * Directory records are capped apart from files: `tar` writes one for every
 * folder it packs, so counting them as files would refuse a theme of 200 files
 * packed from a folder. Without a cap of their own they would be the one part
 * of an archive with no bound, and the ceiling below could not cover them.
 */
export const MAX_DIRECTORY_RECORDS = 200;

/**
 * Ceiling on the size of the unzipped tarball, handed to the decompressor so a
 * small gzip cannot inflate past it before any entry is looked at.
 *
 * It is the most a package `tar` writes within the limits above can occupy:
 * the content, a header block and up to a block's worth of padding for each of
 * the allowed files, a header block for each of the allowed directories, the
 * two zero blocks that end the archive, and one record of the zero padding
 * `tar` writes after them.
 */
const TAR_RECORD_SIZE = 20 * BLOCK_SIZE;
export const MAX_TARBALL_BYTES =
  MAX_TOTAL_BYTES +
  MAX_ARCHIVE_ENTRIES * (2 * BLOCK_SIZE - 1) +
  MAX_DIRECTORY_RECORDS * BLOCK_SIZE +
  2 * BLOCK_SIZE +
  TAR_RECORD_SIZE;

export class ThemeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeArchiveError";
  }
}

/** The files an archive contained, keyed by their path inside the package. */
export type ThemeArchiveFiles = ReadonlyMap<string, Uint8Array>;

const utf8 = new TextDecoder("utf8", { ignoreBOM: true, fatal: true });

function decodeString(
  block: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  // A leading BOM is kept, so it cannot make two names look like one, and
  // bytes that are not UTF-8 are refused rather than replaced.
  try {
    return utf8.decode(end === -1 ? slice : slice.subarray(0, end));
  } catch {
    throw new ThemeArchiveError("The archive has a field that is not UTF-8.");
  }
}

function isPadding(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0;
}

/**
 * Reads a numeric field: leading spaces, octal digits, then only spaces and
 * NULs (`^ *[0-7]*[ \0]*$`). A NUL before the digits is refused, since tools
 * disagree about whether the field then ends there or at the digits.
 */
function decodeOctal(block: Uint8Array, start: number, length: number): number {
  const slice = block.subarray(start, start + length);
  let index = 0;
  while (index < slice.length && slice[index] === 0x20) {
    index += 1;
  }
  let value = 0;
  while (index < slice.length) {
    const byte = slice[index] ?? 0;
    if (byte < 0x30 || byte > 0x37) {
      break;
    }
    value = value * 8 + (byte - 0x30);
    index += 1;
  }
  for (; index < slice.length; index += 1) {
    if (!isPadding(slice[index])) {
      throw new ThemeArchiveError("The archive has a malformed numeric field.");
    }
  }
  return value;
}

/**
 * Reads a base-256 field (flagged by a leading 0x80 or 0xff byte) and refuses
 * a value that is not a safe integer, as node-tar does.
 */
function assertBase256(block: Uint8Array, start: number, length: number): void {
  const bytes = block.subarray(start, start + length);
  let value = 0n;
  if (bytes[0] === 0x80) {
    for (const byte of bytes.subarray(1)) {
      value = value * 256n + BigInt(byte);
    }
  } else {
    for (const byte of bytes) {
      value = value * 256n + BigInt(byte);
    }
    value -= 1n << BigInt(8 * bytes.length);
  }
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ThemeArchiveError("The archive has a malformed numeric field.");
  }
}

/**
 * Every numeric field but size and the checksum, which are read where used.
 *
 * GNU tar and bsdtar write a value that does not fit octal (a uid above
 * 2^21, a negative mtime) in base-256, flagged by a leading 0x80 or 0xff byte.
 * These fields are never used, so such a field is accepted when its value is a
 * safe integer; size and the checksum stay octal-only.
 */
function assertNumericFields(header: Uint8Array): void {
  for (const [start, length] of [
    [100, 8], // mode
    [108, 8], // uid
    [116, 8], // gid
    [136, 12], // mtime
    [329, 8], // devmajor
    [337, 8], // devminor
  ] as const) {
    if (header[start] === 0x80 || header[start] === 0xff) {
      assertBase256(header, start, length);
      continue;
    }
    decodeOctal(header, start, length);
  }
}

/**
 * Verifies the header checksum.
 *
 * Cheap, and it turns "this is not a tar archive at all" into a clear refusal
 * rather than a nonsensical path or a huge size read out of arbitrary bytes.
 */
function checksumMatches(block: Uint8Array): boolean {
  // node-tar reads the checksum over 12 bytes, so it must end at the field.
  if (!isPadding(block[155])) {
    return false;
  }
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

/** The POSIX ustar magic and version, which make the `prefix` field a path. */
function isUstar(header: Uint8Array): boolean {
  return (
    decodeString(header, 257, 6) === "ustar" &&
    header[262] === 0 &&
    header[263] === 0x30 &&
    header[264] === 0x30
  );
}

/**
 * The path a header names.
 *
 * Only a POSIX ustar header has a `prefix` field. GNU tar and bsdtar ignore
 * those bytes in any other header (the GNU format keeps timestamps there),
 * while Python's tarfile joins them to the name regardless, so a header
 * without the magic that has anything in them is refused.
 */
function headerPath(header: Uint8Array): string {
  // node-tar reads past a NUL when a newline follows it, so anything but NULs
  // after the first is a name tools read differently.
  for (const [start, length] of [
    [0, 100],
    [345, 155],
  ] as const) {
    const field = header.subarray(start, start + length);
    const end = field.indexOf(0);
    if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) {
      throw new ThemeArchiveError(
        "The archive has a name with bytes after its end.",
      );
    }
  }
  const name = decodeString(header, 0, 100);
  const prefix = decodeString(header, 345, 155);
  if (prefix === "") {
    return name;
  }
  if (!isUstar(header)) {
    throw new ThemeArchiveError(
      "The archive has a path prefix in a header that is not ustar.",
    );
  }
  return `${prefix}/${name}`;
}

/**
 * `rootedAtDot` lets the reader pass a path that still has its leading `./`
 * root, which it strips once it has seen every entry.
 */
function assertSafePath(path: string, rootedAtDot = false): void {
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
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new ThemeArchiveError(
      `The archive names a path that escapes the package: ${path}`,
    );
  }
  if (segments.slice(rootedAtDot ? 1 : 0).includes(".")) {
    throw new ThemeArchiveError(
      `The archive names a path with a "." segment: ${path}`,
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
    tarball = gunzipSync(archive, { maxOutputLength: MAX_TARBALL_BYTES });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ThemeArchiveError(
        `The package unpacks to more than ${String(MAX_TARBALL_BYTES)} bytes, ` +
          "more than a theme package may hold. It was not unpacked.",
      );
    }
    throw new ThemeArchiveError(
      `The package is not a gzip archive: ${(cause as Error).message}`,
    );
  }

  const collected = new Map<string, Uint8Array>();
  let total = 0;
  // Counts every regular-file record, not distinct paths: an archive that
  // repeats one path would otherwise never reach the cap.
  let fileRecords = 0;
  let directoryRecords = 0;
  let offset = 0;

  while (offset + BLOCK_SIZE <= tarball.length) {
    const header = tarball.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    if (isZeroBlock(header)) {
      // Two zero blocks end the archive, and anything after them is padding
      // the format says nothing about. tar and Python's tarfile both stop at
      // the first one, so a header after a lone zero block would be a file
      // only this reader sees.
      if (!isZeroBlock(tarball.subarray(offset, offset + BLOCK_SIZE))) {
        throw new ThemeArchiveError(
          "The archive has a lone zero block before its last entry.",
        );
      }
      break;
    }

    if (!checksumMatches(header)) {
      throw new ThemeArchiveError("The archive has a corrupt header.");
    }

    assertNumericFields(header);
    const typeFlag = decodeString(header, 156, 1);
    if (
      (typeFlag === "5" || typeFlag === "0" || typeFlag === "") &&
      header.subarray(157, 257).some((byte) => byte !== 0)
    ) {
      throw new ThemeArchiveError("The archive has a file with a link name.");
    }
    const size = decodeOctal(header, 124, 12);
    const dataBlocks = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeFlag === "5") {
      // A directory entry carries no content and creates nothing: extraction
      // makes the directories the files it keeps actually need. One that
      // states a size is refused: tar and Python's tarfile do not skip a
      // directory's data, so they would read headers hidden in it.
      if (size > 0) {
        throw new ThemeArchiveError(
          "The archive has a directory entry that states a size.",
        );
      }
      if (directoryRecords >= MAX_DIRECTORY_RECORDS) {
        throw new ThemeArchiveError(
          `The archive contains more than ${String(MAX_DIRECTORY_RECORDS)} directory entries.`,
        );
      }
      directoryRecords += 1;
      // The path is not used, but a prefix without the ustar magic is read
      // differently by different tools here too.
      headerPath(header);
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
    if (fileRecords >= MAX_ARCHIVE_ENTRIES) {
      throw new ThemeArchiveError(
        `The archive contains more than ${String(MAX_ARCHIVE_ENTRIES)} files.`,
      );
    }

    fileRecords += 1;

    const path = headerPath(header);
    assertSafePath(path, true);

    if (offset + size > tarball.length) {
      throw new ThemeArchiveError("The archive ends inside a file.");
    }
    collected.set(
      path,
      new Uint8Array(tarball.subarray(offset, offset + size)),
    );
    offset += dataBlocks;
  }

  // `tar -czf x.tgz -C dir .` roots every name at `.`, which is stripped like
  // any other common root. A `.` left after that would let `theme.json` and
  // `./theme.json` be two entries that land on one file.
  const root = stripCommonRoot([...collected.keys()]);
  const stripped = new Map<string, Uint8Array>();
  for (const [path, content] of collected) {
    const relative = root === null ? path : path.slice(root.length + 1);
    if (relative.split("/").includes(".")) {
      throw new ThemeArchiveError(
        `The archive names a path with a "." segment: ${path}`,
      );
    }
    stripped.set(relative, content);
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
