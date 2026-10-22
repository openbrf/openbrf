import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";

import { runForSupportSession } from "../audit/acting-support-session";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";

/**
 * Serves a support session's request inside its own storage (ADR 0028), so
 * that every audit entry the handler writes is on SUPPORT and names the
 * session, whatever channel its call site passed.
 *
 * The guard decides that a request is a support session's and marks it; this
 * runs the handler with that mark where AuditLogService.record can read it. An
 * interceptor rather than the guard itself because a guard returns before the
 * handler runs and cannot hold anything around it. A request the guard did not
 * mark passes through untouched.
 */
@Injectable()
export class SupportRequestInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const support = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal>().support;
    if (support === undefined) {
      return next.handle();
    }
    /*
     * Subscribed inside the storage rather than wrapped around it: the handler
     * is called when the stream is subscribed to, and everything it awaits
     * carries the storage on from there.
     */
    return new Observable((subscriber) =>
      runForSupportSession(support.sessionId, () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}
