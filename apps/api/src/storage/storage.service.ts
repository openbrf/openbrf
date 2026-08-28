import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Readable } from "node:stream";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { LocalDiskStorageDriver } from "./local-disk.driver";
import { S3StorageDriver } from "./s3.driver";
import type { StorageDriver } from "./storage.driver";

/**
 * The one way into file storage.
 *
 * Which driver is behind it is configuration, and nothing above this line is
 * allowed to care: the service exposes the driver's three operations and no way
 * to ask which one answered or to obtain an address at the backend. That is
 * what makes the serving rule structural rather than a convention - there is no
 * method here that could return a link for a browser to follow, so no route can
 * accidentally hand one out.
 */
@Injectable()
export class StorageService implements StorageDriver {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: StorageDriver;

  constructor(@Inject(ENV) env: Env) {
    this.driver = createDriver(env);
    this.logger.log(`File storage driver: ${this.driver.kind}`);
  }

  get kind(): StorageDriver["kind"] {
    return this.driver.kind;
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.driver.put(key, body, contentType);
  }

  open(key: string): Promise<Readable | null> {
    return this.driver.open(key);
  }

  remove(key: string): Promise<void> {
    return this.driver.remove(key);
  }
}

/**
 * Builds the configured driver.
 *
 * The S3 branch asserts its configuration rather than defaulting: the
 * environment schema has already refused to boot without it, and a fallback
 * here would silently write a housing cooperative's files somewhere other than
 * where its operator configured them.
 */
export function createDriver(env: Env): StorageDriver {
  if (env.OPENBRF_STORAGE_DRIVER === "local") {
    return new LocalDiskStorageDriver(env.OPENBRF_DATA_DIR);
  }

  const endpoint = env.OPENBRF_S3_ENDPOINT;
  const bucket = env.OPENBRF_S3_BUCKET;
  const accessKeyId = env.OPENBRF_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.OPENBRF_S3_SECRET_ACCESS_KEY;

  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new Error(
      "The S3 storage driver is selected but its endpoint, bucket or " +
        "credentials are missing.",
    );
  }

  return new S3StorageDriver({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.OPENBRF_S3_REGION,
    forcePathStyle: env.OPENBRF_S3_FORCE_PATH_STYLE,
  });
}
