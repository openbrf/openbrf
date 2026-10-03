import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { pipeline, type Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/**
 * Reading the package.json a package archive holds, without unpacking it.
 *
 * The installer reads an archive's package.json before npm sees the archive,
 * because npm acts on what that file declares before anything else can check
 * it: offline, a `file:` dependency still resolves, and npm links or copies a
 * package from elsewhere on the volume into the staging tree. Read here, a
 * package that declares one is refused while npm has done nothing.
 *
 * npm unpacks an archive with node-tar, and this reader is deliberately
 * narrower than node-tar rather than a second implementation of it. Whatever
 * two tar readers could read differently - global pax records, GNU long names,
 * a corrupt header, a size in base-256, a directory carrying a body - is
 * refused, so an archive that passes is one in which both find the same
 * entries at the same places. An entry counts as the package's package.json
 * if any reading of its path could make it that file, and an archive with more
 * than one such entry is refused: whichever of them npm would end up keeping,
 * it would not necessarily be the one read here.
 *
 * The archive is streamed rather than held in memory, so a package that
 * unpacks to far more than it downloads costs time rather than memory.
 */

const BLOCK_SIZE = 512;

/**
 * The most a package.json or a pax record may hold. node-tar ignores longer
 * pax records, so one that long would be read differently by the two.
 */
const MAX_RECORD_BYTES = 1024 * 1024;

/** Bytes skipped per read, so skipping a large file holds little of it. */
const SKIP_CHUNK_BYTES = 64 * 1024;

/** Entry types node-tar unpacks as files, the only kind npm keeps. */
const FILE_TYPES = new Set(["0", "", "7"]);

/** Entry types this reader steps over. Any other is refused. */
const KNOWN_TYPES = new Set([...FILE_TYPES, "1", "2", "3", "4", "5", "6"]);

/**
 * The parsed package.json of the package archive at `archive`.
 *
 * Throws when the archive holds none, more than one, or one that is not JSON,
 * and when the archive is something this reader does not read.
 */
export async function readArchivePackageJson(
  archive: string,
): Promise<unknown> {
  const blocks = new BlockReader(await openTar(archive));
  try {
    return await findPackageJson(blocks);
  } finally {
    blocks.close();
  }
}

async function findPackageJson(blocks: BlockReader): Promise<unknown> {
  let found: Buffer | undefined;
  let extended: PaxRecords | undefined;

  for (;;) {
    const header = await blocks.read(BLOCK_SIZE);
    if (header === null) {
      break;
    }
    if (header.every((byte) => byte === 0)) {
      // node-tar stops at the second of these. Reading on can only find more
      // to refuse, never less.
      continue;
    }
    if (!checksumMatches(header)) {
      throw new Error("The archive has a corrupt header.");
    }

    const type = decodeString(header, 156, 1);
    const headerSize = decodeSize(header);

    if (type === "x") {
      if (extended !== undefined) {
        throw new Error("The archive has two pax records for one entry.");
      }
      extended = parsePax(await readBody(blocks, headerSize));
      continue;
    }
    if (!KNOWN_TYPES.has(type)) {
      throw new Error(
        `The archive has an entry of a type it is not read with (${type || "?"}).`,
      );
    }

    const name = extended?.path ?? decodeString(header, 0, 100);
    const size = extended?.size ?? headerSize;
    extended = undefined;

    if ((type === "5" || name.endsWith("/")) && size !== 0) {
      // node-tar reads a directory as having no body whatever its header says.
      throw new Error("The archive has a directory entry with content.");
    }

    if (pathCandidates(name, header).some(isRootPackageJson)) {
      if (found !== undefined) {
        throw new Error("The archive holds more than one package.json.");
      }
      if (!FILE_TYPES.has(type)) {
        throw new Error("The archive's package.json is not a regular file.");
      }
      found = await readBody(blocks, size);
      continue;
    }

    await blocks.skip(padded(size));
  }

  if (found === undefined) {
    throw new Error("The archive holds no package.json.");
  }
  try {
    return JSON.parse(found.toString("utf8"));
  } catch {
    throw new Error("The archive's package.json is not valid JSON.");
  }
}

/** The tar stream inside `archive`, decompressed when it is gzipped. */
async function openTar(archive: string): Promise<Readable> {
  const handle = await open(archive, "r");
  const magic = Buffer.alloc(2);
  try {
    await handle.read(magic, 0, 2, 0);
  } finally {
    await handle.close();
  }
  const source = createReadStream(archive);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
    return source;
  }
  return pipeline(source, createGunzip(), () => {
    // Errors reach the reader through the stream it iterates.
  });
}

