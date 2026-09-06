/**
 * Reading one collected message into the few things the board needs from it.
 *
 * ## Everything here is untrusted input
 *
 * A message in the board's mailbox was written by whoever chose to write to the
 * association, and every field in it - the sender, the subject, the encoding
 * each part claims, the name an attachment gives itself - is an assertion by
 * that person and nothing more. So this reader has one rule that shapes the rest
 * of it: **it produces text and bytes, never markup and never an identity.**
 *
 * There is no sanitiser here because there is nothing to sanitise. An HTML part
 * is converted to text as it is read and the markup is discarded, rather than
 * stored for a later screen, export or mail template to render by mistake; a
 * sanitised string kept in the database is one refactor away from being rendered
 * as HTML somewhere else, and a message that never held markup cannot be. What
 * is lost is formatting, and a board reading a letter loses nothing by reading
 * it as the sender's words rather than as their layout.
 *
 * An attachment's declared type is likewise not believed. This hands the caller
 * the bytes and the name, and the media layer identifies the file from its own
 * header exactly as it does for an upload from a browser - which is why a
 * message claiming a PDF and carrying something else is refused there rather
 * than trusted here.
 *
 * ## Written rather than taken as a dependency
 *
 * MIME is old and wide, and most of the width is for composing rather than for
 * reading one letter's text and its attachments. What that needs is header
 * unfolding, encoded words (RFC 2047), two content transfer encodings and a
 * boundary walk - all of which is specified precisely, testable against the
 * specification's own examples, and small enough to read. The alternative is a
 * mail-parsing library in a stack this project moves as one, for a surface this
 * narrow. Character sets are the part that would ordinarily justify one, and the
 * runtime already carries them: `TextDecoder` decodes every legacy encoding a
 * Swedish correspondent's mail client might still send, including the two that
 * matter here (ISO-8859-1 and Windows-1252).
 */

/** One file that arrived attached to a message. */
export interface MimeAttachment {
  /**
   * The name the sender gave it, or a generated one.
   *
   * Never used to build a storage key or to decide a type: the media layer
   * generates the key and reads the type out of the bytes. It is what the board
   * is shown and what a download is offered under.
   */
  readonly fileName: string;
  /** The type the sender declared. Recorded, never believed. */
  readonly declaredContentType: string;
  readonly bytes: Buffer;
}

export interface ParsedMessage {
  /** The subject line, decoded. Empty when the message carried none. */
  readonly subject: string;
  /** The address the message claims to come from, lowercased, or null. */
  readonly fromAddress: string | null;
  /** The display name beside it, decoded, or null. */
  readonly fromName: string | null;
  /** RFC 5322 Message-ID without its angle brackets, or null. */
  readonly messageId: string | null;
  /** The Message-ID this is an answer to, or null. */
  readonly inReplyTo: string | null;
  /**
   * When the sender's client says it was written.
   *
   * Null when the header is missing or unreadable. It is the sender's clock, so
   * the caller decides how far to trust it.
   */
  readonly date: Date | null;
  /** The message as text, with newlines normalised. */
  readonly text: string;
  /** Whether {@link text} was derived from an HTML part rather than sent as text. */
  readonly textFromHtml: boolean;
  readonly attachments: readonly MimeAttachment[];
}

/** A parsed content type: "text/plain; charset=utf-8" and its parameters. */
interface ContentType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: ReadonlyMap<string, string>;
}

interface MimePart {
  readonly headers: ReadonlyMap<string, string>;
  readonly contentType: ContentType;
  readonly disposition: string | null;
  readonly dispositionParameters: ReadonlyMap<string, string>;
  /** Raw, still in the transfer encoding the part declares. */
  readonly body: Buffer;
  /** Null for a leaf; the parts inside for a multipart. */
  readonly children: readonly MimePart[] | null;
}

/**
 * Reads one message.
 *
 * Never throws on malformed input. A letter to a board is worth showing even
 * when the client that produced it got MIME wrong, so every layer here has an
 * answer for input it cannot make sense of: an unparseable multipart is read as
 * one text part, an unknown transfer encoding is read as the bytes themselves,
 * an unknown character set is read as UTF-8, and a message with no readable body
 * comes back with an empty one.
 */
