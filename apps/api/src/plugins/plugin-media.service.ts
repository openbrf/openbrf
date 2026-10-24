import { Injectable } from "@nestjs/common";
import type {
  PluginContentAudience,
  PluginMediaFile,
} from "@openbrf/plugin-sdk";
import { Readable } from "node:stream";

import { type MediaVisibility, MediaService } from "../media/media.service";

/**
 * The association's pictures, as a plugin holding media:read opens them
 * (ADR 0032).
 *
 * Which picture a plugin may open is the media service's rule
 * (`MediaService.openForPlugin`), because that is where every other rule about
 * who reads a stored file lives. What this adds is the plugin's side: an id it
 * passed is not trusted to be a string, and what it is handed back is what a
 * reply serving the picture needs and nothing else. The name the picture was
 * uploaded under is somebody's own words, and it stays behind. The audience
 * travels with the picture, as it does with a news item (ADR 0032): a picture
 * held for the members opens, and the plugin is told so, because the host
 * cannot know where it will be shown.
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
      audience: audienceOf(served.visibility),
      // The contract's web stream over the media service's Node one.
      stream: Readable.toWeb(served.stream),
    };
  }
}

/**
 * Who a picture is for. The media service opens only a picture held for anyone
 * or for the members, so any other visibility here is a broken rule upstream,
 * and it is refused rather than reported as the members' (which would hand a
 * plugin a label that is not true).
 */
function audienceOf(visibility: MediaVisibility): PluginContentAudience {
  if (visibility === "PUBLIC") {
    return "anyone";
  }
  if (visibility === "MEMBER") {
    return "members";
  }
  throw new Error(
    "A plugin was handed a picture that is for neither audience.",
  );
}
