import fastifyMultipart, { type MultipartFields } from "@fastify/multipart";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";

import type { Env } from "../config/env";

/**
 * One uploaded file, already read into memory.
 *
 * Bounded by the configured limit before it gets here, so "in memory" is a
 * known quantity rather than whatever the client felt like sending.
 */
export interface UploadedFile {
  bytes: Buffer;
  fileName: string;
  /** What the request claimed. Kept only to be compared, never trusted. */
  declaredContentType: string;
  /**
   * The text fields that arrived ahead of the file, by name.
   *
   * Ahead of it, and not merely beside it: see readSingleFile below. Values
   * are strings, so a caller validates them like any other input - these come
   * from a request and nothing here has looked at them.
   */
  fields: Readonly<Record<string, string>>;
}

/**
 * Registers multipart parsing.
 *
 * Called from the bootstrap and from the integration suites rather than done
 * inside a module, because a Fastify plugin has to be registered before the
 * server is ready and a Nest module's lifecycle is not the place to do that.
 *
 * The size limit lives here, at the point where the bytes arrive: a check
 * further in would run after the request had already been read into the
 * process, which is the thing the limit exists to prevent.
 */
export async function registerMultipart(
  app: NestFastifyApplication,
  env: Env,
): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: env.OPENBRF_MAX_UPLOAD_BYTES,
      // One file and a handful of fields. An endpoint here takes a single
      // upload, so anything else is a malformed request or an attempt to make
      // the parser do work nobody asked for.
      files: 1,
      fields: 8,
    },
  });
}

/** Whether the parser rejected the body for exceeding the size limit. */
export function isTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

/**
 * Reads the single file out of a multipart request, or null when there is none.
 *
 * `toBuffer()` throws when the file exceeds the configured limit, and that
 * throw is the enforcement: the stream is cut off rather than drained, so an
 * oversized upload costs the limit and not the whole body.
 *
 * The whole file lands in memory here, which is why the configured limit has a
 * ceiling it cannot be raised past (see MAX_UPLOAD_CEILING_BYTES): everything
 * downstream needs the complete bytes anyway - the type is identified from
 * them, a checksum is taken over them, and the S3 driver signs them - so the
 * cost of one request is bounded by configuration rather than by the caller.
 */
export async function readSingleFile(
  request: FastifyRequest,
): Promise<UploadedFile | null> {
  if (!request.isMultipart()) {
    return null;
  }

  const part = await request.file();
  if (part === undefined) {
    return null;
  }

  return {
    // Read before the buffer: the parser stops at the file part, so what it
    // has collected is what came before it, and reading afterwards would not
    // add the rest.
    fields: textFields(part.fields),
    bytes: await part.toBuffer(),
    fileName: part.filename,
    declaredContentType: part.mimetype,
  };
}

/**
 * The text fields out of a parsed multipart request.
 *
 * Only the fields that are text, and only the first value of a repeated name.
 * A second value under one name is a caller sending something the endpoint
 * did not ask for, and taking the last would let a request append a value that
 * overrides the one it also sent.
 */
function textFields(
  fields: MultipartFields | undefined,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  if (fields === undefined) {
    return values;
  }

  for (const [name, field] of Object.entries(fields)) {
    const first = Array.isArray(field) ? field[0] : field;
    if (first !== undefined && first.type === "field") {
      values[name] = String(first.value);
    }
  }
  return values;
}
