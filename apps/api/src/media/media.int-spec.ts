import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { registerMultipart } from "../http/multipart";
import {
  startS3TestServer,
  type S3TestServer,
} from "../storage/testing/s3-test-server";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { MediaService } from "./media.service";
import { pngBytes } from "./testing/image-fixtures";

/**
 * File storage over HTTP, against a real database and the S3 driver.
 *
 * The property this suite exists for is the one the drivers cannot prove on
 * their own: a request for a file is answered by this instance, with the bytes,
 * and never with a redirect to the storage endpoint. The bucket here is an
 * S3-compatible server in this process, so the assertion is exact - a redirect
 * would name a host, and the only host there is belongs to the test server.
 *
 * The unit tests cover identification, the visibility rules and the storage
 * drivers. What only this suite can show is that the multipart upload, the
 * global authorization guard, the routing and the S3 driver work together: the
 * logo really is uploaded, really lands in the bucket, and really comes back
 * through the API.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let bucket: S3TestServer;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const admin = {
  personId: `media-admin-${suffix}`,
  email: `media-admin-${suffix}@exempel.se`,
};
const resident = {
  personId: `media-resident-${suffix}`,
  email: `media-resident-${suffix}@exempel.se`,
};
const personIds = [admin.personId, resident.personId];

/**
 * Small enough that an oversized upload is cheap to construct, and far below
 * anything an operator would configure. The limit is what stops a request from
 * filling the disk, so the refusal has to be exercised.
 */
const MAX_UPLOAD_BYTES = 512;

/** What the association row held before the suite, so it can be put back. */
let previousLogo: { logoFileId: string | null; logoDarkFileId: string | null };
let associationCreatedHere = false;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.7.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.7.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object | Buffer;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        ...options.headers,
      },
    });
}

