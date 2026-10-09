import { z } from "zod";

import { hasControlCharacter, MAX_DISPLAY_NAME } from "../mail/header-text";

/**
 * Environment variables are parsed once at boot and never read from
 * process.env again, so a missing or malformed value fails immediately with a
 * readable message instead of surfacing as undefined deep in a request.
 *
 * The variables themselves are documented for operators in .env.example.
 */

/**
 * Environment values are always strings, so booleans need an explicit
 * transform rather than z.boolean(). Anything other than "true" is false.
 */
function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? defaultValue : value === "true",
    );
}

/**
 * Like envBoolean, but absent while the variable is unset, and "true" or
 * "false" exactly.
 *
 * For a flag that belongs to one of several drivers: a value the operator set
 * beside another driver has to be told apart from one nobody set, so that it
 * can be named at boot. The reader supplies the default.
 *
 * Stricter than envBoolean, because the flags this serves decide whether a
 * connection is encrypted: "TRUE" or "1" read as false would leave it in the
 * clear without a word, so any other value is named at boot instead.
 */
function optionalEnvBoolean() {
  return z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .transform((value) => value === "true")
    .optional();
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/** A SHA-256 digest as hashOpaqueToken writes it: base64url, unpadded. */
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

/**
 * A domain written the way the right-hand side of a Message-ID is: labels of
 * letters, digits and hyphens, separated by dots.
 */
const MESSAGE_ID_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/** The address parsed, or null for a value that is not a URL at all. */
function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether an address may be dialled from here: https, or plain http on a
 * loopback host, and no credentials written into it.
 *
 * Loopback is allowed unencrypted because that is what a development instance
 * and the end-to-end stack run on; everything else must be https. Deliberately
 * not a regular expression: a URL is parsed by the parser, and a pattern that
 * agreed with it on the easy cases would disagree on the ones that matter.
 */
function isHttpsOrLoopback(url: URL): boolean {
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return isLoopbackHost(url.hostname);
}

/**
 * Whether a host names this machine: the one place a connection may go
 * unencrypted, because it never crosses a network.
 *
 * Both IPv6 forms, because a URL parser always returns the address bracketed
 * and an SMTP host is written as the operator typed it.
 */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * Whether a client could reach this instance at the address given.
 *
 * The address leaves this process in a discovery document and a token's
 * audience, so it has to be one a client can reach safely.
 */
function isReachableAppUrl(value: string): boolean {
  const url = parsedUrl(value);
  if (url === null) {
    return false;
  }
  /*
   * A bare origin and nothing else. This value is not only dialled: it is the
   * base every sign-in link is built on, it is published verbatim in the
   * discovery documents, and it is the audience every access token is bound
   * to. Credentials written into it would be published to anyone who reads a
   * discovery document, and a path would be dropped silently rather than
   * honoured - the resource URL is resolved from an absolute path, so
   * `https://brf.example/base` yields `https://brf.example/api/...` and an
   * operator who meant to mount the instance under a prefix gets an audience
   * that is not where their instance is. Refusing the value names the variable
   * at boot instead.
   */
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }
  return isHttpsOrLoopback(url);
}

/**
 * Whether the mail API's address is one this process may post mail to.
 *
 * The scheme half of the APP_URL check and not the rest of it: this address is
 * dialled and never published, and a service versions its API in the path
 * (`https://mail.example/v1`), so a path is allowed. A query or a fragment is
 * not, because the driver appends its own path and neither would survive that
 * as the operator meant it. Every message carries the bearer key and the
 * recipient's address, which is why plain http is loopback only.
 */
function isMailApiUrl(value: string): boolean {
  const url = parsedUrl(value);
  if (url === null || url.search !== "" || url.hash !== "") {
    return false;
  }
  return isHttpsOrLoopback(url);
}

/**
 * Hard ceiling on the configured upload limit, 32 MiB.
 *
 * The limit is what stops a request from filling the disk or the heap, and an
 * operator who mistypes it has removed that protection rather than relaxed it.
 * A bound the configuration cannot exceed keeps the failure a boot error.
 *
 * The ceiling is this low because an upload is held in memory in full while it
 * is dealt with: the multipart parser reads it into a buffer, the type is
 * identified from those bytes, a checksum is taken over them, the file is
 * sealed into a second buffer of about the same size (ADR 0015), and the S3
 * driver hashes that again to sign the request. One request therefore costs a
 * small multiple of the file, and concurrent uploads multiply that again, so the
 * ceiling is what a self-hosted instance in a modest container can survive
 * rather than what a file format might justify. Raising it is a decision that
 * belongs with an upload path that streams end to end.
 */
