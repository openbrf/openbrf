import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DomainExceptionFilter } from "../http/domain-exception.filter";
import { TooManyRequestsError } from "../http/public-rate-limit.guard";
import { isApiRequest } from "../http/serve-single-page-app";
import { failureFrames, failureName } from "../logging/failure";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

/**
 * Answers a spent public budget on a website address with a page in the
 * visitor's language.
 *
 * The refusal the rate limit throws is a domain error, and the domain filter
 * answers it as one: JSON carrying the code `too-many-requests`, which the
 * application's screens map to a sentence of their own. A page on the
 * association's website has no script to do that mapping. A form posts to it
 * and the browser shows whatever comes back, so a visitor who sent the contact
 * form twenty times would read the API's English JSON. Every address outside
 * /api is the website's, so the rule is decided by the path, once, here: a new
 * public route on the website gets this page by carrying @PublicRateLimit,
 * and an API route keeps the JSON it has always had.
 *
 * Registered after the domain filter, and Nest asks the global filters
 * last-registered first, so this one is asked before it for exactly the one
 * error it names (app.module.ts).
 *
 * The page is the not-found page's sibling: drawn from the chrome alone, with
 * the anonymous menu, so it is the same for every address that keeps a budget.
 * The Retry-After the guard set on the reply is kept.
 */
@Catch(TooManyRequestsError)
@Injectable()
export class SiteRateLimitFilter implements ExceptionFilter {
  private readonly logger = new Logger(SiteRateLimitFilter.name);
  private readonly api = new DomainExceptionFilter();

  constructor(private readonly renderer: SiteRenderer) {}

  async catch(
    exception: TooManyRequestsError,
    host: ArgumentsHost,
  ): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    if (isApiRequest(request.url)) {
      this.api.catch(exception, host);
      return;
    }

    const acceptLanguage = request.headers["accept-language"];
    let html: string;
    try {
      html = await this.renderer.tooManyRequests(
        typeof acceptLanguage === "string" ? acceptLanguage : undefined,
      );
    } catch (cause) {
      /*
       * The renderer reads the theme and the association's name, so it can
       * fail as a database read does. The visitor is still owed the refusal
       * and its delay rather than a 500: the status and nothing else, as the
       * not-found route answers when its own page cannot be drawn. The class
       * and frames are logged, never the message (ADR 0007).
       */
      this.logger.error(
        `The website's rate-limit page could not be rendered: ${failureName(cause)}`,
        failureFrames(cause),
      );
      void reply.code(HttpStatus.TOO_MANY_REQUESTS).send();
      return;
    }

    void reply
      .code(HttpStatus.TOO_MANY_REQUESTS)
      .headers(SITE_HTML_HEADERS)
      .send(html);
  }
}