/** A multipart body carrying one file, built by hand so no client is assumed. */
function multipart(
  bytes: Buffer,
  fileName: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----openbrfTestBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

interface BrandingBody {
  logo: { url: string; fileName: string } | null;
  logoDark: { url: string } | null;
}

async function uploadLogo(
  cookie: string,
  slot: "light" | "dark",
  bytes: Buffer,
  fileName = "logotyp.png",
  contentType = "image/png",
) {
  const body = multipart(bytes, fileName, contentType);
  return inject({
    method: "PUT",
    url: `/api/settings/branding/logo/${slot}`,
    payload: body.payload,
    headers: { ...body.headers, cookie },
  });
}

beforeAll(async () => {
  bucket = await startS3TestServer();

  const env: Env = {
    ...baseEnv,
    OPENBRF_STORAGE_DRIVER: "s3",
    OPENBRF_S3_ENDPOINT: bucket.endpoint,
    OPENBRF_S3_REGION: bucket.region,
    OPENBRF_S3_BUCKET: bucket.bucket,
    OPENBRF_S3_ACCESS_KEY_ID: bucket.accessKeyId,
    OPENBRF_S3_SECRET_ACCESS_KEY: bucket.secretAccessKey,
    OPENBRF_S3_FORCE_PATH_STYLE: true,
    OPENBRF_MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await registerMultipart(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { logoFileId: true, logoDarkFileId: true },
  });
  associationCreatedHere = existing === null;
  previousLogo = existing ?? { logoFileId: null, logoDarkFileId: null };

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  await prisma.person.createMany({
    data: [
      { id: admin.personId, firstName: "Alma", lastName: `Media${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Media${suffix}` },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });

  const auth = app.get(AuthService);
  for (const actor of [admin, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.association.update({
      where: { id: 1 },
      data: { logoFileId: null, logoDarkFileId: null },
    });
    await prisma.mediaFile.deleteMany({
      where: { uploadedByPersonId: { in: personIds } },
    });

    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    } else {
      await prisma.association.update({ where: { id: 1 }, data: previousLogo });
    }

    await prisma.session.deleteMany({
      where: { user: { personId: { in: personIds } } },
    });
    await prisma.account.deleteMany({
      where: { user: { personId: { in: personIds } } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  }

  await app?.close();
  await bucket?.close();
});

describe("uploading the housing cooperative's logo", () => {
  it("stores it and answers with a path on this instance's own origin", async () => {
    const cookie = await signIn(admin.email);

    const response = await uploadLogo(cookie, "light", pngBytes(240, 80));
    const branding = response.json() as BrandingBody;

    expect(response.statusCode).toBe(200);
    expect(branding.logo?.url).toMatch(/^\/api\/media\/[\w-]+$/);
    expect(branding.logo?.fileName).toBe("logotyp.png");
  });

  it("really puts the bytes in the bucket", async () => {
    const cookie = await signIn(admin.email);
    await uploadLogo(cookie, "light", pngBytes(240, 80));

    // Otherwise this suite would prove nothing about the S3 driver: a local
    // driver quietly in use would pass every other case here.
    const stored = [...bucket.objects.entries()].filter(([key]) =>
      key.startsWith("branding/"),
    );

    expect(stored.length).toBeGreaterThan(0);
    expect(bucket.requests.every((entry) => entry.signatureValid)).toBe(true);
  });

  it("refuses a file that is not an image", async () => {
    const cookie = await signIn(admin.email);

    const response = await uploadLogo(
      cookie,
      "light",
      Buffer.from("<svg onload=alert(1)>", "utf8"),
      "logotyp.png",
      // The declared type is a lie, which is the point: the bytes decide.
      "image/png",
    );

    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason: string }).reason).toBe(
      "unsupported-type",
    );
  });

  it("refuses a request with no file in it", async () => {
    const cookie = await signIn(admin.email);

    const response = await inject({
      method: "PUT",
      url: "/api/settings/branding/logo/light",
      payload: {},
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a file larger than the configured limit", async () => {
    const cookie = await signIn(admin.email);
    const oversized = Buffer.concat([
      pngBytes(10, 10),
      Buffer.alloc(MAX_UPLOAD_BYTES * 2),
    ]);

    const response = await uploadLogo(cookie, "light", oversized);

    expect(response.statusCode).toBe(413);
  });

  it("deletes the file it replaces", async () => {
    const cookie = await signIn(admin.email);

    const first = (
      await uploadLogo(cookie, "light", pngBytes(100, 100))
    ).json() as BrandingBody;
    const firstId = (first.logo?.url ?? "").split("/").pop() ?? "";

    await uploadLogo(cookie, "light", pngBytes(200, 50));

    // A logo has exactly one referent, so keeping the old one would leave
    // objects accumulating in the bucket that nothing can ever reach.
    expect(
      await prisma.mediaFile.findUnique({ where: { id: firstId } }),
    ).toBeNull();
  });

  it("clears the slot and the file on request", async () => {
    const cookie = await signIn(admin.email);
    await uploadLogo(cookie, "dark", pngBytes(120, 40));

    const response = await inject({
      method: "DELETE",
      url: "/api/settings/branding/logo/dark",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as BrandingBody).logoDark).toBeNull();
  });

  it("is closed to a resident, and to nobody at all", async () => {
    const residentCookie = await signIn(resident.email);
    const body = multipart(pngBytes(10, 10), "logotyp.png", "image/png");

    const asResident = await inject({
      method: "PUT",
      url: "/api/settings/branding/logo/light",
      payload: body.payload,
      headers: { ...body.headers, cookie: residentCookie },
    });
    const anonymous = await inject({
      method: "PUT",
      url: "/api/settings/branding/logo/light",
      payload: body.payload,
      headers: body.headers,
    });

    expect(asResident.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
  });

  it("has no slot other than the two it defines", async () => {
    const cookie = await signIn(admin.email);

    const response = await uploadLogo(
      cookie as string,
      "sepia" as "light",
      pngBytes(10, 10),
    );

    expect(response.statusCode).toBe(404);
  });
});

describe("serving a file with S3 behind it", () => {
  let url: string;
  let bytes: Buffer;

  beforeAll(async () => {
    bytes = pngBytes(240, 80);
    const cookie = await signIn(admin.email);
    const branding = (
      await uploadLogo(cookie, "light", bytes)
    ).json() as BrandingBody;
    url = branding.logo?.url ?? "";
  });

  it("streams the bytes rather than redirecting to the bucket", async () => {
    const response = await inject({ method: "GET", url });

    /*
     * The assertion this whole suite exists for. A redirect - or a link in the
     * body - would send the visitor's browser to the storage provider, handing
     * it the IP address, the timing and the referring page of every person who
     * looks at the association's site. It is the same disclosure the platform
     * refuses to make for typefaces.
     */
    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.rawPayload).toEqual(bytes);
  });

  it("names the storage endpoint nowhere in the answer", async () => {
    const response = await inject({ method: "GET", url });

    const host = new URL(bucket.endpoint).host;
    const headers = JSON.stringify(response.headers);

    expect(headers).not.toContain(host);
    expect(headers).not.toContain(bucket.accessKeyId);
    expect(response.body).not.toContain(host);
  });

  it("serves the type identified from the bytes, and pins it", async () => {
    const response = await inject({ method: "GET", url });

    expect(response.headers["content-type"]).toBe("image/png");
    // Without nosniff a browser may decide the bytes are something else, which
    // is exactly the decision the upload path took away from the client.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("lets a cached copy be revalidated", async () => {
    const first = await inject({ method: "GET", url });
    const etag = first.headers.etag as string;

    const second = await inject({
      method: "GET",
      url,
      headers: { "if-none-match": etag },
    });

    expect(second.statusCode).toBe(304);
  });

  it("answers a HEAD without transferring the file", async () => {
    const response = await inject({ method: "HEAD", url });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe(String(bytes.length));
    expect(response.rawPayload.length).toBe(0);
  });

  it("serves the logo to a visitor with no session", async () => {
    // Not a convenience: a mail client rendering the association's message
    // carries no cookie, and the public website's visitors have no account.
    const response = await inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
  });

  it("refuses an internal file to a visitor with no session", async () => {
    const internal = await app.get(MediaService).upload({
      bytes: pngBytes(20, 20),
      fileName: "gard.png",
      visibility: "INTERNAL",
      showsIdentifiablePersons: true,
      uploadedByPersonId: admin.personId,
    });

    const anonymous = await inject({ method: "GET", url: internal.url });
    const signedIn = await inject({
      method: "GET",
      url: internal.url,
      headers: { cookie: await signIn(resident.email) },
    });

    expect(anonymous.statusCode).toBe(404);
    expect(signedIn.statusCode).toBe(200);
  });

  it("answers for a file that does not exist the same way", async () => {
    const response = await inject({ method: "GET", url: "/api/media/nothing" });

    expect(response.statusCode).toBe(404);
  });
});