async function readBody(blocks: BlockReader, size: number): Promise<Buffer> {
  if (size > MAX_RECORD_BYTES) {
    throw new Error(
      `The archive has a record over ${String(MAX_RECORD_BYTES)} bytes where its package.json or a pax record is.`,
    );
  }
  const body = await blocks.read(padded(size));
  if (body === null) {
    throw new Error("The archive ends inside an entry.");
  }
  return body.subarray(0, size);
}

/**
 * Every path node-tar could give the entry: the name alone, and the name under
 * each width of ustar prefix it reads.
 */
function pathCandidates(name: string, header: Buffer): string[] {
  return [
    name,
    `${decodeString(header, 345, 155)}/${name}`,
    `${decodeString(header, 345, 130)}/${name}`,
  ];
}

/**
 * Whether `path` lands on the package root's package.json once npm drops the
 * archive's top directory. Generous on purpose: case, dot segments, repeated
 * and leading slashes and backslashes are all read in the way that makes it a
 * match, since a false match only refuses an odd archive.
 */
function isRootPackageJson(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const inPackage = posix
    .normalize(parts.slice(1).join("/"))
    .replace(/^(?:\.?\/)+/, "");
  return inPackage.toLowerCase() === "package.json";
}

interface PaxRecords {
  path?: string;
  size?: number;
}

/** The pax records that move an entry: its path and its size. */
function parsePax(body: Buffer): PaxRecords {
  const records: PaxRecords = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString("ascii"));
    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      throw new Error("The archive has a malformed pax record.");
    }
    const record = body
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") {
      records.path = value;
    } else if (key === "size") {
      if (!/^\d+$/.test(value)) {
        throw new Error("The archive has a malformed pax size.");
      }
      records.size = Number(value);
    }
    offset += length;
  }
  return records;
}

function decodeString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

function decodeSize(header: Buffer): number {
  if (((header[124] ?? 0) & 0x80) !== 0) {
    throw new Error("The archive states a size in base-256.");
  }
  const text = decodeString(header, 124, 12).trim();
  if (text !== "" && !/^[0-7]+$/.test(text)) {
    throw new Error("The archive has a malformed size field.");
  }
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumMatches(header: Buffer): boolean {
  const text = decodeString(header, 148, 8).trim();
  if (!/^[0-7]+$/.test(text)) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return Number.parseInt(text, 8) === sum;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/** Reads a stream in exact lengths. */
class BlockReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);

  constructor(private readonly stream: Readable) {
    this.chunks = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Exactly `length` bytes; null at the end of the stream. */
  async read(length: number): Promise<Buffer | null> {
    while (this.pending.length < length) {
      const next = await this.chunks.next();
      if (next.done === true) {
        if (this.pending.length === 0) {
          return null;
        }
        throw new Error("The archive ends inside an entry.");
      }
      this.pending = Buffer.concat([this.pending, next.value]);
    }
    const taken = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return taken;
  }

  async skip(length: number): Promise<void> {
    for (let left = length; left > 0; left -= SKIP_CHUNK_BYTES) {
      if ((await this.read(Math.min(left, SKIP_CHUNK_BYTES))) === null) {
        throw new Error("The archive ends inside an entry.");
      }
    }
  }

  close(): void {
    this.stream.destroy();
  }
}
