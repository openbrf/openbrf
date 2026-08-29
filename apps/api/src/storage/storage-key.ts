import { randomUUID } from "node:crypto";

/**
 * The extension a stored content type is written with.
 *
 * Derived from the type the bytes were identified as, never from the name the
 * upload arrived under. A client-supplied name is the wrong thing to build a
 * path from twice over: it decides where the file lands, and it decides what a
 * later reader thinks the file is.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

/**
 * Where a new object is stored.
 *
 * Every part is generated here. The prefix names the feature that owns the
 * file, the date groups objects so a bucket or a directory stays browsable at
 * scale, and the identifier is random.
 *
 * Random rather than derived from anything, for two reasons. A key built from
 * the file's own name would carry whatever the uploader called it into the
 * request logs the storage provider keeps, which is a place personal data has
 * no business being. And a key that could be guessed would still be reachable
 * if a bucket were ever misconfigured for public reads, so the platform's
 * promise that files are served through its own authorization would rest on
 * the bucket's settings instead of on the key.
 */
export function generateStorageKey(
  prefix: "branding" | "documents" | "media",
  contentType: string,
  now: Date = new Date(),
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const extension = EXTENSIONS[contentType];
  const name =
    extension === undefined ? randomUUID() : `${randomUUID()}.${extension}`;

  return `${prefix}/${year}/${month}/${name}`;
}