export function readMessage(raw: Buffer): ParsedMessage {
  const part = parsePart(raw);
  const body = chooseBody(part);

  return {
    subject: decodeEncodedWords(part.headers.get("subject") ?? "").trim(),
    fromAddress: addressFrom(part.headers.get("from") ?? ""),
    fromName: displayNameFrom(part.headers.get("from") ?? ""),
    messageId: identifierFrom(part.headers.get("message-id") ?? ""),
    // References is the fallback because some clients send only that; its last
    // entry is the message being answered, which is what In-Reply-To names.
    inReplyTo:
      identifierFrom(part.headers.get("in-reply-to") ?? "") ??
      lastIdentifierFrom(part.headers.get("references") ?? ""),
    date: dateFrom(part.headers.get("date") ?? ""),
    text: body?.text ?? "",
    textFromHtml: body?.fromHtml ?? false,
    attachments: collectAttachments(part, body?.part ?? null),
  };
}

// ---------------------------------------------------------------------------
// Structure.
// ---------------------------------------------------------------------------

/**
 * How deep a multipart may nest.
 *
 * A part inside a part inside a part is an ordinary letter - written in both
 * text and HTML, with an attachment, forwarded - and a handful of levels covers
 * anything a mail client composes. Past that it is not a letter: one level costs
 * about fifty bytes of input, so a message far inside the size the collector
 * will fetch encodes thousands of them, and the walk below is recursive, so a
 * message a stranger only has to send to the board's published address would run
 * the stack out. That would throw where this file promises never to, and because
 * nothing is deleted from the mailbox the same letter would end every collection
 * from then on.
 *
 * At the cap the part is read as text, which is the degradation this file
 * already applies to a multipart it cannot walk for any other reason.
 */
const MAX_MULTIPART_DEPTH = 20;

function parsePart(raw: Buffer, depth = 0): MimePart {
  const separator = findHeaderEnd(raw);
  const headerBytes = raw.subarray(0, separator.headerEnd);
  const body = raw.subarray(separator.bodyStart);

  const headers = parseHeaders(headerBytes);
  const contentType = parseContentType(
    headers.get("content-type") ?? "text/plain",
  );
  const rawDisposition = headers.get("content-disposition") ?? "";
  const disposition =
    rawDisposition === ""
      ? null
      : (rawDisposition.split(";")[0] ?? "").trim().toLowerCase();

  const children =
    contentType.type === "multipart" && depth < MAX_MULTIPART_DEPTH
      ? splitMultipart(body, contentType.parameters.get("boundary"), depth + 1)
      : null;

  return {
    headers,
    /*
     * A multipart this reader did not walk - because its boundary is nowhere in
     * its body, or because it nests deeper than the cap above - is read as one
     * text part, which is what the module comment promises for structure that
     * cannot be read. Without this the part stays typed `multipart`, no rule
     * downstream accepts it as a body, and a letter whose sender's client got
     * the boundary wrong reaches the board as nothing at all - a message
     * silently emptied, which is the worst of the three possible outcomes.
     *
     * The parameters go with it. A boundary that matched nothing says nothing
     * about the bytes, and a charset declared beside it still does.
     */
    contentType:
      contentType.type === "multipart" && children === null
        ? { type: "text", subtype: "plain", parameters: contentType.parameters }
        : contentType,
    disposition,
    dispositionParameters: parseParameters(rawDisposition),
    body,
    children,
  };
}

/**
 * Where the headers stop.
 *
 * A blank line, in either line ending. Messages use CRLF by the specification
 * and some clients send LF anyway, and a reader that insisted on CRLF would
 * treat one of those letters as a single header block with no body at all.
 */
function findHeaderEnd(raw: Buffer): { headerEnd: number; bodyStart: number } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");

  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { headerEnd: crlf, bodyStart: crlf + 4 };
  }
  if (lf !== -1) {
    return { headerEnd: lf, bodyStart: lf + 2 };
  }
  return { headerEnd: raw.length, bodyStart: raw.length };
}

/**
 * Header names to their values, lowercased and unfolded.
 *
 * A repeated header keeps the first occurrence. Every header this module reads
 * may appear at most once by the specification, and a message carrying two
 * Subject lines is one trying to have it both ways: the first is what a reader
 * scrolling from the top would see.
 */
