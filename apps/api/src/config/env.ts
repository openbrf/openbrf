import { z } from "zod";

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

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Connection used by migrations and, unless overridden, by the app. */
  DATABASE_URL: z.string().min(1),
  /**
   * Non-owner connection for the application. Production sets this to the
   * openbrf_app role so the statutory archive guards cannot be bypassed
   * (see prisma/sql/harden-runtime-role.sql).
   */
  DATABASE_URL_RUNTIME: z.string().min(1).optional(),

  /** Public base URL, used to build invitation and magic links. */
  APP_URL: z.string().min(1).default("http://localhost:5173"),

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

  OPENBRF_PLUGINS_ENABLED: envBoolean(true),
  OPENBRF_CATALOG_URL: z.string().min(1).optional(),
  OPENBRF_CATALOG_TOKEN: z.string().min(1).optional(),
  OPENBRF_UNCURATED_PLUGINS_ENABLED: envBoolean(false),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  ${issues.join("\n  ")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Parses and validates the environment. Throws EnvValidationError listing
 * every problem at once, so an operator fixes one deploy rather than five.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
