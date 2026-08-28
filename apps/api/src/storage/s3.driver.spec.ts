import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { S3StorageDriver } from "./s3.driver";
import { StorageError } from "./storage.driver";
import { startS3TestServer, type S3TestServer } from "./testing/s3-test-server";

/**
 * The S3 driver, against an S3-compatible server in this process.
 *
 * The server recomputes every signature and answers 403 when it does not
 * match, so these cases prove the driver signs correctly rather than merely
 * that it calls the right method. Nothing here reaches the network.
 */

let server: S3TestServer;
let driver: S3StorageDriver;

beforeAll(async () => {
  server = await startS3TestServer();
  driver = new S3StorageDriver({
    endpoint: server.endpoint,
    region: server.region,
    bucket: server.bucket,
    accessKeyId: server.accessKeyId,
    secretAccessKey: server.secretAccessKey,
    forcePathStyle: true,
  });
});

afterAll(async () => {
  await server.close();
});

async function collect(
  stream: NodeJS.ReadableStream | null,
): Promise<Buffer | null> {
  if (stream === null) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("the S3 driver", () => {
  it("stores and reads back the same bytes", async () => {
    const bytes = Buffer.from("porttavlan", "utf8");
    await driver.put("media/2026/08/one.png", bytes, "image/png");

    const read = await collect(await driver.open("media/2026/08/one.png"));

    expect(read).toEqual(bytes);
  });

  it("signs every request in a way the server accepts", async () => {
    await driver.put("media/2026/08/two.png", Buffer.from("x"), "image/png");
    await driver.open("media/2026/08/two.png");
    await driver.remove("media/2026/08/two.png");

    // The server answers 403 on a bad signature, so a driver that signed
    // wrongly would already have failed above. This states the property
    // directly rather than leaving it implied by the absence of an error.
    expect(server.requests.every((entry) => entry.signatureValid)).toBe(true);
  });

  it("addresses the bucket in the path when asked to", async () => {
    await driver.put("media/2026/08/three.png", Buffer.from("x"), "image/png");

    const last = server.requests.at(-1);

    expect(last?.path).toBe(`/${server.bucket}/media/2026/08/three.png`);
  });

  it("sends the content type it was given", async () => {
    await driver.put("media/2026/08/four.webp", Buffer.from("x"), "image/webp");

    expect(server.objects.get("media/2026/08/four.webp")?.contentType).toBe(
      "image/webp",
    );
  });

  it("reports a key that is not there as null rather than as a failure", async () => {
    expect(await driver.open("media/2026/08/absent.png")).toBeNull();
  });

  it("treats removing something that is not there as done", async () => {
    await expect(
      driver.remove("media/2026/08/absent.png"),
    ).resolves.toBeUndefined();
  });

  it("fails loudly when the bucket cannot be reached", async () => {
    const unreachable = new S3StorageDriver({
      // Port 1 is reserved and nothing listens on it.
      endpoint: "http://127.0.0.1:1",
      region: server.region,
      bucket: server.bucket,
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true,
    });

    await expect(unreachable.open("media/2026/08/one.png")).rejects.toThrow(
      StorageError,
    );
  });

  it("does not accept a signature made with the wrong secret", async () => {
    const wrong = new S3StorageDriver({
      endpoint: server.endpoint,
      region: server.region,
      bucket: server.bucket,
      accessKeyId: server.accessKeyId,
      secretAccessKey: "not-the-secret",
      forcePathStyle: true,
    });

    /*
     * The point is the server, not the driver: this proves the test server
     * really checks signatures, so the passing cases above mean something.
     */
    await expect(
      wrong.put("media/2026/08/five.png", Buffer.from("x"), "image/png"),
    ).rejects.toThrow(StorageError);
  });
});