/**
 * The longest header value this reader keeps.
 *
 * RFC 5322 bounds a header line at 998 octets and permits folding beyond it, so
 * a legitimate value can be longer - a References chain on a conversation that
 * has run for months is the honest case. This is far above that and still
 * finite, which is what a value composed by somebody outside the association has
 * to be: the message as a whole is already bounded when it is fetched, and this
 * is the same bound applied to the one field rather than to the letter.
 *
 * Truncation can cut an encoded word in half, and the result is then text that
 * is not quite what was sent. That is the right trade at this length: a header
 * this long is not a subject line anybody typed.
 */
const MAX_HEADER_VALUE = 8 * 1024;

function parseHeaders(raw: Buffer): ReadonlyMap<string, string> {
  // latin1 rather than utf8, because a header is bytes until an encoded word
  // says otherwise: decoding as UTF-8 here would replace the raw octets of a
  // header some client sent unencoded, and RFC 2047 decoding could not recover
  // them. Anything genuinely UTF-8 arrives inside an encoded word.
  const lines = raw.toString("latin1").split(/\r?\n/);
  const headers = new Map<string, string>();

  let name: string | null = null;
  let value = "";

  const flush = (): void => {
    if (name !== null && !headers.has(name)) {
      headers.set(name, value.trim().slice(0, MAX_HEADER_VALUE));
    }
    name = null;
    value = "";
  };

  for (const line of lines) {
    if (line === "") {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      // A continuation. The fold is replaced by the single space the
      // specification says it stands for.
      //
      // Stopped at the bound rather than concatenated and cut afterwards: a
      // header folded across ten thousand lines would otherwise be assembled in
      // full before anything looked at its length.
      if (value.length <= MAX_HEADER_VALUE) {
        value += ` ${line.trim()}`;
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    flush();
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1).trim();
  }
  flush();

  return headers;
}

function parseContentType(raw: string): ContentType {
  const media = (raw.split(";")[0] ?? "").trim().toLowerCase();
  const slash = media.indexOf("/");
  const type = slash === -1 ? media : media.slice(0, slash);
  const subtype = slash === -1 ? "" : media.slice(slash + 1);

  return {
    type: type === "" ? "text" : type,
    subtype: subtype === "" ? "plain" : subtype,
    parameters: parseParameters(raw),
  };
}

/**
 * The `; name=value` parameters on a header.
 *
 * Handles the quoted form and RFC 2231's extended one (`filename*=utf-8''...`),
 * which is how every current client sends a filename that is not plain ASCII -
 * which for a Swedish housing cooperative is most of them.
 */
function parseParameters(raw: string): ReadonlyMap<string, string> {
  const parameters = new Map<string, string>();

  for (const segment of splitParameters(raw).slice(1)) {
    const equals = segment.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const name = segment.slice(0, equals).trim().toLowerCase();
    let value = segment.slice(equals + 1).trim();

    if (value.startsWith('"')) {
      value = value.slice(1, value.endsWith('"') ? -1 : undefined);
      value = value.replaceAll(/\\(.)/g, "$1");
    }

    if (name.endsWith("*")) {
      // charset'language'percent-encoded-value. Only the first and last parts
      // carry anything this reader wants.
      const parts = value.split("'");
      const charset = parts.length >= 3 ? parts[0] : "utf-8";
      const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
      parameters.set(
        name.slice(0, -1),
        decodePercent(encoded, charset ?? "utf-8"),
      );
      continue;
    }

    if (!parameters.has(name)) {
      parameters.set(name, value);
    }
  }

  return parameters;
}

/** Splits on ";" while leaving the ones inside a quoted string alone. */
function splitParameters(raw: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && raw[index - 1] !== "\\") {
      quoted = !quoted;
    }
    if (character === ";" && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments;
}

function decodePercent(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "%" && index + 2 < value.length) {
      const code = Number.parseInt(value.slice(index + 1, index + 3), 16);
      if (Number.isFinite(code)) {
        bytes.push(code);
        index += 2;
        continue;
      }
    }
    bytes.push(value.charCodeAt(index) & 0xff);
  }
  return decodeBytes(Buffer.from(bytes), charset);
}

