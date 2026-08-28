import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { AwsClient } from "aws4fetch";

import { StorageError, type StorageDriver } from "./storage.driver";

export interface S3StorageConfig {
  /** Base URL of the S3-compatible service, without the bucket. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket in the path rather than in the host name. */
  forcePathStyle: boolean;
}

/**
 * Files in an S3-compatible bucket.
 *
 * The client is `aws4fetch`: a signer for the platform's own fetch, with no
 * dependencies of its own. The alternative was the AWS SDK's S3 client, which
 * brings a large dependency tree to provide a command model, retries,
 * multipart uploads and presigned URLs - and this driver wants none of them. It
 * makes three requests (PUT, GET, DELETE) against one bucket, and presigned
 * URLs are the one thing it must never produce: handing a browser a link to the
 * storage endpoint is exactly what the serving rule forbids.
 *
 * Nothing here is AWS-specific. The endpoint, the region and the addressing
 * style are all configuration, so a self-hosted server works the same way.
 */
export class S3StorageDriver implements StorageDriver {
  readonly kind = "s3" as const;

  private readonly client: AwsClient;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // Stated rather than inferred from the host name, which is what
      // aws4fetch does by default and which cannot work for an endpoint that
      // is not an AWS one.
      service: "s3",
      region: config.region,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.send(key, {
      method: "PUT",
      // The signer hashes the body, so it has to be bytes rather than a
      // stream. Uploads are bounded by the configured limit and are already
      // held in full for validation, so nothing is buffered twice.
      body: new Uint8Array(body),
      headers: { "content-type": contentType },
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new StorageError(
        `The storage bucket refused to store ${key} (HTTP ${String(response.status)}).`,
        this.kind,
      );
    }
    await response.body?.cancel();
  }

  async open(key: string): Promise<Readable | null> {
    const response = await this.send(key, { method: "GET" });

    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new StorageError(
        `The storage bucket refused to serve ${key} (HTTP ${String(response.status)}).`,
        this.kind,
      );
    }

    /*
     * The bytes are piped into the reply from here, so the response never
     * lands in this process's memory in full.
     *
     * The cast bridges two spellings of the same object: fetch types its body
     * as the global ReadableStream and Readable.fromWeb takes the one declared
     * in node:stream/web. They are the same value at runtime.
     */
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  async remove(key: string): Promise<void> {
    const response = await this.send(key, { method: "DELETE" });
    await response.body?.cancel();

    // 404 counts as removed: the caller asked for the object to be gone.
    if (!response.ok && response.status !== 404) {
      throw new StorageError(
        `The storage bucket refused to delete ${key} (HTTP ${String(response.status)}).`,
        this.kind,
      );
    }
  }

  private async send(key: string, init: RequestInit): Promise<Response> {
    try {
      return await this.client.fetch(this.urlFor(key), init);
    } catch (cause) {
      throw new StorageError(
        `The storage bucket could not be reached for ${key}.`,
        this.kind,
        { cause },
      );
    }
  }

  /**
   * The object's URL at the storage endpoint.
   *
   * Private on purpose. This string is a credentialed address of a third-party
   * service and has no business in a response: every route that serves a file
   * streams it instead.
   */
  private urlFor(key: string): string {
    const endpoint = new URL(this.config.endpoint);
    const path = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    if (this.config.forcePathStyle) {
      endpoint.pathname = `/${encodeURIComponent(this.config.bucket)}/${path}`;
      return endpoint.toString();
    }

    endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `/${path}`;
    return endpoint.toString();
  }
}
