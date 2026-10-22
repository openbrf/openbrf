import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { hostRequire } from "../config/host-require";

/**
 * The text of a PDF in the archive, read when it is asked for and kept nowhere.
 *
 * ADR 0041. A document holds a title, a binder and a stored file, and the file
 * is encrypted at rest (ADR 0015). Text kept beside it would be a second copy
 * to encrypt and to remove with it, so there is none: the text is extracted
 * inside the request that asks for it, for the pages it asks for, and is gone
 * when the answer has been sent. A scanned PDF has no text layer, and the
 * answer says so rather than reading the image: there is no OCR.
 *
 * ## The parser runs where it can be stopped
 *
 * A PDF is a program for drawing pages, and the parser (Mozilla's pdf.js) runs
 * synchronously for as long as a page takes. A file built to take a long time
 * would hold the API's event loop with it, and one built to take memory would
 * take it from the API: a compressed stream of a mebibyte inflates to a
 * gibibyte, which the parser holds whole in buffers no heap cap counts. So the
 * parser runs in a process of its own, one per read, and the process is killed
 * when the time is up or when the memory the operating system counts for it
 * passes the cap. Both are watched from the API's side, where a synchronous
 * loop in the parser cannot keep the watch from running. Where the platform
 * does not report another process's memory (Linux does, through /proc), the
 * parser watches its own, which covers memory that grows while it waits on the
 * decompressor, and its heap is capped as well.
 *
 * ## What the parser is allowed to do
 *
 * The settings in {@link PARSER_SOURCE} are the security review's subject, and
 * each says no to something a text read does not need:
 *
 * - the bytes are handed over, so no URL is given and nothing is fetched;
 * - no system font is read and no font face is built;
 * - no WebAssembly decoder, offscreen canvas or image decoder is used, since
 *   text extraction never decodes an image;
 * - XFA forms are not rendered.
 *
 * The process around it says no again, should the parser ever be made to run
 * code of a file's choosing ({@link parserProcess}):
 *
 * - Node's permission model lets it read pdf.js's own files and nothing else,
 *   write nothing, and start no process, thread or native addon; the bytes
 *   come over the IPC channel, so it needs no file of the API's;
 * - code is not built from strings, which pdf.js never does;
 * - its environment is empty, so no secret of the API's is in it, and being
 *   another process it has no view of the API's own memory or environment;
 * - its console output is discarded rather than logged, because pdf.js
 *   warnings can quote the document.
 *
 * pdf.js 4.2.67 removed the font path compiled with `eval` (CVE-2024-4367), and
 * the pinned 6.x has no such option left to turn off.
 */

/** The caps on one read. */
export const DOCUMENT_TEXT_LIMITS = {
  /**
   * The largest file read at all. A PDF that carries text is small; one over
   * this is almost always pages of scanned images, which have no text to read.
   */
  maxBytes: 16 * 1024 * 1024,
  /** The most pages one call reads. A caller reads a long document in turns. */
  pagesPerRead: 10,
  /**
   * The most characters one call returns, across its pages. A page longer than
   * what is left is cut, and the answer says where to go on from.
   */
  charactersPerRead: 60_000,
  /** How long the parser may take before its process is killed. */
  milliseconds: 10_000,
  /**
   * The parser process's memory, heap and buffers together, as the operating
   * system counts it. Past it, the process is killed and the API is not.
   */
  memoryMb: 256,
  /**
   * How many reads run at once on this instance. Each holds a decrypted file
   * of up to the size above and a process with the memory above, so without a
   * ceiling one connected app calling in parallel could hold every core and a
   * gigabyte of memory with files the API serves anyway. A read past it is refused
   * before its file is opened, to be asked again shortly.
   */
  concurrentReads: 2,
} as const;

/** The caps' shape, so a test can lower one without the others. */
export type DocumentTextLimits = {
  readonly [cap in keyof typeof DOCUMENT_TEXT_LIMITS]: number;
};

/** One page's text, numbered from 1 as a reader numbers them. */
export interface DocumentPageText {
  number: number;
  text: string;
}

