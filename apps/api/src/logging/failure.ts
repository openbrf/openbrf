/**
 * Naming a failure in the log without repeating what it carried.
 *
 * An exception message is composed where it is thrown, out of whatever the
 * code was handling at that moment, and three parts of this application throw
 * over exactly that kind of thing. A mail server's rejection quotes the
 * envelope it rejected, and that envelope holds an address decrypted a few
 * lines earlier. A constraint violation names the value that broke it. A
 * plugin composes its own message, and one reading the register through its
 * consented host services can be holding a resident's details when it does.
 *
 * None of it belongs in an application log. Protected personal data is masked
 * server-side and every reveal is written to the audit log in the same
 * transaction as the read; a container log is outside both by construction,
 * and is read by more people and kept longer than the data it would be
 * repeating.
 *
 * What travels instead is the class of the failure - a transport error, a
 * database error, a type error - which says which layer gave way and nothing
 * about whom it happened to, together with the identifier the runtime assigned
 * it and, where the caller has one, its own: a residency, a board member, an
 * import session, a plugin id. That is enough to find the row and run the call
 * again, which matters as much as the silence does - "log nothing" turns a
 * plugin that will not load into one that cannot be fixed. All of it is chosen
 * when code is written rather than composed from what is being processed, and
 * that is the distinction this file draws.
 *
 * The caller's own identifier may be the data subject's. A surrogate key this
 * application minted to address a row says nothing about the person to a reader
 * without the database, and in the nightly purges it is the only handle on an
 * erasure that did not happen - a failure rolls back the transaction that would
 * have recorded it, so nothing outside the log names it at all. What may never
 * travel is a value held on somebody's behalf rather than chosen to address
 * them: a name, contact data, a personal identity number, an apartment, or free
 * text out of a row. The boundary and its consequences are ADR 0007.
 */

/**
 * Bound on a name, which the throwing code chooses and may make any length.
 *
 * Long enough for the longest name anything in this process throws
 * (`PrismaClientKnownRequestError` is 29 characters).
 */
const MAX_IDENTIFIER = 60;

/** Deep enough to place a failure, short enough to stay one log entry. */
const MAX_FRAMES = 20;

/**
 * The class of the failure, with the runtime's code where it carries one.
 *
 * `name` and `code` are identifiers rather than prose - `TypeError`,
 * `ERR_MODULE_NOT_FOUND`, `ENOENT` - assigned by the runtime or written into a
 * class declaration, not interpolated from a value the way a message is. That
 * is what makes them safe to log where the message is not.
 *
 * The code is worth the second field. It is the whole difference between a
 * unique constraint and a foreign key on a database failure (`P2002` against
 * `P2003`), between a refused connection and a rejected envelope on a mail
 * one, and between a missing dependency and a bundle built the wrong way on a
 * plugin that will not load - and it names none of the values involved in any
 * of them.
 *
 * Both are still strings the throwing code owns, so both are reduced to a
 * bounded, single-line token. That is not a claim that nothing can be smuggled
 * through a 60-character field; it is what stops a name that contains newlines
 * from forging log entries and a long one from flooding them. Code that sets
 * its own error class from a value it is holding has decided to write that
 * value out, and code running in this process can write to the log directly
 * anyway - a plugin's bundle runs at full process privilege (ADR 0003), so no
 * filter here is a boundary against a package that means it. The disclosure
 * this prevents is the accidental one, which is the one that actually happens:
 * `throw new Error(\`no apartment for ${resident.email}\`)`.
 */
export function failureName(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return typeof cause;
  }

  const name = identifier(cause.name) || "Error";
  const raw: unknown = (cause as { code?: unknown }).code;
  const code = typeof raw === "string" ? identifier(raw) : "";

  return code === "" || code === name ? name : `${name} (${code})`;
}

/** A V8 call frame: `at ` indented by exactly four spaces. */
const FRAME = /^ {4}at \S/;

/**
 * The stack's call frames, without any of its message lines.
 *
 * A V8 stack begins with `Name: message` and a multi-line message runs on over
 * the lines below it. That block is cut off first, since a message line can
 * itself be indented like a frame - "    at anna@example.se" is one - and then
 * only a line with the indentation of a V8 frame is kept. A stack whose head
 * cannot be found gives no frames at all, because then no line of it can be
 * told apart from the message.
 *
 * What survives is function names and file paths. Those are in the same
 * category as a class name - written into the source, not composed from the
 * data being handled - and they are the only thing that answers "where did
 * this happen", which for a failure inside a bundled package is the whole of
 * the diagnosis.
 */
export function failureFrames(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || typeof cause.stack !== "string") {
    return undefined;
  }

  const stack = afterHead(cause, cause.stack);
  if (stack === undefined) {
    return undefined;
  }

  const frames = stack
    .split("\n")
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES);

  return frames.length === 0 ? undefined : frames.join("\n");
}

/**
 * The stack below its `Name: message` head, or undefined when the head cannot
 * be found.
 *
 * V8 writes the head when the stack is first read, so it is the error's own
 * text unless the error changed after that. A rename is the change that
 * happens - a subclass naming itself, a library relabelling what it caught -
 * so the head is also found by the message it still carries after a name on
 * the first line. A message that changed leaves nothing to find the head by.
 */
function afterHead(cause: Error, stack: string): string | undefined {
  const head = String(cause);
  if (stack.startsWith(head)) {
    return stack.slice(head.length);
  }

  const lineEnd = stack.indexOf("\n");
  const firstLine = lineEnd === -1 ? stack : stack.slice(0, lineEnd);
  if (cause.message === "") {
    return firstLine.includes(": ") ? undefined : stack.slice(firstLine.length);
  }

  const said = `: ${cause.message}`;
  const at = stack.indexOf(said);
  if (at === -1 || at > firstLine.length) {
    return undefined;
  }
  const rest = stack.slice(at + said.length);
  return rest === "" || rest.startsWith("\n") ? rest : undefined;
}

/** A bounded, single-line token. Anything that is not one is not kept. */
function identifier(value: string): string {
  return value.replaceAll(/[^\w$.-]/g, "").slice(0, MAX_IDENTIFIER);
}