const MAX_UPLOAD_CEILING_BYTES = 32 * 1024 * 1024;

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The schema owner's connection: migrations, the job schema install and the
   * seed CLI. Optional, and absent from a production server's environment: the
   * owner can disable the statutory archive triggers, so the container
   * entrypoint drops it once the deploy steps that need it have run, and the
   * process that serves requests holds DATABASE_URL_RUNTIME alone.
   */
  DATABASE_URL: z.string().min(1).optional(),
  /**
   * Non-owner connection for the application. Production sets this to the
   * openbrf_app role so the statutory archive guards cannot be bypassed
   * (see prisma/sql/harden-runtime-role.sql).
   */
  DATABASE_URL_RUNTIME: z.string().min(1).optional(),

  /**
   * How many connections the application's own pool may hold open.
   *
   * Ten is node-postgres's default and what an instance with a server of its
   * own needs. The job queue holds two more of its own, so an instance takes
   * twelve of the server's max_connections, which is 100 unless the server is
   * configured otherwise. Where several instances share one server, whoever
   * runs them divides that budget between them (docs/deployment.md).
   */
  OPENBRF_DATABASE_POOL_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10),

  /**
   * Public base URL, used to build invitation and magic links.
   *
   * Also the origin of the OAuth protected resource, which is the audience
   * every access token is issued for, so it must be an address a client can
   * actually reach: https, or loopback for a development instance. That mirrors
   * what the sign-in library validates when it is constructed, and turns a
   * stack trace out of somebody else's package into an error naming this
   * variable. Changing it after tokens have been issued invalidates them all,
   * which docs/deployment.md states.
   */
  APP_URL: z
    .string()
    .min(1)
    .refine(
      isReachableAppUrl,
      "must be an https URL, or http on localhost, and carry no credentials, path, query or fragment",
    )
    .default("http://localhost:5173"),

  /** Holds uploads, keys, installed plugins and installed themes. */
  OPENBRF_DATA_DIR: z.string().min(1).default("./.data"),

  /**
   * Field encryption key, 32 bytes hex encoded. When absent the key is read
   * from, or generated into, the data volume (ADR 0002).
   */
  OPENBRF_ENCRYPTION_KEY: z
    .string()
    .regex(HEX_32_BYTES, "must be 32 bytes hex encoded (64 hex characters)")
    .optional(),

  BETTER_AUTH_SECRET: z.string().min(16),

  /**
   * The digest of the setup link's token, for an instance whose host minted
   * the link (ADR 0023).
   *
   * Only the digest: the token itself goes to whoever is to claim the
   * instance, so nothing in this environment, the database or a backup can be
   * presented as it. When absent, an unclaimed instance mints a token of its
   * own at start and prints the link to its log (setup-claim.service.ts).
   */
  OPENBRF_SETUP_TOKEN_DIGEST: z
    .string()
    .regex(
      BASE64URL_SHA256,
      "must be one SHA-256 digest, base64url without padding (43 characters)",
    )
    .optional(),

  /**
   * Where uploaded files are kept. "local" writes under OPENBRF_DATA_DIR,
   * "s3" into an S3-compatible bucket. Neither changes how files are served:
   * the API streams the bytes from its own origin in both cases.
   */
  OPENBRF_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),

  OPENBRF_S3_ENDPOINT: z.string().min(1).optional(),
  OPENBRF_S3_REGION: z.string().min(1).default("us-east-1"),
  OPENBRF_S3_BUCKET: z.string().min(1).optional(),
  OPENBRF_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  OPENBRF_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /**
   * Bucket in the path rather than in the host name. Self-hosted servers
   * generally require it; AWS S3 itself does not.
   */
  OPENBRF_S3_FORCE_PATH_STYLE: envBoolean(false),

  /** Largest upload accepted, in bytes. Enforced while the body is read. */
  OPENBRF_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_UPLOAD_CEILING_BYTES)
    .default(10 * 1024 * 1024),

  /**
   * How many calls one connected app's token may make in a minute.
   *
   * A bound on what a single connection can do to an instance, not a quota a
   * cooperative is billed against. Each call costs a token lookup, an account
   * lookup and a capability query, and the connections this bounds are
   * programs rather than people, so an unbounded one is a load an association
   * never agreed to. Counted per process; token-rate-limit.ts says what that
   * means.
   */
  OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  OPENBRF_PLUGINS_ENABLED: envBoolean(true),
  OPENBRF_CATALOG_URL: z.string().min(1).optional(),
  OPENBRF_CATALOG_TOKEN: z.string().min(1).optional(),
  OPENBRF_UNCURATED_PLUGINS_ENABLED: envBoolean(false),
  /**
   * Reinstall plugins at boot when the data volume does not carry them.
   *
   * Off by default, because on a normal deployment /data/plugins is a volume
   * and an empty one means something is wrong that a silent reinstall would
   * hide. It exists for deployments with no persistent volume at all, where an
   * empty installation directory on every boot is the expected state and the
   * database is the only record of what should be running.
   */
  OPENBRF_PLUGINS_REINSTALL_ON_BOOT: envBoolean(false),
  /**
   * Refuse every action that writes, whatever the caller may do.
   *
   * An instance-wide switch above every per-caller check, for the operator who
   * wants a connected app read-only while they watch what it does. It is not a
   * permission and it cannot be narrowed per person: the point is that the
   * answer does not depend on who asked, so a refusal cannot be used to probe
   * what a token would otherwise reach.
   */
  OPENBRF_ACTIONS_READ_ONLY: envBoolean(false),
  /**
   * Print a message this instance has no mail to send through to the log, in
   * full - sign-in and invitation links included.
   *
   * For a developer following a link on their own machine and for nothing else,
   * and never in production, where a message with no mail to send it is
   * refused instead. Off unless asked for, so an instance whose NODE_ENV was
   * left unset does not write live sign-in links into its log.
   */
  OPENBRF_MAIL_LOG_BODY: envBoolean(false),

  /**
   * Where the instance's mail goes out (ADR 0024).
   *
   * "settings" is what the board enters in the setup wizard and the settings
   * screen. "smtp" and "http-api" are set by whoever runs the instance, win
   * over anything stored, and lock the settings: on a hosted instance the host
   * answers for delivery and for the sending domain's SPF and DKIM, and a board
   * that could replace them would be the first to find out it had broken both.
   */
  OPENBRF_MAIL_DRIVER: z
    .enum(["settings", "smtp", "http-api"])
    .default("settings"),
  /**
   * The sender's bare address. Need not be on the association's own domain: a
   * hosted instance sends from a domain it shares with others, under the
   * association's name, with replies directed to the association.
   */
  OPENBRF_MAIL_FROM_ADDRESS: z.email().max(320).optional(),
  /**
   * The display name. Unset, the association's registered name, read at each
   * send. One line, because it becomes part of a header.
   */
  OPENBRF_MAIL_FROM_NAME: z
    .string()
    .trim()
    .min(1, "must not be blank")
    .max(MAX_DISPLAY_NAME)
    .refine(
      (value) => !hasControlCharacter(value),
      "must be one line, with no line break or other control character",
    )
    .optional(),
  /**
   * Where a reply goes when a message names nowhere of its own. Unset, the
   * board mailbox's published address while one is configured.
   */
  OPENBRF_MAIL_REPLY_TO: z.email().max(320).optional(),

  OPENBRF_SMTP_HOST: z.string().min(1).optional(),
  /** Unset, 465 with implicit TLS and 587 without (smtp-mail.driver.ts). */
  OPENBRF_SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Implicit TLS. Unset is false; absent here so a stray value can be named. */
  OPENBRF_SMTP_SECURE: optionalEnvBoolean(),
  /**
   * Whether the sign-in waits for STARTTLS. Unset, it does unless the relay is
   * on loopback (mail-settings.ts). "false" is the host vouching for the
   * network between the instance and a relay that offers no STARTTLS, such as
   * a sidecar on the Compose network, and is logged at start.
   */
  OPENBRF_SMTP_REQUIRE_TLS: optionalEnvBoolean(),
  OPENBRF_SMTP_USER: z.string().min(1).optional(),
  /**
   * In the environment in plain text, as the S3 keys are: the operator supplies
   * it where the instance runs. A password the board types is encrypted at rest
   * instead.
   */
  OPENBRF_SMTP_PASSWORD: z.string().min(1).optional(),

  /** The mail API's base address; the driver posts to `<this>/emails`. */
  OPENBRF_MAIL_API_URL: z
    .string()
    .min(1)
    .refine(
      isMailApiUrl,
      "must be an https URL, or http on localhost, and carry no credentials, query or fragment",
    )
    .optional(),
  /** The bearer key, in plain text for the reason OPENBRF_SMTP_PASSWORD is. */
  OPENBRF_MAIL_API_KEY: z.string().min(1).optional(),
  /**
   * The domain the service writes its own Message-ID under, as `<id>@<domain>`.
   *
   * The service refuses a Message-ID from the caller and sets one itself, so
   * this is how the instance learns the identifier a reply to the message will
   * name - which is what the board mailbox threads by.
   */
  OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: z
    .string()
    .regex(
      MESSAGE_ID_DOMAIN,
      "must be a domain name, such as the part after the @ in the service's own Message-ID",
    )
    .optional(),
});

