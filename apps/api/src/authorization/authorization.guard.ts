import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import type { Capability, Principal } from "./capabilities";
import { PrincipalService } from "./principal.service";
import { REQUIRED_CAPABILITIES } from "./require-capability.decorator";

/** The principal is attached here for controllers to read. */
export interface RequestWithPrincipal extends FastifyRequest {
  principal?: Principal;
}

/**
 * Resolves the session, builds the principal, and enforces the capabilities a
 * route declares.
 *
 * A route with no declared capability still requires a valid session: the
 * default is authenticated, not public. Anything genuinely public is served
 * outside this guard.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.append(name, value);
      }
    }

    const personId = await this.auth.personIdFromHeaders(headers);
    if (personId === null) {
      throw new UnauthorizedException("Sign in to continue.");
    }

    const principal = await this.principals.forPerson(personId);
    if (principal === null) {
      // An account whose person is gone must not act.
      throw new UnauthorizedException(
        "This account is not linked to a person.",
      );
    }
    request.principal = principal;

    const required = this.reflector.getAllAndMerge<Capability[]>(
      REQUIRED_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );

    const missing = required.filter(
      (capability) => !principal.capabilities.has(capability),
    );
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required permission: ${missing.join(", ")}`,
      );
    }

    return true;
  }
}
