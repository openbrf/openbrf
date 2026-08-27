import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

import { InvitationError } from "../invitations/invitation.service";
import { SignupRequestError } from "../signup/signup-request.service";

/**
 * Translates request validation failures and domain errors into responses.
 *
 * Without this the controllers hand a ZodError or a domain error straight to
 * Nest, which has no rule for either and answers 500. A rejected invitation
 * token or a sign-up request the board already decided is not a server fault,
 * and logging it as one buries the real failures.
 *
 * Only the types listed in @Catch reach this filter; anything else keeps
 * Nest's own handling, so an HttpException thrown elsewhere still carries its
 * own status.
 */
@Catch(ZodError, InvitationError, SignupRequestError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(
    exception: ZodError | InvitationError | SignupRequestError,
    host: ArgumentsHost,
  ): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof ZodError) {
      void reply.status(HttpStatus.BAD_REQUEST).send({
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        reason: "invalid-body",
        // Field paths and messages only: never the submitted values, which
        // are personal data on these endpoints.
        issues: exception.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const status =
      exception instanceof InvitationError
        ? invitationStatus(exception.reason)
        : signupStatus(exception.reason);

    if (status >= 500) {
      this.logger.error(exception.message, exception.stack);
    }

    void reply.status(status).send({
      statusCode: status,
      error: exception.name,
      // Machine-readable, so a client can react without matching on prose.
      reason: exception.reason,
      message: exception.message,
    });
  }
}

function invitationStatus(reason: InvitationError["reason"]): number {
  switch (reason) {
    case "person-not-found":
      return HttpStatus.NOT_FOUND;
    case "already-has-account":
    case "already-accepted":
      return HttpStatus.CONFLICT;
    case "expired":
      // Gone rather than Bad Request: the link was valid and no longer is,
      // which is what the activation screen needs to tell the recipient.
      return HttpStatus.GONE;
    case "invalid-token":
      return HttpStatus.BAD_REQUEST;
    case "no-email":
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

function signupStatus(reason: SignupRequestError["reason"]): number {
  switch (reason) {
    case "self-signup-disabled":
      return HttpStatus.FORBIDDEN;
    case "invalid-email":
      return HttpStatus.BAD_REQUEST;
    case "not-found":
    case "apartment-not-found":
      return HttpStatus.NOT_FOUND;
    case "already-decided":
    case "already-has-account":
      return HttpStatus.CONFLICT;
  }
}