/**
 * The S3 driver needs a bucket and credentials, and there is no safe default
 * for any of them.
 *
 * Checked here rather than when the first upload arrives, because an instance
 * that boots with half a storage configuration looks healthy until somebody
 * uploads a file, and by then the operator is debugging a failed upload rather
 * than reading a boot error that names the missing variable.
 */
const S3_REQUIRED = [
  "OPENBRF_S3_ENDPOINT",
  "OPENBRF_S3_BUCKET",
  "OPENBRF_S3_ACCESS_KEY_ID",
  "OPENBRF_S3_SECRET_ACCESS_KEY",
] as const;

/**
 * The variables each mail driver set in the environment reads.
 *
 * The sender's three belong to both drivers and to neither of them alone.
 */
const MAIL_SENDER_VARIABLES = [
  "OPENBRF_MAIL_FROM_ADDRESS",
  "OPENBRF_MAIL_FROM_NAME",
  "OPENBRF_MAIL_REPLY_TO",
] as const;

const MAIL_DRIVER_VARIABLES = {
  smtp: [
    "OPENBRF_SMTP_HOST",
    "OPENBRF_SMTP_PORT",
    "OPENBRF_SMTP_SECURE",
    "OPENBRF_SMTP_REQUIRE_TLS",
    "OPENBRF_SMTP_USER",
    "OPENBRF_SMTP_PASSWORD",
  ],
  "http-api": [
    "OPENBRF_MAIL_API_URL",
    "OPENBRF_MAIL_API_KEY",
    "OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN",
  ],
} as const;

