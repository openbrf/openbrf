import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
} from "@nestjs/common";
import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";
import type { FastifyReply, FastifyRequest } from "fastify";

import { deviceRequestOf } from "../devices/device-request";
import { DisplayContentService } from "./display-content.service";
import { readDisplayOptions } from "./display-options";

/**
 * The core's display route (ADR 0050): the screen content of the display mode,
 * and the pictures it refers to.
 *
 * A device route like a plugin's (ADR 0031). The authorization guard answers
 * every request here before this runs: only GET and HEAD, only a live device
 * token for this route in `Authorization: Bearer`, the same 401 with
 * `realm="device"` for every refusal, the per-token rate limit, and no cookie
 * read at all. The route headers hook adds the CORS headers and
 * `cache-control: no-store` to every answer, refusals included. So nothing
 * here declares a capability: no person is on the request to hold one.
 *
 * It never answers 404 to a token it accepts, apart from a picture it does not
 * show: the display mode cannot be switched off apart from its tokens.
 */
@Controller("api/display")
export class DisplayController {
  constructor(private readonly display: DisplayContentService) {}

  /**
   * The screen's document, or 304 to the tag it already holds. The query is
   * the display link's, which the display page sends unchanged.
   */
  @Get("content")
  async content(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const device = displayDevice(request);
    const options = readDisplayOptions(
      request.query as Readonly<Record<string, unknown>>,
    );
    const { content, etag } = await this.display.content(device, options);
    if (matchesTag(request.headers["if-none-match"], etag)) {
      void reply.status(304).header("etag", etag).send();
      return;
    }
    void reply
      .header("etag", etag)
      .header("content-type", "application/json; charset=utf-8")
      .send(JSON.stringify(content));
  }

  /**
   * A picture the current rotation refers to, or 404: one it does not refer
   * to, and one `media:read` would not open, answer alike.
   */
  @Get("pictures/:mediaFileId")
  async picture(
    @Param("mediaFileId") mediaFileId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    displayDevice(request);
    const file = await this.display.picture(mediaFileId);
    if (file === null) {
      throw new NotFoundException();
    }
    const etag = `"${file.checksum}"`;
    if (matchesTag(request.headers["if-none-match"], etag)) {
      file.stream.destroy();
      void reply.status(304).header("etag", etag).send();
      return;
    }
    void reply
      .headers({
        etag,
        "content-type": file.contentType,
        "content-length": String(file.byteSize),
        // As the media route serves a stored file: the type is the one
        // identified from the bytes, and nothing it holds may run.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      })
      .send(file.stream);
  }
}

/**
 * The token the guard accepted for this route.
 *
 * The guard marks every request it lets through on a device route, so a
 * request here without the display route's mark means the guard stopped
 * doing that, and a 500 is the honest answer.
 */
function displayDevice(request: object): DeviceTokenSummary {
  const mark = deviceRequestOf(request);
  if (mark === undefined || mark.pluginId !== null) {
    throw new Error("The authorization guard did not mark a display request.");
  }
  return mark.device;
}

/** Whether `If-None-Match` names the tag, as a strong comparison. */
function matchesTag(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => tag === "*" || tag === etag);
}
