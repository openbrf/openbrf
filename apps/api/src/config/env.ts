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

/**
 * Hard ceiling on the configured upload limit, 1 GiB.
 *
 * The limit is what stops a request from filling the disk or the heap, and an
 * operator who mistypes it has removed that protection rather than relaxed it.
 * A bound the configuration cannot exceed keeps the failure a boot error.
 */
const MAX_UPLOAD_CEILING_BYTES = 1024 * 1024 * 1024;

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

  OPENBRF_PLUGINS_ENABLED: envBoolean(true),
  OPENBRF_CATALOG_URL: z.string().min(1).optional(),
  OPENBRF_CATALOG_TOKEN: z.string().min(1).optional(),
  OPENBRF_UNCURATED_PLUGINS_ENABLED: envBoolean(false),
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

const envWithStorageChecked = envSchema.superRefine((value, ctx) => {
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
  const result = envWithStorageChecked.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
