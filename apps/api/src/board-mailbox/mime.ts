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

import {
  CONTROL_CHARACTERS,
  hasControlCharacter,
  oneLine,
} from "../mail/header-text";

/**
 * How much of one letter is read.
 *
 * Long enough for anything a person writes to their board, and short enough that
 * a machine-generated message with a megabyte of quoted history does not become
 * a row nothing can render. What is cut is recorded on the message, so the board
 * is told it is reading part of a letter rather than shown a truncated one that
 * reads as complete.
 */
export const MAX_TEXT_CHARACTERS = 20_000;

/**
 * How much of a body's decoded text is read to produce that much.
 *
 * A body is as long as the sender chose, up to the size the collector will
 * fetch, and every pass below runs over all of it. None of them costs more than
 * the length of what it is given, and this is what keeps that length the
 * reader's choice rather than the sender's: a letter is stored at
 * MAX_TEXT_CHARACTERS, so there is no reason to read ten mebibytes of it. Four
 * times as much, because an HTML letter spends characters on markup and
 * entities that are not text, and a plain one on line endings and control
 * characters that are dropped.
 */
const MAX_BODY_INPUT = 4 * MAX_TEXT_CHARACTERS;

/**
 * How many of a body's bytes are decoded to produce that much text.
 *
 * The cut above bounds the passes over the text, but the transfer and charset
 * decoding before it would still run over every byte the sender sent. This
 * bounds them too, with room for the most a character can cost: four bytes in
 * any charset the decoder knows, three times that written as quoted-printable,
 * and a margin for the line breaks around it.
 */
const MAX_BODY_BYTES = 16 * MAX_BODY_INPUT;

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
  /**
   * The subject line, decoded and on one line. Empty when the message carried
   * none.
   *
   * One line, because an encoded word decodes to whatever bytes the sender
   * chose, a line break included, and an answer's subject is built from this
   * one and becomes a header of its own.
   */
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
  /**
   * When the last mail server on the way says it took the message in: the date
   * on the topmost Received header.
   *
   * Every SMTP server that accepts a message has to put one at the top of it
   * (RFC 5321 section 4.4), so on a letter delivered to the board's mailbox
   * the topmost is written by the mailbox's own provider. A sender can write
   * Received headers of their own, but only below that one. Null when the
   * message carries none or its date cannot be read, which is a message that
   * did not arrive through a mail server. It is still a clock somebody else
   * keeps, so the caller decides how far to trust it.
   */
  readonly receivedAt: Date | null;
  /**
   * The message as text, with newlines normalised, and at most
   * {@link MAX_TEXT_CHARACTERS} of it. A letter written in several text parts
   * reads as all of them, in the order they stand.
   */
  readonly text: string;
  /**
   * Whether the letter held more than {@link text} gives: its text ran past the
   * bound, or its body was longer than the reader reads.
   */
  readonly textTruncated: boolean;
  /** Whether {@link text} was derived from an HTML part rather than sent as text. */
  readonly textFromHtml: boolean;
  readonly attachments: readonly MimeAttachment[];
  /**
   * The other forms of the body: every text part of a `multipart/alternative`
   * the reader chose another part of, read as it would have read that part.
   *
   * Not the letter as the board sees it, which is {@link text}. A mail client
   * may show any one of the forms, and the sender decides what each says, so
   * a caller that judges a letter by its text reads these as well.
   */
  readonly alternatives: readonly ReadText[];
  /**
   * How many parts the message holds that are neither its body, nor another
   * text form of the body, nor an attachment - inline content this reader does
   * not read.
   *
   * Counted so a caller that judges a letter by its text can tell when the
   * text is not all the letter says.
   */
  readonly unreadParts: number;
}

/** One form of a letter's body, as the reader reads it. */
export interface ReadText {
  /** At most {@link MAX_TEXT_CHARACTERS} of it. */
  readonly text: string;
  /** Whether the form held more than {@link text} gives. */
  readonly truncated: boolean;
  /** Whether it was read from HTML. */
  readonly fromHtml: boolean;
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
  const unread = unreadContent(part, body?.parts ?? []);