const MAIL_DRIVER_REQUIRED = {
  smtp: ["OPENBRF_MAIL_FROM_ADDRESS", "OPENBRF_SMTP_HOST"],
  "http-api": [
    "OPENBRF_MAIL_FROM_ADDRESS",
    "OPENBRF_MAIL_API_URL",
    "OPENBRF_MAIL_API_KEY",
    "OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN",
  ],
} as const;

/**
 * A mail driver set in the environment needs its own variables and refuses
 * everybody else's.
 *
 * Checked at boot for the reason the S3 variables are, and refused in the other
 * direction too: a variable of one driver set beside another is half of a
 * configuration that was being switched, and an instance that booted with it
 * would send through something the operator did not mean. Under "settings" every
 * one of them is refused, because an SMTP host set with the driver left at its
 * default would otherwise be ignored without a word.
 */
function checkMailDriver(value: Env, ctx: z.RefinementCtx): void {
  const driver = value.OPENBRF_MAIL_DRIVER;

  for (const [owner, names] of Object.entries(MAIL_DRIVER_VARIABLES)) {
    if (owner === driver) {
      continue;
    }
    for (const name of names) {
      if (value[name] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `belongs to the "${owner}" mail driver, and OPENBRF_MAIL_DRIVER is "${driver}"`,
        });
      }
    }
  }

  if (driver === "settings") {
    for (const name of MAIL_SENDER_VARIABLES) {
      if (value[name] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message:
            'belongs to a mail driver set in the environment, and OPENBRF_MAIL_DRIVER is "settings"',
        });
      }
    }
    return;
  }

  for (const name of MAIL_DRIVER_REQUIRED[driver]) {
    if (value[name] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `is required when OPENBRF_MAIL_DRIVER is "${driver}"`,
      });
    }
  }

  // Both or neither: a user with no password, or the reverse, is a credential
  // half written down, and the server's refusal would arrive at the first send.
  if (driver === "smtp") {
    const user = value.OPENBRF_SMTP_USER !== undefined;
    const password = value.OPENBRF_SMTP_PASSWORD !== undefined;
    if (user !== password) {
      ctx.addIssue({
        code: "custom",
        path: [user ? "OPENBRF_SMTP_PASSWORD" : "OPENBRF_SMTP_USER"],
        message: user
          ? "is required when OPENBRF_SMTP_USER is set"
          : "is required when OPENBRF_SMTP_PASSWORD is set",
      });
    }
  }
}

