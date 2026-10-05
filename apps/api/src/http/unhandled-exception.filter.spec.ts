import {
  Controller,
  Get,
  HttpStatus,
  type LoggerService,
  NotFoundException,
} from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { DomainError } from "./domain-error";
import { EXCEPTION_FILTERS } from "./unhandled-exception.filter";

/**
 * What a failure nobody planned for leaves behind: a generic 500 for the caller
 * and the failure's class in the log, never its message.
 *
 * Over a real application and real requests, with the filters registered
 * exactly as the application registers them. The order is the point of half of
 * these cases: Nest asks the last-registered global filter first, so a
 * catch-all registered in the wrong place answers every domain refusal with a
 * 500, and only a request through the real dispatch shows it.
 */

const ADDRESS = "anna.lindqvist@example.se";

class SeatTakenError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "seat-taken";
}

/** The shape of a Fastify error, which carries an HTTP status of its own. */
class FileTooLargeError extends Error {
  override readonly name = "FastifyError";
  readonly code = "FST_REQ_FILE_TOO_LARGE";
  readonly statusCode = HttpStatus.PAYLOAD_TOO_LARGE;
}
Object.defineProperty(FileTooLargeError, "name", { value: "FastifyError" });

@Controller("fail")
class FailingController {
  @Get("unplanned")
  unplanned(): never {
    // What a mail server's rejection reads like once it reaches a handler.
    throw new Error(`550 5.1.1 <${ADDRESS}>: Recipient address rejected`);
  }

  @Get("domain")
  domain(): never {
    throw new SeatTakenError("The seat is taken.");
  }

  @Get("validation")
  validation(): never {
    z.object({ email: z.email() }).parse({ email: "not an address" });
    throw new Error("unreachable");
  }

  @Get("http")
  http(): never {
    throw new NotFoundException("No such apartment.");
  }

  @Get("fastify")
  fastify(): never {
    throw new FileTooLargeError("request file too large");
  }
}

/** Everything any logger in the application was asked to write. */
const logged: string[] = [];

const capture: LoggerService = {
  log: (...args: unknown[]) => record(args),
  error: (...args: unknown[]) => record(args),
  warn: (...args: unknown[]) => record(args),
  debug: (...args: unknown[]) => record(args),
  verbose: (...args: unknown[]) => record(args),
  fatal: (...args: unknown[]) => record(args),
};

function record(args: unknown[]): void {
  logged.push(
    args
      .map((arg) => (arg instanceof Error ? (arg.stack ?? "") : String(arg)))
      .join("\n"),
  );
}

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [FailingController],
    providers: EXCEPTION_FILTERS,
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: capture },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

const get = (url: string) =>
  app.getHttpAdapter().getInstance().inject({ method: "GET", url });

describe("an error nothing else answers", () => {
  it("is a generic 500 that repeats nothing it carried", async () => {
    const response = await get("/fail/unplanned");

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
  });

  it("is logged by its class and frames, never its message", async () => {
    logged.length = 0;

    await get("/fail/unplanned");

    const log = logged.join("\n");
    expect(log).toContain("Unhandled Error");
    // The frames are what place the failure, so they have to survive.
    expect(log).toContain("FailingController.unplanned");
    expect(log).not.toContain(ADDRESS);
    expect(log).not.toContain("Recipient address rejected");
  });
});

describe("what the catch-all leaves alone", () => {
  it("lets a domain refusal keep its own status and reason", async () => {
    const response = await get("/fail/domain");

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "seat-taken" });
  });

  it("lets a validation failure stay a 400", async () => {
    const response = await get("/fail/validation");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: "invalid-body" });
  });

  it("lets an HttpException answer with its own status and body", async () => {
    const response = await get("/fail/http");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ message: "No such apartment." });
  });

  it("lets an error with an HTTP status of its own keep it", async () => {
    const response = await get("/fail/fastify");

    expect(response.statusCode).toBe(413);
  });
});
