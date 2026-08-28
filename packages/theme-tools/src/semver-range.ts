/**
 * The version arithmetic the theme contract needs, and nothing else.
 *
 * A theme declares which contract versions it was written against, and the core
 * refuses to install one written against a contract it does not implement. That
 * is the whole requirement, so this is a deliberately small subset of semver
 * rather than a dependency:
 *
 *   versions   MAJOR.MINOR.PATCH, release versions only
 *   ranges     comparators joined by a space (AND) and by || (OR), each one of
 *              *, x.y.z, =x.y.z, ^x.y.z, ~x.y.z, >x.y.z, >=x.y.z, <x.y.z, <=x.y.z
 *
 * Anything outside that subset is rejected rather than guessed at. A range the
 * core cannot read is a range it cannot honour, and quietly treating it as
 * "matches" would install a theme against a contract nobody checked.
 *
 * Pre-release versions are deliberately not accepted. They exist to express
 * "not ready", and a theme published to a catalog is by definition published.
 */

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value: string): SemanticVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

/** Negative when a is older, zero when equal, positive when a is newer. */
export function compareVersions(
  a: SemanticVersion,
  b: SemanticVersion,
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

interface Comparator {
  operator: ">=" | ">" | "<=" | "<" | "=";
  version: SemanticVersion;
}

/**
 * Expands one range token into the comparators it stands for.
 *
 * Caret and tilde are expanded here rather than special-cased at match time, so
 * every token ends up as the same pair of bounds and the matcher has one shape
 * to reason about. Caret on a 0.x version keeps the minor pinned, which is the
 * semver rule that makes pre-1.0 packages usable at all.
 */
function expandToken(token: string): Comparator[] | null {
  if (token === "*") {
    return [];
  }

  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  const operator = operatorMatch?.[1] ?? "=";
  const rest = operatorMatch?.[2];
  if (rest === undefined) {
    return null;
  }

  const version = parseVersion(rest);
  if (version === null) {
    return null;
  }

  if (operator === "^") {
    const upper: SemanticVersion =
      version.major > 0
        ? { major: version.major + 1, minor: 0, patch: 0 }
        : version.minor > 0
          ? { major: 0, minor: version.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: version.patch + 1 };
    return [
      { operator: ">=", version },
      { operator: "<", version: upper },
    ];
  }

  if (operator === "~") {
    return [
      { operator: ">=", version },
      {
        operator: "<",
        version: { major: version.major, minor: version.minor + 1, patch: 0 },
      },
    ];
  }

  if (
    operator === ">=" ||
    operator === ">" ||
    operator === "<=" ||
    operator === "<" ||
    operator === "="
  ) {
    return [{ operator, version }];
  }

  return null;
}

function matchesComparator(
  version: SemanticVersion,
  comparator: Comparator,
): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

/** True when the range is written in the subset above. */
export function isRange(range: string): boolean {
  return parseRange(range) !== null;
}

function parseRange(range: string): Comparator[][] | null {
  const alternatives = range.split("||");
  const parsed: Comparator[][] = [];

  for (const alternative of alternatives) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return null;
    }

    const comparators: Comparator[] = [];
    for (const token of tokens) {
      const expanded = expandToken(token);
      if (expanded === null) {
        return null;
      }
      comparators.push(...expanded);
    }
    parsed.push(comparators);
  }

  return parsed;
}

/**
 * Whether a version satisfies a range.
 *
 * False for a range this subset cannot read, which is the safe direction: an
 * unreadable range fails the contract check and the theme is refused, rather
 * than installing against a contract that was never verified.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  const parsedRange = parseRange(range);
  if (parsedVersion === null || parsedRange === null) {
    return false;
  }

  return parsedRange.some((comparators) =>
    comparators.every((comparator) =>
      matchesComparator(parsedVersion, comparator),
    ),
  );
}
