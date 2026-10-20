import { Injectable } from "@nestjs/common";
import type { PluginMediaFile } from "@openbrf/plugin-sdk";
import { Readable } from "node:stream";

import { MediaService } from "../media/media.service";

/**
 * The association's pictures, as a plugin holding media:read opens them
 * (ADR 0032).
 *
 * Which picture a plugin may open is the media service's rule
 * (`MediaService.openForPlugin`), because that is where every other rule about
 * who reads a stored file lives. What this adds is the plugin's side: an id it
 * passed is not trusted to be a string, and what it is handed back is what a
 * reply serving the picture needs and nothing else. The name the picture was
 * uploaded under is somebody's own words, and it stays behind.
 */
@Injectable()
export class PluginMediaService {
  constructor(private readonly media: MediaService) {}

  async open(mediaFileId: unknown): Promise<PluginMediaFile | null> {
    if (typeof mediaFileId !== "string") {
      throw new RangeError("A media file id is a string.");
    }
    const served = await this.media.openForPlugin(mediaFileId);
    if (served === null) {
      return null;
    }
    return {
      contentType: served.contentType,
      byteSize: served.byteSize,
      checksum: served.checksum,
      // The contract's web stream over the media service's Node one.
      stream: Readable.toWeb(served.stream),
    };
  }
}
