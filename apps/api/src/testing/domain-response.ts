import type { ArgumentsHost } from "@nestjs/common";

import type { DomainError } from "../http/domain-error";
import { DomainExceptionFilter } from "../http/domain-exception.filter";

/**
 * What the API answers a domain error with: status, headers and body, read
 * from the filter the application installs rather than from the error's own
 * fields, so a test sees what a client would.
 */
export function domainResponse(exception: DomainError): {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const answer = {
    status: 0,
    headers: {} as Record<string, string>,
    body: {} as Record<string, unknown>,
  };
  const reply = {
    header: (name: string, value: string) => {
      answer.headers[name] = value;
      return reply;
    },
    status: (value: number) => {
      answer.status = value;
      return reply;
    },
    send: (payload: Record<string, unknown>) => {
      answer.body = payload;
      return reply;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  new DomainExceptionFilter().catch(exception, host);
  return answer;
}
