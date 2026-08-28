import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import type { Principal } from "../authorization/capabilities";
import { PrincipalService } from "../authorization/principal.service";
import { Public } from "../authorization/public.decorator";
import { MediaService, type ServedFile } from "./media.service";

/**
 * Serving stored files.
 *
 * Every file a visitor sees comes through this route, from this instance's own
 * origin, with the bytes streamed by the API. There is deliberately no variant
 * that answers with a link or a redirect to the storage backend: a redirect
 * hands the storage provider every visitor's IP address, the page they were on
 * and when they were there, which is precisely what the platform refuses to do
 * with typefaces and has no reason to accept for images.
 *
 * The route is @Public() because it has to be. The housing cooperative's logo
 * is rendered by mail clients, which carry no session, and by the public
 * website, whose visitors have no account. Authorization is therefore decided
 * inside, per file, from the visibility recorded on it - and a file that may
 * not be read answers exactly as a file that does not exist, so this route
 * cannot be used to find out what an instance holds.
 */
@Controller("api/media")
@Public()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
  ) {}

  @Get(":id")
  async serve(
    @Param("id") id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.media.open(id, await this.viewerOf(request));

    // The bytes at an id never change - a replacement is a new file with a new
    // id - so a matching entity tag means the copy in the cache is the file.
    if (request.headers["if-none-match"] === `"${file.checksum}"`) {
      file.stream.destroy();
      void reply.status(304).headers(cacheHeaders(file)).send();
      return;
    }

    void reply.headers(headersFor(file)).send(file.stream);
  }

  /*
   * A HEAD for this route is Fastify's own, derived from the GET above, so it
   * answers with the same headers and the same authorization decision. There
   * is deliberately no handler of our own: a second one would be a second
   * place for the visibility check to be got wrong.
   */

  /**
   * Who is asking, when anyone is.
   *
   * Resolved here rather than by the global guard, because the guard rejects an
   * anonymous request outright and this route has to serve some files to one.
   * An unreadable or absent session is simply nobody, which the visibility
   * check then treats as the public.
   */
  private async viewerOf(request: FastifyRequest): Promise<Principal | null> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.append(name, value);
      }
    }

    const personId = await this.auth.personIdFromHeaders(headers);
    if (personId === null) {
      return null;
    }
    return this.principals.forPerson(personId);
  }
}

/**
 * How long a file may be held, and by whom.
 *
 * A public file is immutable at its id, so it can be cached for a year and the
 * band stops re-fetching the logo on every screen. An internal one is somebody's
 * data and is marked no-store, so it does not sit in a shared cache or on the
 * disk of a machine somebody merely borrowed.
 */
function cacheHeaders(file: ServedFile): Record<string, string> {
  return {
    etag: `"${file.checksum}"`,
    "cache-control":
      file.visibility === "PUBLIC"
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
  };
}

function headersFor(file: ServedFile): Record<string, string> {
  return {
    ...cacheHeaders(file),
    "content-type": file.contentType,
    "content-length": String(file.byteSize),
    /*
     * The type stored is the type identified from the bytes, and these two
     * headers stop a browser from deciding otherwise: nosniff pins the
     * declared type, and a content policy of nothing means that even if a
     * document did somehow reach this route it could not load a script, a
     * frame or a request of its own from the association's origin.
     */
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    // Shown, not downloaded: these are images in a page. The file name is
    // sanitised when it is stored.
    "content-disposition": contentDisposition(file.fileName),
  };
}

/**
 * The Content-Disposition value for a file name.
 *
 * Two parameters, not one. A quoted `filename` carries only ASCII, and header
 * values leave Node encoded as latin1, so "gard.png" survives and "gård.png"
 * arrives as mojibake. Swedish file names are the ordinary case in a Swedish
 * housing cooperative, so the name is also sent as the RFC 6266 `filename*`
 * parameter in the RFC 5987 encoding, which every current browser prefers. The
 * transliterated `filename` stays behind it for a client that reads only that.
 */
export function contentDisposition(fileName: string): string {
  // Everything outside printable ASCII becomes an underscore rather than being
  // dropped, so the fallback keeps the shape of the name and its extension.
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_");

  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeExtendedValue(fileName)}`;
}

/**
 * Percent-encoding for an RFC 5987 extended parameter value.
 *
 * encodeURIComponent is the right base but not the whole answer: it leaves
 * ! ' ( ) * - . _ ~ unescaped, and of those the apostrophe, the parentheses
 * and the asterisk are not attr-char. They are encoded here, because the
 * apostrophe in particular is the parameter's own delimiter.
 */
function encodeExtendedValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}
