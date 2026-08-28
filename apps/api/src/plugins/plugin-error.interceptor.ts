import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { catchError, type Observable, throwError } from "rxjs";

import { DomainError } from "../http/domain-error";
import { failureFrames, failureName } from "../logging/failure";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginHandlerError } from "./plugin.errors";

/**
 * Answers a plugin's own failure as a bad gateway.
 *
 * A plugin runs in this process but is not this product's code, and an
 * operator reading a log needs that distinction before they can decide whose
 * bug it is and whether to switch the plugin off. Without this, a plugin
 * throwing would be indistinguishable from a fault in the application itself.
 *
 * An HttpException is left alone: a plugin answering 404 for a resource of its
 * own has said what it meant, and rewriting that would make a working plugin
 * look broken.
 *
 * What is written to the log is the identity of the failure and its call
 * frames, never the thrown payload. This is the designated sink for every
 * unexpected plugin throw, and the message is the plugin's own text: a plugin
 * reading the register through its consented host services can put a
 * resident's address or a personal identity number in it. Protected personal
 * data is masked server-side and every reveal is audit-logged in the same
 * transaction as the read, so a copy in an unstructured application log is a
 * disclosure to anyone with log access and a retention breach at once.
 */
@Injectable()
export class PluginErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PluginErrorInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const pluginId = this.reflector.get<string | undefined>(
      PLUGIN_ID_METADATA,
      context.getClass(),
    );
    if (pluginId === undefined) {
      return next.handle();
    }

    return next.handle().pipe(
      catchError((cause: unknown) => {
        if (cause instanceof HttpException || cause instanceof DomainError) {
          return throwError(() => cause);
        }
        this.logger.error(
          `Plugin "${pluginId}" failed handling ` +
            `${context.getClass().name}.${context.getHandler().name}: ` +
            failureName(cause),
          failureFrames(cause),
        );
        return throwError(() => new PluginHandlerError(pluginId));
      }),
    );
  }
}