/**
 * The parts of a multipart body.
 *
 * Returns null when the boundary is missing or matches nothing, which puts the
 * caller back on the leaf path: a message whose structure cannot be read is
 * still shown to the board as whatever text it holds, rather than as nothing.
 */
function splitMultipart(
  body: Buffer,
  boundary: string | undefined,
  depth: number,
): readonly MimePart[] | null {
  if (boundary === undefined || boundary === "") {
    return null;
  }

  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const sections: Buffer[] = [];
  let cursor = findDelimiter(body, delimiter, 0);
  if (cursor === -1) {
    return null;
  }

  for (;;) {
    const start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString("latin1") === "--") {
      break;
    }
    const next = findDelimiter(body, delimiter, start);
    // The preamble before the first delimiter and the epilogue after the last
    // are not parts and are dropped, which is what the specification says they
    // are: text for a reader whose client cannot do MIME at all.
    const section = body.subarray(
      skipLineBreak(body, start),
      next === -1 ? body.length : trimLineBreak(body, next),
    );
    sections.push(section);
    if (next === -1) {
      break;
    }
    cursor = next;
  }

  return sections.length === 0
    ? null
    : sections.map((part) => parsePart(part, depth));
}

/**
 * The next boundary delimiter, at the start of a line.
 *
 * Anchored rather than found anywhere, because the message was written by
 * somebody outside the association: a body that quoted its own boundary string
 * mid-line would otherwise split the message wherever the sender chose. A
 * delimiter is a delimiter only at a line start (RFC 2046 section 5.1.1), and
 * saying so here is what makes the walk depend on the structure rather than on
 * the content.
 */
function findDelimiter(body: Buffer, delimiter: Buffer, from: number): number {
  for (let at = body.indexOf(delimiter, from); at !== -1;) {
    if (at === 0 || body[at - 1] === 0x0a) {
      return at;
    }
    at = body.indexOf(delimiter, at + 1);
  }
  return -1;
}

function skipLineBreak(body: Buffer, at: number): number {
  if (body[at] === 0x0d && body[at + 1] === 0x0a) {
    return at + 2;
  }
  if (body[at] === 0x0a) {
    return at + 1;
  }
  return at;
}

function trimLineBreak(body: Buffer, at: number): number {
  if (at >= 2 && body[at - 2] === 0x0d && body[at - 1] === 0x0a) {
    return at - 2;
  }
  if (at >= 1 && body[at - 1] === 0x0a) {
    return at - 1;
  }
  return at;
}

// ---------------------------------------------------------------------------
// The body.
// ---------------------------------------------------------------------------

interface ChosenBody {
  readonly part: MimePart;
  readonly text: string;
  readonly fromHtml: boolean;
}

/**
 * The part a reader is meant to read.
 *
 * `multipart/alternative` is the case the rest follows from: its children are
 * the same message written twice, so exactly one of them is the body and the
 * other must not also appear. Plain text is preferred over HTML because it is
 * what the sender typed rather than a rendering of it, and the last matching
 * child is preferred over the first because a client puts its richest
 * alternative last.
 */
function chooseBody(part: MimePart): ChosenBody | null {
  if (part.children !== null) {
    if (part.contentType.subtype === "alternative") {
      return (
        lastBody(part.children, (candidate) => candidate.fromHtml === false) ??
        lastBody(part.children, () => true)
      );
    }
    for (const child of part.children) {
      const chosen = chooseBody(child);
      if (chosen !== null) {
        return chosen;
      }
    }
    return null;
  }

  if (isAttachment(part) || part.contentType.type !== "text") {
    return null;
  }

  const charset = part.contentType.parameters.get("charset") ?? "utf-8";
  const decoded = decodeBytes(decodeTransfer(part), charset);

  if (part.contentType.subtype === "html") {
    return { part, text: htmlToText(decoded), fromHtml: true };
  }
  return { part, text: normaliseNewlines(decoded), fromHtml: false };
}

function lastBody(
  children: readonly MimePart[],
  accept: (candidate: ChosenBody) => boolean,
): ChosenBody | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) {
      continue;
    }
    const chosen = chooseBody(child);
    if (chosen !== null && accept(chosen)) {
      return chosen;
    }
  }
  return null;
}

