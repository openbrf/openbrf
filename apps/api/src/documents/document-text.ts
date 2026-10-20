import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

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
 * synchronously for as long as a page takes. A file built to take a long time,
 * or to grow the heap, would hold the API's event loop with it. So the parser
 * runs in a worker thread with a heap of its own, and the worker is terminated
 * when the time is up. That is the only cap that holds against a synchronous
 * loop: a timer in the same thread never gets to run.
 *
 * ## What the parser is allowed to do
 *
 * The settings in {@link WORKER_SOURCE} are the security review's subject, and
 * each says no to something a text read does not need:
 *
 * - the bytes are handed over, so no URL is given and nothing is fetched;
 * - no system font is read and no font face is built;
 * - no WebAssembly decoder, offscreen canvas or image decoder is used, since
 *   text extraction never decodes an image;
 * - XFA forms are not rendered;
 * - the worker gets an empty environment, so no secret of the API's is in it,
 *   and its console output is discarded rather than logged, because pdf.js
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
  /** How long the parser may take before the worker is terminated. */
  milliseconds: 10_000,
  /** The worker's own heap. Past it, the worker dies and the API does not. */
  heapMb: 128,
  /**
   * How many reads run at once on this instance. Each holds a decrypted file of
   * up to the size above and a thread with the heap above, so without a ceiling
   * one connected app calling in parallel could hold every core and a gigabyte
   * of memory with files the API serves anyway. A read past it is refused
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
 * The worker, as source.
 *
 * Plain JavaScript evaluated by the worker rather than a file of its own, so
 * that one path works both from the compiled API and under the test runner,
 * which do not agree on what a sibling file is called. It imports nothing but
 * pdf.js, from the file the API resolved.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

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

async function read() {
  const pdfjs = await import(workerData.parser);
  const task = pdfjs.getDocument({
    data: new Uint8Array(workerData.bytes),
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
  const last = Math.min(workerData.lastPage, pageCount);
  const pages = [];
  let characters = 0;
  let textLayer = false;
  let stopped = null;
  for (let number = workerData.firstPage; number <= last; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const whole = tidy(
      content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\\n" : "") : ""))
        .join(""),
    );
    page.cleanup();
    textLayer = textLayer || whole !== "";
    const start = number === workerData.firstPage ? workerData.firstCharacter : 0;
    const text = whole.slice(start);
    const room = workerData.maxCharacters - characters;
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

read().then(
  (answer) => parentPort.postMessage(answer),
  () => parentPort.postMessage({ kind: "failed", failure: "unreadable" }),
);
`;

type WorkerAnswer =
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

/** The parser's entry, resolved the way the API resolves its own modules. */
function parserUrl(): string {
  return pathToFileURL(hostRequire().resolve("pdfjs-dist/legacy/build/pdf.mjs"))
    .href;
}

/** The reads running now, against {@link DOCUMENT_TEXT_LIMITS.concurrentReads}. */
let running = 0;

/**
 * Reads the text of the pages from `firstPage` to `lastPage` of a PDF, from
 * `firstCharacter` of the first.
 *
 * `load` fetches the file, and is called only once the read has its place
 * among those running at once: a read refused for that never opens the file,
 * so the ceiling bounds the decrypted bytes held as well as the workers.
 *
 * The range is clipped to the pages the file has, so a range that starts past
 * the last page answers with the page count and no pages. Refuses a range over
 * the page cap, a read past the number running at once, a file over the size
 * cap before it reaches the parser, and a read that runs over the time cap or
 * the heap.
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
    return await readInWorker(bytes, { ...range, firstCharacter }, limits);
  } finally {
    running -= 1;
  }
}

/** One read, in a worker that is gone again when this returns. */
async function readInWorker(
  bytes: Buffer,
  range: Required<DocumentTextRange>,
  limits: DocumentTextLimits,
): Promise<DocumentText> {
  // A copy the worker is handed outright, rather than a view into a pooled
  // buffer the API still holds.
  const owned = Uint8Array.from(bytes).buffer;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    env: {},
    stdout: true,
    stderr: true,
    workerData: {
      parser: parserUrl(),
      bytes: owned,
      firstPage: range.firstPage,
      lastPage: range.lastPage,
      firstCharacter: range.firstCharacter,
      maxCharacters: limits.charactersPerRead,
    },
    transferList: [owned],
    resourceLimits: {
      maxOldGenerationSizeMb: limits.heapMb,
      maxYoungGenerationSizeMb: Math.max(8, Math.floor(limits.heapMb / 4)),
    },
  });
  // Read and dropped: pdf.js warnings can quote the document, and nothing the
  // parser says belongs in the API's log.
  worker.stdout.resume();
  worker.stderr.resume();

  // Terminated before this returns, whichever way it returns, so a read that
  // has been answered no longer counts against the ceiling and no longer runs.
  let answer: WorkerAnswer;
  try {
    answer = await settled(worker, limits.milliseconds);
  } finally {
    await worker.terminate();
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

/**
 * The worker's answer, or the refusal for a worker that gave none: one that
 * ran over the time, ran out of heap, or exited without answering.
 */
function settled(worker: Worker, milliseconds: number): Promise<WorkerAnswer> {
  return new Promise<WorkerAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DocumentTextFailed("read-timed-out"));
    }, milliseconds);
    worker.once("message", (message: WorkerAnswer) => {
      clearTimeout(timer);
      resolve(message);
    });
    // The heap running out ends up here, as ERR_WORKER_OUT_OF_MEMORY: a file
    // built to grow the heap is a file this cannot read.
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new DocumentTextFailed("unreadable"));
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      reject(new DocumentTextFailed("unreadable"));
    });
  });
}
