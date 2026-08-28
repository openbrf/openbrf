import { HttpStatus, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DomainError } from "./domain-error";
import { DomainExceptionFilter } from "./domain-exception.filter";

/**
 * What a refusal is allowed to say.
 *
 * The endpoints this filter answers for handle personal data, so the rule is
 * that a field reaches a response body because the error that owns it declared
 * it publishable, and for no other reason. A filter that discovered particulars
 * by looking for well-known property names would publish whatever a future
 * error happened to call `issues`, and nothing in the type system would stop
 * it.
 */

function respond(exception: Parameters<DomainExceptionFilter["catch"]>[0]): {
  status: number;
  body: Record<string, unknown>;
} {
  let status = 0;
  let body: Record<string, unknown> = {};
  const reply = {
    status: (value: number) => {
      status = value;
      return reply;
    },
    send: (payload: Record<string, unknown>) => {
      body = payload;
      return reply;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;

  new DomainExceptionFilter().catch(exception, host);
  return { status, body };
}

/** A failure that carries particulars and says nothing about publishing them. */
class UndeclaredError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "undeclared";
  readonly issues = ["19800101-1234 is already registered"];
  readonly findings = [{ personalIdentityNumber: "19800101-1234" }];
}

/** A failure that publishes exactly what it names, and nothing else. */
class DeclaredError extends DomainError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly reason = "declared";
  readonly secret = ["19800101-1234"];

  override details(): Record<string, readonly unknown[]> {
    return { findings: [{ rule: "contrast", ratio: 1.1 }], issues: [] };
  }
}

describe("the particulars a refusal publishes", () => {
  it("says nothing an error did not declare, however its fields are named", () => {
    const { status, body } = respond(new UndeclaredError("Refused."));

    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body["reason"]).toBe("undeclared");
    expect(body).not.toHaveProperty("issues");
    expect(body).not.toHaveProperty("findings");
  });

  it("publishes what an error declares, and leaves out what it has none of", () => {
    const { body } = respond(new DeclaredError("Refused."));

    expect(body["findings"]).toEqual([{ rule: "contrast", ratio: 1.1 }]);
    // An empty array is not a particular: the screen would render a heading
    // over nothing.
    expect(body).not.toHaveProperty("issues");
    expect(body).not.toHaveProperty("secret");
  });

  it("still answers a request validation failure with paths and messages only", () => {
    const parsed = z
      .object({ personalIdentityNumber: z.string().min(20) })
      .safeParse({ personalIdentityNumber: "19800101-1234" });
    if (parsed.success) {
      throw new Error("The fixture was expected to fail validation.");
    }

    const { status, body } = respond(parsed.error);

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body["issues"]).toEqual([
      { path: "personalIdentityNumber", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify(body)).not.toContain("19800101-1234");
  });
});

describe("the status a refusal answers with", () => {
  it("takes it from the error rather than from a table in the filter", () => {
    expect(respond(new DeclaredError("Refused.")).status).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(respond(new UndeclaredError("Refused.")).status).toBe(
      HttpStatus.CONFLICT,
    );
  });
});