/**
 * Every leaf that is a file rather than the letter.
 *
 * The rule is the sender's own declaration: a part is an attachment when it
 * carries a filename or says it is one. A part that does neither is inline
 * content - the HTML twin of a plain-text body, most often - and turning those
 * into files would give the board an "attachment" on every message a mail client
 * ever sent it.
 */
function collectAttachments(
  part: MimePart,
  body: MimePart | null,
): readonly MimeAttachment[] {
  const attachments: MimeAttachment[] = [];

  const walk = (candidate: MimePart): void => {
    if (candidate.children !== null) {
      for (const child of candidate.children) {
        walk(child);
      }
      return;
    }
    if (candidate === body || !isAttachment(candidate)) {
      return;
    }
    const bytes = decodeTransfer(candidate);
    if (bytes.length === 0) {
      return;
    }
    attachments.push({
      fileName: fileNameOf(candidate, attachments.length),
      declaredContentType: `${candidate.contentType.type}/${candidate.contentType.subtype}`,
      bytes,
    });
  };

  walk(part);
  return attachments;
}

function isAttachment(part: MimePart): boolean {
  return (
    part.disposition === "attachment" ||
    part.dispositionParameters.has("filename") ||
    part.contentType.parameters.has("name")
  );
}

function fileNameOf(part: MimePart, position: number): string {
  const declared =
    part.dispositionParameters.get("filename") ??
    part.contentType.parameters.get("name");

  const decoded = decodeEncodedWords(declared ?? "").trim();
  if (decoded !== "") {
    /*
     * The last path segment, and nothing that could be one. A filename is
     * chosen by whoever sent the message, so it is treated as a label: the media
     * layer generates the storage key from its own bytes and never from this,
     * and stripping the separators here means the value cannot read as a path
     * anywhere it is later shown or offered as a download either.
     */
    const segments = decoded.split(/[/\\]/);
    const last = segments[segments.length - 1] ?? "";
    const cleaned = last.replaceAll(CONTROL_CHARACTERS, "").trim();
    if (cleaned !== "" && cleaned !== "." && cleaned !== "..") {
      return cleaned.slice(0, 200);
    }
  }

  return `bilaga-${String(position + 1)}`;
}

// ---------------------------------------------------------------------------
// Encodings.
// ---------------------------------------------------------------------------

function decodeTransfer(part: MimePart): Buffer {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "")
    .trim()
    .toLowerCase();

  if (encoding === "base64") {
    // Whitespace is stripped rather than left to the decoder: a base64 body is
    // wrapped at 76 columns, and Node stops at the first character outside the
    // alphabet on some inputs.
    return Buffer.from(
      part.body.toString("latin1").replaceAll(/\s+/g, ""),
      "base64",
    );
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(part.body);
  }
  // 7bit, 8bit, binary, and anything unrecognised: the bytes as they arrived,
  // which is the right answer for the three named encodings and the least wrong
  // one for a name this reader does not know.
  return part.body;
}

function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw.toString("latin1");
  const bytes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "=") {
      bytes.push(text.charCodeAt(index) & 0xff);
      continue;
    }

    // A soft line break: "=" at the end of a line means the line continues.
    if (text.startsWith("\r\n", index + 1)) {
      index += 2;
      continue;
    }
    if (text[index + 1] === "\n") {
      index += 1;
      continue;
    }

    const hex = text.slice(index + 1, index + 3);
    const code = /^[0-9a-fA-F]{2}$/.test(hex) ? Number.parseInt(hex, 16) : NaN;
    if (Number.isNaN(code)) {
      // A stray "=" that is not an escape. Kept, because it is what the sender
      // typed and dropping it would silently edit their words.
      bytes.push(0x3d);
      continue;
    }
    bytes.push(code);
    index += 2;
  }

  return Buffer.from(bytes);
}

/**
 * Bytes to text in whatever character set the part declared.
 *
 * An unknown or unsupported label falls back to UTF-8 rather than failing.
 * `TextDecoder` is lenient by default, so a byte that is not valid in the chosen
 * encoding becomes a replacement character - a letter with one broken word in it
 * is worth more to a board than no letter at all.
 */
