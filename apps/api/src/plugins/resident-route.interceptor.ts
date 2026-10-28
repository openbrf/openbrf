import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable, throwError } from "rxjs";

import { checkedRoute } from "./plugin-module-seal";
import { ResidentRouteNotListedError } from "./plugin.errors";
import {
  residentRouteScopeOf,
  runOnResidentRoute,
} from "./resident-route-scope";

/**
 * Serves a resident route's request inside its scope (ADR 0051), so that what
 * the plugin's host object answers is narrowed for all of the handler's work.
 *
 * The guard checks that the caller is listed to the plugin and marks the
 * request; this opens the scope from that mark. An interceptor rather than the
 * guard itself because a guard returns before the handler runs and cannot hold
 * anything around it. The stream is subscribed inside the scope, because the
 * handler is called when it is subscribed to. A resident route the guard did
 * not mark, one reached with a connected app's token or a device's, is refused
 * before the handler runs. Any other request passes through untouched.
 */
@Injectable()
export class ResidentRouteInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (checkedRoute(context)?.residentRoute !== true) {
      return next.handle();
    }
    const scope = residentRouteScopeOf(
      context.switchToHttp().getRequest<object>(),
    );
    if (scope === null) {
      return throwError(() => new ResidentRouteNotListedError());
    }
    return new Observable((subscriber) =>
      runOnResidentRoute(scope, () => next.handle().subscribe(subscriber)),
    );
  }
}
