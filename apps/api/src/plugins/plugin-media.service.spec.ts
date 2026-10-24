import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

import type { MediaService, ServedFile } from "../media/media.service";
import { PluginMediaService } from "./plugin-media.service";

/**
 * What media:read hands a plugin: what a reply serving a picture needs, as a
 * web stream, and nothing about where the picture came from (ADR 0032). Which
 * picture a plugin may open is the media service's rule, held in
 * `media.service.spec.ts`.
 */

const SERVED: ServedFile = {
  stream: Readable.from([Buffer.from("png-bytes")]),
  contentType: "image/png",
  byteSize: 9,
  fileName: "Anna Andersson på gården.png",
  checksum: "c0ffee",
  visibility: "MEMBER",
};

function serviceOpening(served: ServedFile | null) {
  const openForPlugin = vi.fn(async () => served);
  const media = { openForPlugin } as unknown as MediaService;
  return { service: new PluginMediaService(media), openForPlugin };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

describe("open", () => {
  it("hands over the type, the size, the checksum, the audience and the bytes, and nothing else", async () => {
    const { service, openForPlugin } = serviceOpening({
      ...SERVED,
      stream: Readable.from([Buffer.from("png-bytes")]),
    });

    const opened = await service.open("media-1");

    expect(openForPlugin).toHaveBeenCalledWith("media-1");
    // The name it was uploaded under is somebody's own words, and the
    // stored visibility is the host's business: only the audience it means.
    expect(Object.keys(opened ?? {}).sort()).toEqual([
      "audience",
      "byteSize",
      "checksum",
      "contentType",
      "stream",
    ]);
    expect(opened).toMatchObject({
      contentType: "image/png",
      byteSize: 9,
      checksum: "c0ffee",
      audience: "members",
    });
  });

  it.each([
    ["PUBLIC", "anyone"],
    ["MEMBER", "members"],
  ] as const)("says a %s picture is for %s", async (visibility, audience) => {
    const { service } = serviceOpening({ ...SERVED, visibility });

    await expect(service.open("media-1")).resolves.toMatchObject({ audience });
  });

  it("refuses to label a picture that is for neither audience", async () => {
    const { service } = serviceOpening({ ...SERVED, visibility: "INTERNAL" });

    await expect(service.open("media-1")).rejects.toThrow(/neither audience/);
  });

  it("gives the bytes as a web stream", async () => {
    const { service } = serviceOpening({
      ...SERVED,
      stream: Readable.from([Buffer.from("png-"), Buffer.from("bytes")]),
    });

    const opened = await service.open("media-1");

    expect(opened?.stream).toBeInstanceOf(ReadableStream);
    expect(
      await collect(opened?.stream as unknown as ReadableStream<Uint8Array>),
    ).toBe("png-bytes");
  });

  it("answers null when the media service does", async () => {
    const { service } = serviceOpening(null);

    await expect(service.open("media-absent")).resolves.toBeNull();
  });

  it.each([undefined, 42, { id: "media-1" }])(
    "refuses an id that is not a string (%s) without asking for it",
    async (id) => {
      const { service, openForPlugin } = serviceOpening(SERVED);

      await expect(service.open(id)).rejects.toBeInstanceOf(RangeError);
      expect(openForPlugin).not.toHaveBeenCalled();
    },
  );
});
