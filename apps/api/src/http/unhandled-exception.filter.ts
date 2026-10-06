import {
  type ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type Provider,
} from "@nestjs/common";
import { APP_FILTER, BaseExceptionFilter } from "@nestjs/core";

import { failureFrames, failureName } from "../logging/failure";
import { DomainExceptionFilter } from "./domain-exception.filter";

/**
 * Answers whatever no other filter claims, and logs it without its message.
 *
 * Nest's own last resort logs an unknown error whole, message and all, and the
 * errors that reach it are the ones nobody planned for: a mail server's
 * rejection quoting the address it refused, a database error naming the value
 * that broke a constraint. Both are personal data, and a container log is
 * outside the masking, the audit trail and the retention the register keeps
 * (ADR 0007). So this logs the failure's class and call frames, which say which
 * layer gave way and where, and answers with Nest's own generic 500.
 *
 * Everything else is Nest's behaviour unchanged. An HttpException keeps its
 * status and body, and so does an error that carries an HTTP status of its own -
 * a Fastify error such as a file over the upload limit - because the base class
 * routes only unknown errors here.
 */
@Catch()
export class UnhandledExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(UnhandledExceptionFilter.name);

  override handleUnknownError(exception: unknown, host: ArgumentsHost): void {
    this.logger.error(
      `Unhandled ${failureName(exception)}`,
      failureFrames(exception),
    );
    const body = this.isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: "Internal server error",
        };
    super.catch(new HttpException(body, body.statusCode), host);
  }
}

/**
 * The application's exception filters, in the order they have to be registered.
 *
 * Nest asks the global filters last-registered first and uses the first whose
 * @Catch matches, so the catch-all has to come before the domain filter or it
 * would answer the domain errors too, every refusal becoming a 500.
 */
export const EXCEPTION_FILTERS: Provider[] = [
  { provide: APP_FILTER, useClass: UnhandledExceptionFilter },
  { provide: APP_FILTER, useClass: DomainExceptionFilter },
];
