/**
 * JSON as a licence is read: refused when an object repeats a key.
 *
 * `JSON.parse` keeps the last of two equal keys and other parsers keep the
 * first, so one signed payload could otherwise name one instance to this host
 * and another to a service that reads it with different code (ADR 0042). This
 * walks the text once to find a repeated key, comparing keys as decoded, so
 * `"a"` and `"a"` are one key, and then hands it to `JSON.parse`, which
 * settles everything else about the grammar.
 */

/** Deeper than any licence or presentation nests. */
const MAX_DEPTH = 16;

const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

export function parseStrictJson(text: string): unknown {
  let at = 0;

  const fail = (what: string): never => {
    throw new StrictJsonError(`${what} at offset ${String(at)}`);
  };

  const skipWhitespace = (): void => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) {
      at += 1;
    }
  };

  const readString = (): string => {
    const start = at;
    at += 1;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code === 0x22) {
        at += 1;
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return fail("Invalid string");
        }
      }
      at += code === 0x5c ? 2 : 1;
    }
    return fail("Unterminated string");
  };

  const readValue = (depth: number): void => {
    if (depth > MAX_DEPTH) {
      fail("Nested too deeply");
    }
    skipWhitespace();
    const next = text.charAt(at);
    if (next === "{") {
      at += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text.charAt(at) === "}") {
        at += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (text.charAt(at) !== '"') {
          fail("Expected a key");
        }
        const key = readString();
        if (keys.has(key)) {
          fail("An object repeats a key");
        }
        keys.add(key);
        skipWhitespace();
        if (text.charAt(at) !== ":") {
          fail("Expected a colon");
        }
        at += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (text.charAt(at) === ",") {
          at += 1;
          continue;
        }
        if (text.charAt(at) === "}") {
          at += 1;
          return;
        }
        fail("Expected a comma or a closing brace");
      }
    }
    if (next === "[") {
      at += 1;
      skipWhitespace();
      if (text.charAt(at) === "]") {
        at += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (text.charAt(at) === ",") {
          at += 1;
          continue;
        }
        if (text.charAt(at) === "]") {
          at += 1;
          return;
        }
        fail("Expected a comma or a closing bracket");
      }
    }
    if (next === '"') {
      readString();
      return;
    }
    LITERAL.lastIndex = at;
    const literal = LITERAL.exec(text);
    if (literal === null) {
      fail("Unexpected character");
    } else {
      at += literal[0].length;
    }
  };

  readValue(0);
  skipWhitespace();
  if (at !== text.length) {
    fail("Unexpected text after the value");
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new StrictJsonError(
      cause instanceof Error ? cause.message : "Invalid JSON",
    );
  }
}
