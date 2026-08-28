import fastifyMultipart, {
  type FastifyMultipartOptions,
} from "@fastify/multipart";
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
  /*
   * The plugin is cast onto the register signature it is in fact written for.
   *
   * Two copies of the Fastify type declarations are resolved in this tree -
   * @nestjs/platform-fastify depends on 5.11.3 while this package depends on
   * 5.12.1 - so a plugin declared against one copy's FastifyPluginCallback is
   * not assignable to the other copy's register(). The declarations are
   * identical in shape and the plugin is the same object at runtime, which the
   * upload integration test exercises end to end.
   */
  const register = app.register.bind(app) as (
    plugin: unknown,
    options: FastifyMultipartOptions,
  ) => Promise<unknown>;

  await register(fastifyMultipart, {
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
    bytes: await part.toBuffer(),
    fileName: part.filename,
    declaredContentType: part.mimetype,
  };
}