function decodeBytes(bytes: Buffer, charset: string): string {
  const label = charset.trim().replaceAll(/^["']|["']$/g, "");
  try {
    return new TextDecoder(label === "" ? "utf-8" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * RFC 2047 encoded words: `=?charset?B?...?=` and `=?charset?Q?...?=`.
 *
 * Whitespace between two adjacent encoded words is removed, which the
 * specification requires: a long subject is split across several words and the
 * space between them is the fold rather than a space the sender typed.
 */
export function decodeEncodedWords(raw: string): string {
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let result = "";
  let cursor = 0;
  let afterWord = false;

  for (
    let match = pattern.exec(raw);
    match !== null;
    match = pattern.exec(raw)
  ) {
    const [whole, charset = "utf-8", encoding = "q", payload = ""] = match;
    const between = raw.slice(cursor, match.index);

    // Whitespace separating two encoded words is the fold rather than a space
    // the sender typed, so it goes. Anything else between them is kept.
    if (!(afterWord && between.trim() === "")) {
      result += between;
    }

    const bytes =
      encoding.toLowerCase() === "b"
        ? Buffer.from(payload.replaceAll(/\s+/g, ""), "base64")
        : // Q differs from quoted-printable in exactly one way: "_" is a space.
          decodeQuotedPrintable(
            Buffer.from(payload.replaceAll("_", " "), "latin1"),
          );

    result += decodeBytes(bytes, charset);
    cursor = match.index + whole.length;
    afterWord = true;
  }

  return result + raw.slice(cursor);
}

/**
 * The characters a sender may not put into a name this application shows.
 *
 * Control characters only. They have no place in a filename or a display name,
 * and a log line, a terminal or a download header is where one of them stops
 * being invisible.
 *
 * The rule against matching control characters in a pattern is disabled for this
 * one line, which is the case it makes an exception for: this pattern exists in
 * order to remove them from a value somebody outside the association chose, and
 * the alternative to naming them is not naming them.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

// ---------------------------------------------------------------------------
// Header values.
// ---------------------------------------------------------------------------

/** The address out of a From header, lowercased, or null. */
export function addressFrom(raw: string): string | null {
  const angled = /<([^<>]*)>/.exec(raw);
  const candidate = (angled?.[1] ?? raw).trim().replaceAll(/^["']|["']$/g, "");

  // One "@" with something either side, and no whitespace. Deliberately not a
  // full RFC 5322 address grammar: what this decides is whether the value can be
  // stored and replied to, and the mail server is the authority on the rest.
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** The display name out of a From header, decoded, or null. */
export function displayNameFrom(raw: string): string | null {
  const angled = raw.indexOf("<");
  if (angled === -1) {
    return null;
  }
  const name = decodeEncodedWords(raw.slice(0, angled).trim())
    .replaceAll(/^["']|["']$/g, "")
    .replaceAll(CONTROL_CHARACTERS, "")
    .trim();
  return name === "" ? null : name.slice(0, 200);
}

/** A Message-ID without its angle brackets, or null. */
/**
 * A Message-ID as RFC 5322 section 3.6.4 writes it, without its brackets.
 *
 * Both halves are dot-atoms: runs of printable ASCII from a fixed set, joined by
 * single dots. Held to the grammar rather than taken as whatever stood between
 * the brackets, because what comes out of here is composed back into the
 * In-Reply-To and References of the board's own answer. The brackets around it
 * there are this instance's; the value between them was written by whoever sent
 * the letter, and a value carrying its own bracket makes a header that says
 * something the board did not.
 *
 * A message whose identifier is outside the grammar keeps none: it opens its own
 * thread rather than joining one, which is the same answer this module gives to
 * a message that carried no identifier at all.
 */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOT_ATOM = `${ATEXT}+(?:\\.${ATEXT}+)*`;
const MESSAGE_ID = new RegExp(`^${DOT_ATOM}@${DOT_ATOM}$`);

function isIdentifier(value: string): boolean {
  return value.length <= 500 && MESSAGE_ID.test(value);
}

function identifierFrom(raw: string): string | null {
  const match = /<([^<>\s]+)>/.exec(raw);
  const value = (match?.[1] ?? raw).trim();
  return isIdentifier(value) ? value : null;
}

/**
 * The newest identifier in a References header, which is what was answered.
 *
 * Only the newest. An older entry names a message further back in the same
 * conversation, so falling through to one when the newest is unreadable would
 * attach the letter to a message it is not a reply to.
 */
function lastIdentifierFrom(raw: string): string | null {
  const matches = [...raw.matchAll(/<([^<>\s]+)>/g)];
  const last = matches[matches.length - 1]?.[1];
  return last !== undefined && isIdentifier(last) ? last : null;
}

/**
 * The Date header, or null.
 *
 * `Date` parses RFC 2822 dates, which is the format this header is in. A value
 * it cannot read comes back null rather than as an invalid date, so the caller
 * never stores one.
 */
function dateFrom(raw: string): Date | null {
  if (raw.trim() === "") {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// HTML to text.
// ---------------------------------------------------------------------------

/**
 * The delimiters of an HTML comment.
 *
 * Assembled from two pieces rather than written whole. Either sequence in one
 * literal ends the parse behind the security scan early, which leaves the rest
 * of this file unread and fails that scan without naming a rule.
 */
const COMMENT_OPEN = "<!" + "--";
const COMMENT_CLOSE = "--" + ">";

/** Elements whose closing tag ends a line. */
const BREAK_AFTER = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "table",
  "tr",
]);

/** Elements that are a line break where they stand. */
const BREAK_AT = new Set(["br", "hr", "li"]);

/** Elements whose content is neither markup nor words. */
const RAW_TEXT = new Set(["script", "style"]);

/**
 * An HTML part as the words it contains.
 *
 * Not a renderer and not a sanitiser. The reader walks the input once and keeps
 * only the character data: every tag, comment and declaration is dropped where
 * it stands, and the content of a script or style element is dropped with it,
 * because it is not words the sender wrote to the board.
 *
 * What comes out is text, and only a reader that treats it as text is correct.
 * It is not free of angle brackets and cannot be: a letter that writes `&lt;`
 * means the character, so the entity decoding below puts `<` and `>` back, and
 * a sender who escaped a whole tag gets back the characters that spelled it.
 * The result is stored as the message body, which is shown as text and sent on
 * as text/plain.
 *
 * Reading the input rather than rewriting it is what makes that boundary hold.
 * A pass that deletes tag-shaped substrings has to decide what a tag looks like
 * in a pattern, and every such pattern is narrower than the tokeniser a browser
 * runs: a closing tag may carry attributes, an attribute value may hold a `>`,
 * and a `<` that opens nothing is a character the sender typed. Each of those
 * is a place where content escapes the filter or text is eaten as if it were
 * markup, and the reader below has no such gap to write down.
 *
 * The block elements that become line breaks are the ones whose absence would
 * run a letter into one paragraph. Everything else is dropped silently: this is
 * a fallback for a message that was not also sent as text, and a board reading
 * one wants the sentences.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const pieces: string[] = [];
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pieces.push(html.slice(index));
      break;
    }
    pieces.push(html.slice(index, open));

    const markup = readMarkup(html, lower, open);
    if (markup === null) {
      // A "<" that opens nothing is the character the sender typed.
      pieces.push("<");
      index = open + 1;
      continue;
    }

    pieces.push(markup.text);
    index = markup.end;
  }

  return normaliseNewlines(decodeEntities(pieces.join("")))
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** What one markup construct contributes to the text, and where it ends. */
interface Markup {
  readonly text: string;
  readonly end: number;
}

/**
 * The construct that opens at `open`, or null when the `<` opens nothing.
 *
 * `lower` is `html` lowercased once by the caller, so that comparing a name
 * costs no allocation per tag.
 */
function readMarkup(html: string, lower: string, open: number): Markup | null {
  if (lower.startsWith(COMMENT_OPEN, open)) {
    return { text: "", end: commentEnd(html, open + COMMENT_OPEN.length) };
  }

  const second = html.charAt(open + 1);

  if (second === "!" || second === "?") {
    // A declaration, or a comment written the way no specification allows.
    return { text: "", end: upToClose(html, open + 2) };
  }

  if (second === "/") {
    const closing = readName(lower, open + 2);
    if (closing === "") {
      return { text: "", end: upToClose(html, open + 2) };
    }
    return {
      text: BREAK_AFTER.has(closing) ? "\n" : "",
      end: tagEnd(html, open + 2 + closing.length),
    };
  }

  const name = readName(lower, open + 1);
  if (name === "") {
    return null;
  }

  const end = tagEnd(html, open + 1 + name.length);
  if (RAW_TEXT.has(name)) {
    return { text: "", end: rawTextEnd(html, lower, end, name) };
  }
  return { text: BREAK_AT.has(name) ? "\n" : "", end };
}

/**
 * Where the comment whose opening delimiter ended at `from` ends.
 *
 * The two shortest comments the specification allows close on the dashes that
 * opened them, so both are recognised before the closing delimiter is looked
 * for. A comment that is never closed runs to the end of the input.
 */
function commentEnd(html: string, from: number): number {
  if (html.charAt(from) === ">") {
    return from + 1;
  }
  if (html.startsWith("->", from)) {
    return from + 2;
  }
  const close = html.indexOf(COMMENT_CLOSE, from);
  return close === -1 ? html.length : close + COMMENT_CLOSE.length;
}

/** The first `>` at or after `from`, or the end of the input. */
function upToClose(html: string, from: number): number {
  const close = html.indexOf(">", from);
  return close === -1 ? html.length : close + 1;
}

/**
 * Where the tag whose name ended at `from` ends.
 *
 * A quoted attribute value may hold a `>`, so a quote that follows the `=` is
 * read to its closing quote instead of being scanned for the end of the tag.
 * Attributes are otherwise not read: nothing here needs their values.
 */
function tagEnd(html: string, from: number): number {
  let index = from;
  let afterEquals = false;

  while (index < html.length) {
    const character = html.charAt(index);

    if (character === ">") {
      return index + 1;
    }

    if (character === "=") {
      afterEquals = true;
      index += 1;
      continue;
    }

    if (afterEquals && (character === '"' || character === "'")) {
      const close = html.indexOf(character, index + 1);
      if (close === -1) {
        return html.length;
      }
      index = close + 1;
      afterEquals = false;
      continue;
    }

    if (!isSpace(character)) {
      afterEquals = false;
    }
    index += 1;
  }

  return html.length;
}

/**
 * Where the raw text that began at `from` ends.
 *
 * It ends at a closing tag for the same element, whose name the specification
 * lets be followed by attributes and a solidus before the `>`; a name that runs
 * on into other letters is not that closing tag. An element that is never
 * closed holds the rest of the input.
 */
function rawTextEnd(
  html: string,
  lower: string,
  from: number,
  name: string,
): number {
  const closing = "</" + name;
  let index = from;

  while (index < html.length) {
    const at = lower.indexOf(closing, index);
    if (at === -1) {
      return html.length;
    }

    const after = html.charAt(at + closing.length);
    if (after === ">" || after === "/" || isSpace(after)) {
      return tagEnd(html, at + closing.length);
    }
    index = at + closing.length;
  }

  return html.length;
}

/** The element name at `from` in the lowercased input, or "" if none begins there. */
function readName(lower: string, from: number): string {
  let index = from;
  while (
    index < lower.length &&
    isNameCharacter(lower.charAt(index), index === from)
  ) {
    index += 1;
  }
  return lower.slice(from, index);
}

function isNameCharacter(character: string, first: boolean): boolean {
  if (character >= "a" && character <= "z") {
    return true;
  }
  return !first && character >= "0" && character <= "9";
}

function isSpace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

/**
 * The named entities a mail client actually emits, plus every numeric one.
 *
 * A full table is not wanted here: the five named entities below are what HTML
 * requires to be escaped, and anything else in a letter arrives as a character.
 * `&amp;` is resolved last so that an escaped entity in the source - `&amp;lt;` -
 * comes out as the text `&lt;` rather than being unescaped twice.
 */
function decodeEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_whole, hex: string) =>
      codePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/&#(\d+);/g, (_whole, digits: string) =>
      codePoint(Number.parseInt(digits, 10)),
    )
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/&quot;/g, '"')
    .replaceAll(/&apos;/g, "'")
    .replaceAll(/&amp;/g, "&");
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function normaliseNewlines(text: string): string {
  // The stored body is read on a screen and put back into a reply, and a mixture
  // of line endings in one string shows up in both.
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