/**
 * The development placeholder from `.env.example`. Published, so a copy of it
 * in production is a secret everybody has.
 */
const PLACEHOLDER_AUTH_SECRETS = new Set(["dev-only-secret-change-me"]);

/** The fewest characters a production secret may have. */
const PRODUCTION_AUTH_SECRET_MIN = 32;

/**
 * A production secret that is long enough, and not the published placeholder.
 *
 * It signs sessions and encrypts the TOTP secrets and OAuth client secrets at
 * rest, so a guessable one lets anybody holding a database copy undo the
 * second factor of every account. Development and tests keep the shorter
 * floor the schema sets.
 */
function checkAuthSecret(
  value: z.infer<typeof envSchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.NODE_ENV !== "production") {
    return;
  }
  if (PLACEHOLDER_AUTH_SECRETS.has(value.BETTER_AUTH_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_SECRET"],
      message:
        "is the development placeholder. Generate one with " +
        "`openssl rand -base64 48`.",
    });
  } else if (value.BETTER_AUTH_SECRET.length < PRODUCTION_AUTH_SECRET_MIN) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_SECRET"],
      message:
        `needs at least ${String(PRODUCTION_AUTH_SECRET_MIN)} characters in ` +
        "production. Generate one with `openssl rand -base64 48`.",
    });
  }
}

const envChecked = envSchema.superRefine((value, ctx) => {
  // One of the two connections has to be there, because there is no default
  // that could be right. Which one it is says what the process is for: a deploy
  // step runs as the owner, a server runs as openbrf_app.
  if (
    value.DATABASE_URL === undefined &&
    value.DATABASE_URL_RUNTIME === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message:
        "is required unless DATABASE_URL_RUNTIME is set. One of the two names " +
        "the database this process connects to.",
    });
  }

  checkMailDriver(value, ctx);
  checkAuthSecret(value, ctx);

  if (value.OPENBRF_STORAGE_DRIVER !== "s3") {
    return;
  }
  for (const name of S3_REQUIRED) {
    if (value[name] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: 'is required when OPENBRF_STORAGE_DRIVER is "s3"',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * The connection the application itself opens.
 *
 * DATABASE_URL_RUNTIME wherever it is set, which is everywhere the image runs:
 * that role owns nothing, so the append-only guards on the member register and
 * the audit log are not its to disable. The owner connection is the fallback
 * for a development instance configured with one role, and PrismaService
 * refuses that combination in production.
 */
export function applicationDatabaseUrl(env: Env): string {
  const url = env.DATABASE_URL_RUNTIME ?? env.DATABASE_URL;
  if (url === undefined) {
    throw new Error(
      "Neither DATABASE_URL_RUNTIME nor DATABASE_URL is set, so there is no " +
        "database for the application to connect to.",
    );
  }
  return url;
}

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  ${issues.join("\n  ")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * An empty value means "not set".
 *
 * Compose, Kubernetes and every hosting panel pass an unset optional variable
 * as an empty string rather than omitting it, so `OPENBRF_CATALOG_TOKEN=` has
 * to reach the schema as absent. Otherwise the deployment fails validation for
 * a value the operator deliberately left blank, and `.default()` never
 * applies.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );
}

/**
 * Parses and validates the environment. Throws EnvValidationError listing
 * every problem at once, so an operator fixes one deploy rather than five.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envChecked.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
