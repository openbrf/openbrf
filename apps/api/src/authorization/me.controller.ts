import { Controller, Get, Req } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import { mediaUrl } from "../media/media.service";
import type { RequestWithPrincipal } from "./authorization.guard";
import type { Capability } from "./capabilities";
import { OpenToSupport } from "./open-to-support.decorator";

export interface ViewerView {
  personId: string;
  firstName: string;
  lastName: string;
  preferredLocale: string;
  /** What this viewer may do, so the interface offers only that. */
  capabilities: Capability[];
  /**
   * The housing cooperative's own identity, for the band and the mail brand.
   *
   * Null until the setup wizard has named it. Behind a session rather than
   * public: the sign-in screen has no need for it, and everything about an
   * instance sits behind a login (decision 28).
   */
  housingCooperative: {
    name: string;
    primaryColor: string | null;
    /**
     * Where the band fetches the housing cooperative's mark: a path on this
     * instance's own origin, or null when none is uploaded. `logoDarkUrl` is
     * the variant for the dark band; when it is null the band renders the mark
     * above on a light plate instead.
     */
    logoUrl: string | null;
    logoDarkUrl: string | null;
  } | null;
  /**
   * The support session this viewer is (ADR 0028), or null for an account.
   *
   * When it is set the person fields above are the administrator who opened
   * the access, the capabilities are the support list, and every screen says
   * who the supporter is, that the access is read-only and when it ends.
   */
  support: {
    /** Who the host said it was sending. */
    supporter: string;
    /** When the session stops working: its own end or the access's. */
    endsAt: string;
  } | null;
}

/**
 * Who is signed in, and what they may do.
 *
 * The interface needs this to decide what to render: whether to offer the
 * settings screens at all, whether the setup wizard may be resumed, and what
 * name to put on the band. Without it the client would either guess from a role
 * name it invented or call an endpoint and read the 403.
 *
 * It is NOT an authorization decision. The capability list here is a copy of
 * what the guard will enforce on every request, so hiding a control is only
 * courtesy: the server refuses the call regardless.
 *
 * The person id comes from the session, never from the request, so this route
 * cannot be pointed at somebody else.
 *
 * No capability is declared, and that is stated here rather than left to be
 * noticed: every principal may ask who it is. It used to declare self:manage,
 * which capabilitiesFor grants to every account and so narrowed nothing, but a
 * support session holds no self:manage (ADR 0028) and still has to learn what
 * it may reach and when it ends. The global guard still requires a session,
 * and the route is opened to a support session by name, which a route that
 * declares nothing has to be.
 */
@Controller("api/me")
@OpenToSupport()
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@Req() request: RequestWithPrincipal): Promise<ViewerView> {
    const principal = request.principal;
    if (principal === undefined) {
      // Unreachable: the global guard attaches the principal or rejects the
      // request. Stated so the type is honest rather than asserted away.
      throw new Error("The authorization guard did not attach a principal.");
    }

    const [person, association] = await Promise.all([
      this.prisma.person.findUnique({
        where: { id: principal.personId },
        select: { firstName: true, lastName: true, preferredLocale: true },
      }),
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: {
          name: true,
          primaryColor: true,
          logoFileId: true,
          logoDarkFileId: true,
        },
      }),
    ]);

    if (person === null) {
      // The id is deliberately left out: this message reaches the exception
      // filter and the server log, and a person id identifies somebody in the
      // member register.
      throw new Error(
        "The session names a person that no longer exists in the register.",
      );
    }

    return {
      personId: principal.personId,
      firstName: person.firstName,
      lastName: person.lastName,
      preferredLocale: person.preferredLocale,
      capabilities: [...principal.capabilities],
      support:
        request.support === undefined
          ? null
          : {
              supporter: request.support.supporter,
              endsAt: request.support.endsAt.toISOString(),
            },
      housingCooperative:
        association === null
          ? null
          : {
              name: association.name,
              primaryColor: association.primaryColor,
              logoUrl:
                association.logoFileId === null
                  ? null
                  : mediaUrl(association.logoFileId),
              logoDarkUrl:
                association.logoDarkFileId === null
                  ? null
                  : mediaUrl(association.logoDarkFileId),
            },
    };
  }
}
