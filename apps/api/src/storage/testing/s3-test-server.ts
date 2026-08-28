import { createHash, createHmac } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";

/**
 * An S3-compatible object server, in this process.
 *
 * The S3 driver is tested against a real HTTP conversation rather than a stub
 * of its own methods, because what can go wrong is the conversation: the URL
 * the bucket is addressed at, the method, the headers, and above all the
 * signature. A stubbed client would pass with all four wrong.
 *
 * It runs in-process rather than in a container so the suite needs no
 * infrastructure and cannot reach the network, which also makes the
 * "never redirects to storage" assertion meaningful: there is no host outside
 * this process for a redirect to point at.
 *
 * The signature is recomputed here from the request, with an implementation
 * written from the AWS Signature Version 4 description rather than shared with
 * the driver. A bad signature is answered with 403, exactly as a real server
 * would, so a driver that signed incorrectly fails the round trip instead of
 * quietly passing.
 */
export interface S3TestServer {
  /** Base URL of the server, without the bucket. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** The stored objects, by key, for assertions. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Every request the driver made, in order. */
  requests: { method: string; path: string; signatureValid: boolean }[];
  close: () => Promise<void>;
}

const ACCESS_KEY_ID = "AKIAOPENBRFTEST";
const SECRET_ACCESS_KEY = "test-secret-key-for-the-local-server";
const REGION = "eu-north-1";
const BUCKET = "openbrf-test";

export async function startS3TestServer(): Promise<S3TestServer> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: S3TestServer["requests"] = [];

  const server = createServer((request, response) => {
    void handle(request, response, objects, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: REGION,
    objects,
    requests,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  objects: Map<string, { body: Buffer; contentType: string }>,
  requests: S3TestServer["requests"],
): Promise<void> {
  const body = await readBody(request);
  const path = request.url ?? "/";
  const signatureValid = verifySignature(request, body);

  requests.push({ method: request.method ?? "GET", path, signatureValid });

  if (!signatureValid) {
    response.writeHead(403).end("SignatureDoesNotMatch");
    return;
  }

  // Path-style addressing: /<bucket>/<key>.
  const prefix = `/${BUCKET}/`;
  if (!path.startsWith(prefix)) {
    response.writeHead(404).end("NoSuchBucket");
    return;
  }
  const key = decodeURIComponent(path.slice(prefix.length));

  switch (request.method) {
    case "PUT": {
      objects.set(key, {
        body,
        contentType: request.headers["content-type"] ?? "",
      });
      response.writeHead(200).end();
      return;
    }
    case "GET": {
      const stored = objects.get(key);
      if (stored === undefined) {
        response.writeHead(404).end("NoSuchKey");
        return;
      }
      response
        .writeHead(200, {
          "content-type": stored.contentType,
          "content-length": String(stored.body.length),
        })
        .end(stored.body);
      return;
    }
    case "DELETE": {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    default: {
      response.writeHead(405).end();
    }
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/**
 * Recomputes the request's signature and compares it with the one presented.
 *
 * Written from the AWS Signature Version 4 description: canonical request,
 * string to sign, a signing key derived through the date, region and service,
 * and an HMAC of the whole thing.
 */
function verifySignature(request: IncomingMessage, body: Buffer): boolean {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return false;
  }

  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]+)$/.exec(
      authorization,
    );
  if (match === null) {
    return false;
  }

  const [, keyId, date, region, service, signedHeaders, presented] = match;
  if (
    keyId !== ACCESS_KEY_ID ||
    region !== REGION ||
    service !== "s3" ||
    date === undefined ||
    signedHeaders === undefined
  ) {
    return false;
  }

  const url = new URL(request.url ?? "/", "http://placeholder");
  const names = signedHeaders.split(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${headerValue(request, name)}\n`)
    .join("");

  const payloadHash =
    (request.headers["x-amz-content-sha256"] as string | undefined) ??
    sha256Hex(body);

  // The payload hash the request declares has to be the payload it sent, or a
  // body could be swapped after signing.
  if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== sha256Hex(body)) {
    return false;
  }

  const canonicalRequest = [
    request.method ?? "GET",
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const amzDate = headerValue(request, "x-amz-date");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${SECRET_ACCESS_KEY}`, date), region), service),
    "aws4_request",
  );

  return (
    createHmac("sha256", signingKey).update(stringToSign).digest("hex") ===
    presented
  );
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return (value ?? "").trim();
}