  return {
    subject: oneLine(decodeEncodedWords(part.headers.get("subject") ?? "")),
    fromAddress: addressFrom(part.headers.get("from") ?? ""),
    fromName: displayNameFrom(part.headers.get("from") ?? ""),
    messageId: identifierFrom(part.headers.get("message-id") ?? ""),
    // References is the fallback because some clients send only that; its last
    // entry is the message being answered, which is what In-Reply-To names.
    inReplyTo:
      identifierFrom(part.headers.get("in-reply-to") ?? "") ??
      lastIdentifierFrom(part.headers.get("references") ?? ""),
    date: dateFrom(part.headers.get("date") ?? ""),
    // The first occurrence is the topmost, which is what the header map keeps.
    receivedAt: receivedDateFrom(part.headers.get("received") ?? ""),
    text: body?.text ?? "",
    textTruncated: body?.truncated ?? false,
    textFromHtml: body?.fromHtml ?? false,
    attachments: collectAttachments(part),
    alternatives: unread.alternatives,
    unreadParts: unread.parts,
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

interface ChosenBody extends ReadText {
  /** The leaves the text was read from, in the order it reads them. */
  readonly parts: readonly MimePart[];
}

/**
 * The parts a reader is meant to read.
 *
 * `multipart/alternative` is the case the rest follows from: its children are
 * the same message written twice, so exactly one of them is the body and the
 * other must not also appear. Plain text is preferred over HTML because it is
 * what the sender typed rather than a rendering of it, and the last matching
 * child is preferred over the first because a client puts its richest
 * alternative last.
 *
 * `multipart/related` is one document and the resources it refers to - an HTML
 * letter and the pictures it shows - so its first readable part is the body,
 * and a text part among the resources is not the letter.
 *
 * Every other multipart is a sequence a mail client shows in order, and each
 * readable part of it is part of the letter. Apple Mail writes the text around
 * an inline picture as one text part before it and another after it, and a
 * reader that stopped at the first would give the board half the letter.
 *
 * A part is readable when it is plain text or HTML: see {@link isReadable}.
 */
function chooseBody(part: MimePart): ChosenBody | null {
  if (part.children !== null) {
    if (part.contentType.subtype === "alternative") {
      return lastBody(part.children);
    }
    if (part.contentType.subtype === "related") {
      return firstBody(part.children);
    }
    return joinedBody(part.children);
  }

  if (!isReadable(part)) {
    return null;
  }

  const charset = part.contentType.parameters.get("charset") ?? "utf-8";
  const cut = part.body.length > MAX_BODY_BYTES;
  const decoded = decodeBytes(
    decodeTransfer(
      cut ? { ...part, body: part.body.subarray(0, MAX_BODY_BYTES) } : part,
    ),
    charset,
  );
  const read = prefix(decoded, MAX_BODY_INPUT);

  const fromHtml = part.contentType.subtype === "html";
  const text = fromHtml
    ? htmlToText(read)
    : withoutControlCharacters(normaliseNewlines(read));

  return {
    parts: [part],
    text: prefix(text, MAX_TEXT_CHARACTERS),
    // Either cut counts. A body cut before it was read can still come out
    // shorter than the bound - an HTML letter whose text sat behind its markup -
    // and the board is owed the same notice for it.
    truncated:
      cut || read.length < decoded.length || text.length > MAX_TEXT_CHARACTERS,
    fromHtml,
  };
}

/**
 * The first `length` characters of the text, or one fewer where the cut would
 * split a character written as a surrogate pair.
 */
function prefix(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

/**
 * The body of a `multipart/alternative`: the last plain-text child, or else the
 * last child with a body at all.
 *
 * One pass, reading each child once. Two passes - one for plain text, one for
 * anything - would read every child of an HTML-only alternative twice, and an
 * alternative nested inside another as often as the sender cares to: twenty
 * levels, the most the walk allows, read the HTML at the bottom a million times.
 */
function lastBody(children: readonly MimePart[]): ChosenBody | null {
  let last: ChosenBody | null = null;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) {
      continue;
    }
    const chosen = chooseBody(child);
    if (chosen === null) {
      continue;
    }
    if (!chosen.fromHtml) {
      return chosen;
    }
    last ??= chosen;
  }
  return last;
}

/** The body of the first child that has one. */
function firstBody(children: readonly MimePart[]): ChosenBody | null {
  for (const child of children) {
    const chosen = chooseBody(child);
    if (chosen !== null) {
      return chosen;
    }
  }
  return null;
}

/**
 * The bodies of every child that has one, as one text in the order they stand.
 *
 * A letter with one body comes back exactly as that body reads, so joining
 * changes nothing for the letters that never needed it. Several are joined
 * with a blank line between them, where a client shows the picture or file
 * that stood between them, and the whole is held to the same bound as one body.
 *
 * Reading stops once the text has reached that bound. A sender decides how many
 * parts a letter has, and reading the rest would only produce text that is cut
 * again; a part left behind with text in it is recorded as a cut instead, so the
 * board is told the letter goes on.
 */
function joinedBody(children: readonly MimePart[]): ChosenBody | null {
  const read: ChosenBody[] = [];
  let length = 0;
  let cut = false;

  for (const child of children) {
    if (length >= MAX_TEXT_CHARACTERS) {
      if (holdsText(child)) {
        cut = true;
        break;
      }
      continue;
    }
    const chosen = chooseBody(child);
    if (chosen === null) {
      continue;
    }
    read.push(chosen);
    length += chosen.text.length;
  }

  const [first] = read;
  if (first === undefined || (read.length === 1 && !cut)) {
    return first ?? null;
  }

  const said = read.filter(
    (chosen) => withoutOuterLineBreaks(chosen.text) !== "",
  );
  const text = said
    .map((chosen) => withoutOuterLineBreaks(chosen.text))
    .join("\n\n");

  return {
    parts: read.flatMap((chosen) => chosen.parts),
    text: prefix(text, MAX_TEXT_CHARACTERS),
    truncated:
      cut ||
      text.length > MAX_TEXT_CHARACTERS ||
      read.some((chosen) => chosen.truncated),
    fromHtml: said.some((chosen) => chosen.fromHtml),
  };
}

/**
 * Whether a part holds a leaf the body could be read from, judged by its
 * structure alone and without decoding anything.
 */
function holdsText(part: MimePart): boolean {
  return leavesOf(part).some(
    (leaf) => isReadable(leaf) && leaf.body.length > 0,
  );
}

/**
 * Whether a leaf is one the reader reads as the letter: plain text or HTML,
 * and not a file.
 *
 * The other text types are data a mail client hands to something else - an
 * invitation to its calendar, a contact card to its address book, the headers
 * of a bounced letter, a table - and shows as that, or offers as a file. Read
 * into the text, they would put a contact card's fields in the middle of what
 * somebody wrote to the board.
 */
function isReadable(part: MimePart): boolean {
  return (
    !isAttachment(part) &&
    part.contentType.type === "text" &&
    (part.contentType.subtype === "plain" ||
      part.contentType.subtype === "html")
  );
}

/**
 * The text without the line breaks that open and close it.
 *
 * A scan rather than a pattern, for the reason {@link withoutTrailingBlanks}
 * gives.
 */
function withoutOuterLineBreaks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") {
    start += 1;
  }
  while (end > start && text[end - 1] === "\n") {
    end -= 1;
  }
  return text.slice(start, end);
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
function collectAttachments(part: MimePart): readonly MimeAttachment[] {
  const attachments: MimeAttachment[] = [];

  const walk = (candidate: MimePart): void => {
    if (candidate.children !== null) {
      for (const child of candidate.children) {
        walk(child);
      }
      return;
    }
    // A body is never one: the reader does not read an attachment as text.
    if (!isAttachment(candidate)) {
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

/**
 * What the message holds beside its body and its files: the other forms of the
 * body, read, and a count of the leaves that are not read at all.
 *
 * The other forms are the readable leaves under an outermost
 * `multipart/alternative` that holds a part that was read: the same message
 * written again, which the body is meant to say already. Each is read as the
 * body would have been, because nothing but the sender makes it so. Anything
 * else that is not an attachment - a text part among the resources of a
 * `multipart/related`, one past the bound on the text, a text type that is not
 * the letter, a form that is not text - is content this reader leaves unread.
 * An empty part says nothing and is not counted.
 *
 * One walk over the structure, whatever number of parts were read: a sender
 * decides how many there are, and a search for each of them from the top would
 * cost the square of that. Each form is read once, and bounded as the body is.
 */
function unreadContent(
  part: MimePart,
  read: readonly MimePart[],
): { alternatives: readonly ReadText[]; parts: number } {
  const said = new Set<MimePart>(read);
  const forms = new Set<MimePart>();

  const walk = (candidate: MimePart): void => {
    if (candidate.children === null) {
      return;
    }
    if (candidate.contentType.subtype === "alternative") {
      const leaves = leavesOf(candidate);
      if (leaves.some((leaf) => said.has(leaf))) {
        for (const leaf of leaves) {
          forms.add(leaf);
        }
      }
      return;
    }
    for (const child of candidate.children) {
      walk(child);
    }
  };
  walk(part);

  const alternatives: ReadText[] = [];
  let unread = 0;
  for (const leaf of leavesOf(part)) {
    if (said.has(leaf) || isAttachment(leaf) || leaf.body.length === 0) {
      continue;
    }
    const form = forms.has(leaf) ? chooseBody(leaf) : null;
    if (form === null) {
      unread += 1;
    } else {
      alternatives.push({
        text: form.text,
        truncated: form.truncated,
        fromHtml: form.fromHtml,
      });
    }
  }
  return { alternatives, parts: unread };
}

/** Every leaf under a part, the part itself when it is one. */
function leavesOf(part: MimePart): MimePart[] {
  return part.children === null ? [part] : part.children.flatMap(leavesOf);
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
    const cleaned = last
      .replaceAll(CONTROL_CHARACTERS, "")
      .replaceAll(BIDI_CONTROLS, "")
      .trim();
    if (cleaned !== "" && cleaned !== "." && cleaned !== "..") {
      return cleaned.slice(0, 200);
    }
  }

  return `bilaga-${String(position + 1)}`;
}

/**
 * The characters that reorder the text around them without being seen.
 *
 * In a file name they are a spoof and nothing else: a right-to-left override
 * shows `invoice\u202Efdp.exe` as "invoiceexe.pdf", and a board member decides
 * whether to open an attachment by its name. The embeddings, overrides and
 * isolates, and the three invisible marks that set a direction.
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

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

// ---------------------------------------------------------------------------
// Header values.
// ---------------------------------------------------------------------------

/** The address out of a From header, lowercased, or null. */
export function addressFrom(raw: string): string | null {
  const angled = /<([^<>]*)>/.exec(raw);
  const candidate = (angled?.[1] ?? raw).trim().replaceAll(/^["']|["']$/g, "");

  // One "@" with something either side, and no whitespace or other control
  // character. Deliberately not a full RFC 5322 address grammar: what this
  // decides is whether the value can be stored and replied to, and the mail
  // server is the authority on the rest. A control character is refused here
  // rather than left to it, because the address becomes the recipient of the
  // board's answer, and what a mail server makes of one is its own business.
  return /^[^\s@]+@[^\s@]+$/.test(candidate) && !hasControlCharacter(candidate)
    ? candidate.toLowerCase()
    : null;
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

/**
 * The date on a Received header, or null.
 *
 * It follows the last semicolon (RFC 5322 section 3.6.7): what comes before it
 * names the servers and the connection, and may hold semicolons of its own in
 * a comment, while a date-time never does.
 */
function receivedDateFrom(raw: string): Date | null {
  const semicolon = raw.lastIndexOf(";");
  return semicolon === -1 ? null : dateFrom(raw.slice(semicolon + 1));
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

  return withoutTrailingBlanks(
    withoutControlCharacters(
      normaliseNewlines(decodeEntities(pieces.join(""))),
    ),
  )
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

/**
 * The character a numeric entity names, or nothing.
 *
 * Nothing for code point zero, as for a value outside Unicode: it is not a
 * character anybody writes in a letter, and the database refuses to store it.
 */
function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function normaliseNewlines(text: string): string {
  // The stored body is read on a screen and put back into a reply, and a mixture
  // of line endings in one string shows up in both.
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Every control character but the tab and the two line endings.
 *
 * The rule against control characters in a pattern is disabled for this one
 * line, because finding them is what the pattern is for.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

/**
 * The text with its control characters removed.
 *
 * A body is whatever bytes the sender chose, and a NUL among them is not one
 * PostgreSQL will store in a text column: left in, it makes the letter one the
 * collector cannot write at all. The others carry nothing a board reads and
 * are dropped with it. Tab, carriage return and line feed are how the sender
 * laid the letter out, and stay.
 */
function withoutControlCharacters(text: string): string {
  return text.replaceAll(CONTROLS_IN_TEXT, "");
}

/**
 * The text with the spaces and tabs that end each line removed.
 *
 * This is a scan rather than a pattern on purpose. A pattern such as
 * `/[ \t]+\n/g` starts again at every space of a run that no line break
 * follows, so its cost grows with the square of the run's length, and a body
 * is as long as the sender chose.
 */
function withoutTrailingBlanks(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let end = line.length;
      while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
        end -= 1;
      }
      return end === line.length ? line : line.slice(0, end);
    })
    .join("\n");
}
