import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * What a bucket that accepts the connection and then says nothing costs.
 *
 * A refused connection fails immediately and needs no help. The failure worth
 * testing is the one that looks like a working endpoint: the socket is
 * accepted, the request is sent, and no answer ever comes. Without a deadline
 * the upload stays pending and holds the request that started it.
 */
describe("a bucket that does not answer", () => {
  let held: ServerResponse[] = [];
  let silent: Server;
  let driverWithDeadline: S3StorageDriver;

  beforeAll(async () => {
    silent = createServer((_request, response) => {
      // Kept rather than answered, and kept referenced so the socket is not
      // collected and closed underneath the test.
      held.push(response);
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });

    driverWithDeadline = new S3StorageDriver({
      endpoint: `http://127.0.0.1:${String((silent.address() as AddressInfo).port)}`,
      region: server.region,
      bucket: server.bucket,
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true,
      // Short so the suite does not wait out the real one.
      requestTimeoutMs: 150,
    });
  });

  afterAll(async () => {
    for (const response of held) {
      response.destroy();
    }
    held = [];
    silent.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      silent.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("gives up on an upload rather than waiting for the socket", async () => {
    await expect(
      driverWithDeadline.put(
        "media/2026/08/held.png",
        Buffer.from("x"),
        "image/png",
      ),
    ).rejects.toThrow(StorageError);
  });

  it("gives up on a deletion too", async () => {
    await expect(
      driverWithDeadline.remove("media/2026/08/held.png"),
    ).rejects.toThrow(StorageError);
  });
});

/**
 * A file that takes longer to send than the deadline allows for an answer.
 *
 * The deadline is on the answer, not on the transfer. A signal still armed
 * once the headers are in would abort the body mid-flight and serve a
 * truncated image, which is worse than the hang it was meant to prevent - so
 * this states that a slow body is read to the end.
 */
describe("a bucket that answers and then sends slowly", () => {
  let slow: Server;
  let driverWithDeadline: S3StorageDriver;

  const BODY = Buffer.from("porttavlan");
  const CHUNK_DELAY_MS = 120;
  const TIMEOUT_MS = 80;

  beforeAll(async () => {
    slow = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(BODY.length),
      });
      response.write(BODY.subarray(0, 4));
      // After the deadline would have fired, had it not been cleared when the
      // headers went out.
      setTimeout(() => {
        response.end(BODY.subarray(4));
      }, CHUNK_DELAY_MS);
    });
    await new Promise<void>((resolve) => {
      slow.listen(0, "127.0.0.1", resolve);
    });

    driverWithDeadline = new S3StorageDriver({
      endpoint: `http://127.0.0.1:${String((slow.address() as AddressInfo).port)}`,
      region: server.region,
      bucket: server.bucket,
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true,
      requestTimeoutMs: TIMEOUT_MS,
    });
  });

  afterAll(async () => {
    slow.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      slow.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("reads the whole file even when it arrives after the deadline", async () => {
    const read = await collect(
      await driverWithDeadline.open("media/2026/08/slow.png"),
    );

    expect(read).toEqual(BODY);
  });
});