/**
 * A place in a document's text: a page, and a character within that page's
 * text as this module returns it, counted from 0 in UTF-16 code units.
 *
 * The text is the same at every read of the same file, so a place one read
 * hands out is where the next read starts.
 */
export interface DocumentTextPlace {
  page: number;
  character: number;
}

export interface DocumentText {
  pageCount: number;
  /**
   * The pages read, in order. The first starts at the character asked for, and
   * the last is cut short when the character cap was reached inside it.
   */
  pages: DocumentPageText[];
  /**
   * False when pages were read and none of them carries any text: a scan.
   * True when one does, and when no page was read at all, since a range past
   * the last page says nothing about whether the file has text.
   */
  textLayer: boolean;
  /** True when the character cap stopped the answer before the range's end. */
  truncated: boolean;
  /**
   * Where the text goes on after this answer: inside the range when the cap
   * cut it short, the page after the range when the document has more, and
   * null when this answer reached the document's last page.
   */
  next: DocumentTextPlace | null;
}

/** What one read covers: pages, and where in the first of them to start. */
export interface DocumentTextRange {
  firstPage: number;
  lastPage: number;
  /** Where in the first page's text to start. Absent starts at its beginning. */
  firstCharacter?: number;
}

/** Why a file could not be read. Each is a reason on `DocumentError`. */
export type DocumentTextFailure =
  | "too-large-to-read"
  | "unreadable"
  | "password-protected"
  | "read-timed-out"
  | "read-busy";

export class DocumentTextFailed extends Error {
  constructor(readonly failure: DocumentTextFailure) {
    super(`The document's text could not be read: ${failure}.`);
    this.name = "DocumentTextFailed";
  }
}

/**
 * The exit code with which the parser says it stopped itself for passing the
 * memory cap. Node exits with none above 14 of its own, other than 128 plus a
 * signal's number.
 */
const OUT_OF_MEMORY_EXIT = 90;

/**
 * The parser process, as source.
 *
 * Plain JavaScript given to `node -e` rather than a file of its own, so that
 * one path works both from the compiled API and under the test runner, which
 * do not agree on what a sibling file is called. It imports nothing but pdf.js,
 * from the directory the API resolved and the only one it may read.
 */
const PARSER_SOURCE = `
/** C0 controls other than the line break, which no reader wants to receive. */
const CONTROLS = /[\\u0000-\\u0009\\u000b-\\u001f\\u007f]/gu;

function tidy(text) {
  return text
    .replace(CONTROLS, " ")
    .split("\\n")
    .map((line) => line.replace(/\\s+/gu, " ").trim())
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\\n")
    .trim();
}

async function read(request) {
  const pdfjs = await import(request.parser);
  const task = pdfjs.getDocument({
    // Arrives as a Buffer, which pdf.js refuses for a Uint8Array.
    data: new Uint8Array(
      request.bytes.buffer,
      request.bytes.byteOffset,
      request.bytes.byteLength,
    ),
    verbosity: 0,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });

  let document;
  try {
    document = await task.promise;
  } catch (error) {
    return {
      kind: "failed",
      failure:
        error && error.name === "PasswordException"
          ? "password-protected"
          : "unreadable",
    };
  }

  const pageCount = document.numPages;
  const last = Math.min(request.lastPage, pageCount);
  const pages = [];
  let characters = 0;
  let textLayer = false;
  let stopped = null;
  for (let number = request.firstPage; number <= last; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const whole = tidy(
      content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\\n" : "") : ""))
        .join(""),
    );
    page.cleanup();
    textLayer = textLayer || whole !== "";
    const start = number === request.firstPage ? request.firstCharacter : 0;
    const text = whole.slice(start);
    const room = request.maxCharacters - characters;
    if (text.length > room) {
      // Cut where the cap falls, but never between the halves of a surrogate
      // pair: half a character is not text, and the next read starts there.
      const cut = isHighSurrogate(text.charCodeAt(room - 1)) ? room - 1 : room;
      if (cut > 0) {
        pages.push({ number, text: text.slice(0, cut) });
      }
      stopped = { page: number, character: start + cut };
      break;
    }
    characters += text.length;
    pages.push({ number, text });
  }
  await task.destroy();
  return { kind: "read", pageCount, pages, textLayer, stopped };
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// Listened to for as long as the process runs, which keeps the channel open
// until the API has the answer and kills it: a parser that left on its own
// could be seen to exit before its answer was read.
process.on("message", (request) => {
  // The watch on its own memory, for where the API cannot see it. It runs
  // between the decompressor's chunks, which is where a bomb grows.
  setInterval(() => {
    if (process.memoryUsage.rss() > request.maxMemoryBytes) {
      process.exit(${String(OUT_OF_MEMORY_EXIT)});
    }
  }, 20).unref();
  read(request).then(
    (answer) => process.send(answer),
    () => process.send({ kind: "failed", failure: "unreadable" }),
  );
});
`;

