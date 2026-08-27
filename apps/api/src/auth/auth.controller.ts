import { All, Controller, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "./auth.service";

/**
 * Bridges Better Auth into Fastify.
 *
 * Better Auth exposes a Web Fetch handler (Request in, Response out) while
 * Fastify speaks Node request and reply objects, so this translates between
 * them. Three details matter and are easy to get wrong:
 *
 *   The request URL is rebuilt from the incoming host rather than from a
 *   configured base, so Better Auth sees the origin the browser actually used.
 *
 *   Fastify has already parsed the JSON body by the time we get here, so it is
 *   re-serialized. Passing the parsed object would give Better Auth nothing to
 *   read.
 *
 *   Set-Cookie must be copied with getSetCookie(), which preserves multiple
 *   cookies. Iterating headers normally collapses them into one comma-joined
 *   value, and a browser then silently drops the session.
 */
@Controller("api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @All("*")
  async handle(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.auth.handler(toWebRequest(request));
    await sendWebResponse(reply, response);
  }
}

function toWebRequest(request: FastifyRequest): Request {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url, `${request.protocol}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.append(name, value);
    }
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? serializeBody(request.body as unknown) : undefined;

  return new Request(url, {
    method,
    headers,
    body,
  });
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  return JSON.stringify(body);
}

async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<void> {
  const setCookies = response.headers.getSetCookie();

  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      return;
    }
    void reply.header(name, value);
  });

  if (setCookies.length > 0) {
    // Set through the raw response so each cookie stays its own header.
    reply.raw.setHeader("set-cookie", setCookies);
  }

  void reply.status(response.status);
  const text = await response.text();
  await reply.send(text === "" ? null : text);
}