type ParserAnswer =
  | {
      kind: "read";
      pageCount: number;
      pages: DocumentPageText[];
      /** Whether any page read carries text, before a first page was cut. */
      textLayer: boolean;
      /** Where the character cap stopped the read, when it did. */
      stopped: DocumentTextPlace | null;
    }
  | { kind: "failed"; failure: DocumentTextFailure };

/** pdf.js's own directory, resolved the way the API resolves its own modules. */
function parserDirectory(): string {
  return dirname(hostRequire().resolve("pdfjs-dist/package.json"));
}

/**
 * Starts a parser process running `source`, under the restrictions every read
 * runs under. Exported so that a test can hold the restrictions from inside.
 *
 * The process is Node itself, run with nothing of the API's: not its
 * environment, not its options, and not its files, since Node's permission
 * model lets it read only pdf.js's directory. A read is sent to it over the
 * IPC channel, and its own output goes nowhere.
 */
export function parserProcess(
  source: string,
  limits: DocumentTextLimits,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${parserDirectory()}`,
      "--disallow-code-generation-from-strings",
      `--max-old-space-size=${String(limits.memoryMb)}`,
      "-e",
      source,
    ],
    {
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    },
  );
}

/** The reads running now, against {@link DOCUMENT_TEXT_LIMITS.concurrentReads}. */
let running = 0;

/**
 * Reads the text of the pages from `firstPage` to `lastPage` of a PDF, from
 * `firstCharacter` of the first.
 *
 * `load` fetches the file, and is called only once the read has its place
 * among those running at once: a read refused for that never opens the file,
 * so the ceiling bounds the decrypted bytes held as well as the processes.
 *
 * The range is clipped to the pages the file has, so a range that starts past
 * the last page answers with the page count and no pages. Refuses a range over
 * the page cap, a read past the number running at once, a file over the size
 * cap before it reaches the parser, and a read that runs over the time cap or
 * the memory cap.
 */
export async function readDocumentText(
  load: () => Promise<Buffer>,
  range: DocumentTextRange,
  limits: DocumentTextLimits = DOCUMENT_TEXT_LIMITS,
): Promise<DocumentText> {
  const firstCharacter = range.firstCharacter ?? 0;
  if (
    range.firstPage < 1 ||
    range.lastPage < range.firstPage ||
    range.lastPage - range.firstPage + 1 > limits.pagesPerRead ||
    !Number.isInteger(firstCharacter) ||
    firstCharacter < 0
  ) {
    throw new RangeError("The page range is outside what one read covers.");
  }
  if (running >= limits.concurrentReads) {
    throw new DocumentTextFailed("read-busy");
  }

  running += 1;
  try {
    const bytes = await load();
    if (bytes.length > limits.maxBytes) {
      throw new DocumentTextFailed("too-large-to-read");
    }
    return await readInProcess(bytes, { ...range, firstCharacter }, limits);
  } finally {
    running -= 1;
  }
}

/** One read, in a parser process that is gone again when this returns. */
async function readInProcess(
  bytes: Buffer,
  range: Required<DocumentTextRange>,
  limits: DocumentTextLimits,
): Promise<DocumentText> {
  const parser = parserProcess(PARSER_SOURCE, limits);

  // Killed before this returns, whichever way it returns, so a read that has
  // been answered no longer counts against the ceiling and no longer runs.
  let answer: ParserAnswer;
  try {
    answer = await settled(parser, limits, {
      parser: pathToFileURL(
        hostRequire().resolve("pdfjs-dist/legacy/build/pdf.mjs"),
      ).href,
      bytes,
      firstPage: range.firstPage,
      lastPage: range.lastPage,
      firstCharacter: range.firstCharacter,
      maxCharacters: limits.charactersPerRead,
      maxMemoryBytes: limits.memoryMb * MEBIBYTE,
    });
  } finally {
    await gone(parser);
  }

  if (answer.kind === "failed") {
    throw new DocumentTextFailed(answer.failure);
  }
  const last = Math.min(range.lastPage, answer.pageCount);
  return {
    pageCount: answer.pageCount,
    pages: answer.pages,
    // No page at all is a range past the last one, which says nothing about
    // the file; a page cut to nothing by the cap was read and had text.
    textLayer: answer.textLayer || answer.pages.length === 0,
    truncated: answer.stopped !== null,
    next:
      answer.stopped ??
      (last < answer.pageCount ? { page: last + 1, character: 0 } : null),
  };
}

const MEBIBYTE = 1024 * 1024;

/**
 * How often the API looks at a parser's memory. A decompressor writes a few
 * gibibytes a second, so the process is killed within some tens of mebibytes
 * of the cap.
 */
const MEMORY_WATCH_MILLISECONDS = 25;

/**
 * The parser's answer to `request`, or the refusal for a parser that gave
 * none: one that ran over the time or the memory, or exited without answering.
 */
function settled(
  parser: ChildProcess,
  limits: DocumentTextLimits,
  request: object,
): Promise<ParserAnswer> {
  return new Promise<ParserAnswer>((resolve, reject) => {
    let killedFor: DocumentTextFailure | null = null;
    const kill = (failure: DocumentTextFailure): void => {
      killedFor ??= failure;
      parser.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      kill("read-timed-out");
    }, limits.milliseconds);
    const watch = setInterval(() => {
      void residentBytes(parser.pid).then((bytes) => {
        if (bytes === null) {
          // Not reported here: the parser's own watch and heap cap remain.
          clearInterval(watch);
        } else if (bytes > limits.memoryMb * MEBIBYTE) {
          kill("too-large-to-read");
        }
      });
    }, MEMORY_WATCH_MILLISECONDS);
    const done = (): void => {
      clearTimeout(timer);
      clearInterval(watch);
    };

    parser.once("message", (message: ParserAnswer) => {
      done();
      resolve(message);
    });
    // A parser that could not be started, or was not there to be sent to.
    parser.once("error", () => {
      done();
      reject(new DocumentTextFailed("unreadable"));
    });
    // Killed by the time or the memory watch, stopped by its own watch, or
    // ended any other way: the heap running out, a crash. A file that does
    // that is a file this cannot read.
    parser.once("exit", (code) => {
      done();
      reject(
        new DocumentTextFailed(
          killedFor ??
            (code === OUT_OF_MEMORY_EXIT ? "too-large-to-read" : "unreadable"),
        ),
      );
    });
    // A parser gone before the request reached it is answered by its exit.
    parser.send(request, () => undefined);
  });
}

/**
 * The memory the operating system counts for a process, where it says so to
 * another process: Linux, through /proc. Null elsewhere, and once it is gone.
 */
async function residentBytes(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) {
    return null;
  }
  try {
    const status = await readFile(`/proc/${String(pid)}/status`, "utf8");
    const resident = /^VmRSS:\s+(\d+) kB$/mu.exec(status);
    return resident === null ? null : Number(resident[1]) * 1024;
  } catch {
    return null;
  }
}

/** Kills a parser that still runs, and waits until it has exited. */
async function gone(parser: ChildProcess): Promise<void> {
  if (
    parser.pid === undefined ||
    parser.exitCode !== null ||
    parser.signalCode !== null
  ) {
    return;
  }
  const exited = new Promise((resolve) => parser.once("exit", resolve));
  parser.kill("SIGKILL");
  await exited;
}
