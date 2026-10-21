import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  AudienceListView,
  NotReadView,
  PostCommentView,
  PostView,
  RevisionListView,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { NewsWriteService } from "../news/news-write.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * What the feed adds to a post once it is written, against a real database:
 * editing with history, the board's must-read list, an issue report made from
 * a post, a scheduled post withdrawn, and the read marker the screen measures
 * "new since your last visit" from (ADR 0026).
 *
 * Each over HTTP, through the guard, the controller's schema and the service,
 * because who may do each is the whole of what these features decide, and the
 * principal a real sign-in builds is what decides it.
 *
 *   An author edits their own post and comment, and the text that stood is
 *   kept. The author and the board read it; a neighbour who may read the post
 *   is told the history is not theirs, and somebody outside the audience is
 *   answered as for a post that does not exist.
 *
 *   On an important post the board is told who in the audience has not opened
 *   it - not its author, and not whoever has - and nobody else is told.
 *
 *   A report made from a post is filed and linked in one transaction, by the
 *   post's author or the board and nobody else, once. The post shows the
 *   report's status to its reporter and to whoever handles issues.
 *
 *   A post the board scheduled to Styrelsen is withdrawn by the board before
 *   its instant, and not after it was published.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** On the board, and lives here: moderates, handles issues, writes as Styrelsen. */
const seated = {
  personId: `feed-add-seated-${suffix}`,
  email: `feed-add-seated-${suffix}@exempel.se`,
};
/** Lives here: the author of the posts these tests edit and report from. */
const karin = {
  personId: `feed-add-karin-${suffix}`,
  email: `feed-add-karin-${suffix}@exempel.se`,
};
/** Lives here: a neighbour who reads Karin's posts and wrote none of them. */
const nils = {
  personId: `feed-add-nils-${suffix}`,
  email: `feed-add-nils-${suffix}@exempel.se`,
};
/** Holds every capability through the ADMIN grant, and is not in Alla. */
const administrator = {
  personId: `feed-add-admin-${suffix}`,
  email: `feed-add-admin-${suffix}@exempel.se`,
};

const people = [seated, karin, nils, administrator];
const personIds = people.map((who) => who.personId);

let addressId: string;
let apartmentId: string;
let issueTypeId: string;
let allAudienceId: string;
let boardAudienceId: string;
const cookies = new Map<string, string>();

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.81.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.81.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: object;
  as: { email: string };
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      payload: options.payload,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
        cookie: cookies.get(options.as.email) ?? "",
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "x-forwarded-for": nextForwardedFor() },
      payload: { email, password: PASSWORD },
    });
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return values.map((value) => value.split(";")[0]).join("; ");
}

/** A post written to Alla by one of the residents, over HTTP. */
async function postBy(who: { email: string }, body: string): Promise<PostView> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/posts",
    payload: { audienceId: allAudienceId, body },
    as: who,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PostView>();
}

/** A post written as Styrelsen, with the composer's defaults unless told. */
async function boardPost(
  overrides: Record<string, unknown> = {},
): Promise<PostView> {
  const response = await inject({
    method: "POST",
    url: "/api/feed/board-posts",
    payload: {
      audienceId: allAudienceId,
      title: `Vattnet stängs av ${suffix}`,
      body: "Tisdag 9-12.",
      namesAuthor: false,
      ...overrides,
    },
    as: seated,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PostView>();
}

function reasonOf(response: { json: <T>() => T }): string {
  return response.json<{ reason: string }>().reason;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      {
        id: seated.personId,
        firstName: "Astrid",
        lastName: `Tillägg${suffix}`,
      },
      { id: karin.personId, firstName: "Karin", lastName: `Tillägg${suffix}` },
      { id: nils.personId, firstName: "Nils", lastName: `Tillägg${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Tillägg${suffix}`,
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: seated.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  const address = await prisma.address.create({
    data: {
      street: `Tilläggsgatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Stockholm",
    },
  });
  addressId = address.id;
  const apartment = await prisma.apartment.create({
    data: { addressId, number: `40${suffix.slice(-2)}` },
  });
  apartmentId = apartment.id;
  for (const who of [seated, karin, nils]) {
    await prisma.residency.create({
      data: {
        personId: who.personId,
        apartmentId,
        role: who === karin ? "MEMBER" : "RESIDENT",
        movedInOn: new Date("2026-01-01"),
      },
    });
  }

  const type = await prisma.issueType.create({
    data: { name: `Hissen ${suffix}`, audience: "MEMBER" },
  });
  issueTypeId = type.id;

  const auth = app.get(AuthService);
  for (const who of people) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
    cookies.set(who.email, await signIn(who.email));
  }

  const response = await inject({
    method: "GET",
    url: "/api/feed/audiences",
    as: seated,
  });
  const list = response.json<AudienceListView>();
  allAudienceId = list.audiences.find((each) => each.kind === "ALL")?.id ?? "";
  boardAudienceId =
    list.audiences.find((each) => each.kind === "BOARD")?.id ?? "";
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.issue.deleteMany({
      where: { reporterPersonId: { in: personIds } },
    });
    await prisma.issueType.deleteMany({ where: { id: issueTypeId } });
    // Comments first: a comment's key to its post refuses a cascade.
    await prisma.postComment.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.news.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.post.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.audienceRead.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
  }
  await app?.close();
});

describe("editing a post with its history", () => {
  it("keeps what the post said, for its author and the board alone", async () => {
    const post = await postBy(karin, "Städdag på lördag.");
    expect(post.mayEdit).toBe(true);

    const edited = await inject({
      method: "PATCH",
      url: `/api/feed/posts/${post.id}`,
      payload: { body: "Städdag på söndag." },
      as: karin,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const view = edited.json<PostView>();
    expect(view.body).toBe("Städdag på söndag.");
    expect(view.editedAt).not.toBeNull();
    expect(view.mayReadHistory).toBe(true);

    for (const who of [karin, seated]) {
      const history = await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}/revisions`,
        as: who,
      });
      expect(history.statusCode, history.body).toBe(200);
      expect(
        history.json<RevisionListView>().revisions.map((each) => each.body),
      ).toEqual(["Städdag på lördag."]);
    }

    const neighbour = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/revisions`,
      as: nils,
    });
    expect(neighbour.statusCode).toBe(422);
    expect(reasonOf(neighbour)).toBe("history-withheld");

    // Outside Alla, the post is answered as one that does not exist.
    const outsider = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/revisions`,
      as: administrator,
    });
    expect(outsider.statusCode).toBe(404);
    expect(reasonOf(outsider)).toBe("post-not-found");

    // The house reads what stands, and that it was edited.
    const read = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}`,
      as: nils,
    });
    const asNeighbour = read.json<PostView>();
    expect(asNeighbour.body).toBe("Städdag på söndag.");
    expect(asNeighbour.editedAt).not.toBeNull();
    expect(asNeighbour.mayReadHistory).toBe(false);
    expect(asNeighbour.mayEdit).toBe(false);
  });

  it("refuses the history of an erased post", async () => {
    const post = await postBy(karin, "Brevlådan är trasig.");
    try {
      await prisma.post.update({
        where: { id: post.id },
        // As the purge leaves it: nothing of who wrote it or what it said.
        data: { erasedAt: new Date(), authorPersonId: null, body: null },
      });

      const response = await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}/revisions`,
        as: nils,
      });
      expect(response.statusCode).toBe(422);
      expect(reasonOf(response)).toBe("post-erased");
    } finally {
      // The post no longer has an author, so the suite's cleanup by author
      // would leave it behind.
      await prisma.post.deleteMany({ where: { id: post.id } });
    }
  });

  it("is refused to anybody but the author, and keeps nothing for them", async () => {
    const post = await postBy(karin, "Cyklar i källaren.");

    const response = await inject({
      method: "PATCH",
      url: `/api/feed/posts/${post.id}`,
      payload: { body: "Något annat." },
      as: nils,
    });
    expect(response.statusCode).toBe(422);
    expect(reasonOf(response)).toBe("not-editable");
    expect(
      await prisma.postRevision.count({ where: { postId: post.id } }),
    ).toBe(0);
  });

  it("refuses anything but the text", async () => {
    const post = await postBy(karin, "Plommon vid grinden.");

    const response = await inject({
      method: "PATCH",
      url: `/api/feed/posts/${post.id}`,
      payload: { body: "Päron.", audienceId: boardAudienceId },
      as: karin,
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps a comment's history on the same terms", async () => {
    const post = await postBy(karin, "Vem tar med kaffe?");
    const written = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/comments`,
      payload: { body: "Jag tar med kaffe." },
      as: nils,
    });
    expect(written.statusCode, written.body).toBe(201);
    const comment = written.json<PostCommentView>();
    expect(comment.mayEdit).toBe(true);

    const edited = await inject({
      method: "PATCH",
      url: `/api/feed/comments/${comment.id}`,
      payload: { body: "Jag tar med te." },
      as: nils,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<PostCommentView>().editedAt).not.toBeNull();

    const byBoard = await inject({
      method: "GET",
      url: `/api/feed/comments/${comment.id}/revisions`,
      as: seated,
    });
    expect(byBoard.statusCode, byBoard.body).toBe(200);
    expect(
      byBoard.json<RevisionListView>().revisions.map((each) => each.body),
    ).toEqual(["Jag tar med kaffe."]);

    const byPostAuthor = await inject({
      method: "GET",
      url: `/api/feed/comments/${comment.id}/revisions`,
      as: karin,
    });
    expect(byPostAuthor.statusCode).toBe(422);
    expect(reasonOf(byPostAuthor)).toBe("history-withheld");

    const byOther = await inject({
      method: "PATCH",
      url: `/api/feed/comments/${comment.id}`,
      payload: { body: "Inget kaffe." },
      as: karin,
    });
    expect(byOther.statusCode).toBe(422);
    expect(reasonOf(byOther)).toBe("not-editable");
  });
});

describe("who has not opened an important post", () => {
  it("names them to the board, leaving out its author and whoever has", async () => {
    const post = await boardPost({ important: true });
    expect(post.mayListNotRead).toBe(true);

    const opened = await inject({
      method: "POST",
      url: `/api/feed/posts/${post.id}/read`,
      as: karin,
    });
    expect(opened.statusCode, opened.body).toBe(200);

    const response = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/not-read`,
      as: seated,
    });
    expect(response.statusCode, response.body).toBe(200);
    const named = response
      .json<NotReadView>()
      .people.flatMap((each) =>
        each.kind === "unknown" ? [] : [each.personId],
      );
    expect(named).toContain(nils.personId);
    expect(named).not.toContain(karin.personId);
    expect(named).not.toContain(seated.personId);
    // The administrator is not in Alla, and is nobody the house is told about.
    expect(named).not.toContain(administrator.personId);
  });

  it("leaves out somebody whose processing is restricted", async () => {
    const post = await boardPost({ important: true });
    await prisma.person.update({
      where: { id: nils.personId },
      data: { processingRestrictedAt: new Date() },
    });
    try {
      const response = await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}/not-read`,
        as: seated,
      });
      expect(response.statusCode, response.body).toBe(200);
      const named = response
        .json<NotReadView>()
        .people.flatMap((each) =>
          each.kind === "unknown" ? [] : [each.personId],
        );
      expect(named).not.toContain(nils.personId);
    } finally {
      await prisma.person.update({
        where: { id: nils.personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("is refused to everybody but the board", async () => {
    const post = await boardPost({ important: true });

    const response = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/not-read`,
      as: karin,
    });
    expect(response.statusCode).toBe(422);
    expect(reasonOf(response)).toBe("not-board");
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/feed/posts/${post.id}`,
          as: karin,
        })
      ).json<PostView>().mayListNotRead,
    ).toBe(false);
  });

  it("is refused on a post nobody marked important", async () => {
    const post = await postBy(karin, "Hissen går igen.");

    const response = await inject({
      method: "GET",
      url: `/api/feed/posts/${post.id}/not-read`,
      as: seated,
    });
    expect(response.statusCode).toBe(422);
    expect(reasonOf(response)).toBe("not-important");
  });
});

describe("an issue report made from a post", () => {
  function report(who: { email: string }, postId: string) {
    return inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        typeId: issueTypeId,
        description: "Hissen står still på plan 3.",
        postId,
      },
      as: who,
    });
  }

  it("links the report to the post its author made it from, once", async () => {
    const post = await postBy(karin, "Hissen står still igen.");
    expect(post.mayReportIssue).toBe(true);

    const filed = await report(karin, post.id);
    expect(filed.statusCode, filed.body).toBe(201);
    const { id } = filed.json<{ id: string }>();

    const read = (
      await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}`,
        as: karin,
      })
    ).json<PostView>();
    expect(read.issue).toEqual({ id, status: "NEW" });
    expect(read.mayReportIssue).toBe(false);

    // The board handles issues, and is shown where the report stands.
    const board = (
      await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}`,
        as: seated,
      })
    ).json<PostView>();
    expect(board.issue).toEqual({ id, status: "NEW" });

    // A neighbour reads the post and not the queue.
    const neighbour = (
      await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}`,
        as: nils,
      })
    ).json<PostView>();
    expect(neighbour.issue).toBeNull();

    const second = await report(seated, post.id);
    expect(second.statusCode).toBe(409);
    expect(reasonOf(second)).toBe("post-already-reported");
    // The second report went back with its transaction.
    expect(
      await prisma.issue.count({
        where: { reporterPersonId: seated.personId },
      }),
    ).toBe(0);
  });

  it("lets the board make one from somebody else's post, and shows the author nothing of it", async () => {
    const post = await postBy(karin, "Dörren till cykelrummet går inte i lås.");

    const filed = await report(seated, post.id);
    expect(filed.statusCode, filed.body).toBe(201);

    const asAuthor = (
      await inject({
        method: "GET",
        url: `/api/feed/posts/${post.id}`,
        as: karin,
      })
    ).json<PostView>();
    expect(asAuthor.issue).toBeNull();
    expect(asAuthor.mayReportIssue).toBe(false);
  });

  it("refuses a neighbour, and files nothing", async () => {
    const post = await postBy(karin, "Lampan i trappan är trasig.");
    const before = await prisma.issue.count({
      where: { reporterPersonId: nils.personId },
    });

    const response = await report(nils, post.id);
    expect(response.statusCode).toBe(422);
    expect(reasonOf(response)).toBe("post-not-reportable");
    expect(
      await prisma.issue.count({ where: { reporterPersonId: nils.personId } }),
    ).toBe(before);
  });

  it("answers a post nobody can read as one that does not exist", async () => {
    const response = await report(karin, `no-such-post-${suffix}`);
    expect(response.statusCode).toBe(404);
    expect(reasonOf(response)).toBe("post-not-found");
  });
});

describe("withdrawing a scheduled post", () => {
  function scheduledToBoard(): Promise<PostView> {
    return boardPost({
      audienceId: boardAudienceId,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  it("withdraws one confined to Styrelsen, item and post together", async () => {
    const post = await scheduledToBoard();
    const newsId = post.news?.id ?? "";

    const byResident = await inject({
      method: "DELETE",
      url: `/api/feed/board-posts/${post.id}`,
      as: karin,
    });
    expect(byResident.statusCode).toBe(422);
    expect(reasonOf(byResident)).toBe("not-board");

    const response = await inject({
      method: "DELETE",
      url: `/api/feed/board-posts/${post.id}`,
      as: seated,
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(await prisma.news.count({ where: { id: newsId } })).toBe(0);
    expect(await prisma.post.count({ where: { id: post.id } })).toBe(0);

    const again = await inject({
      method: "DELETE",
      url: `/api/feed/board-posts/${post.id}`,
      as: seated,
    });
    expect(again.statusCode).toBe(404);
  });

  it("refuses once the post has been published", async () => {
    const post = await scheduledToBoard();
    const newsId = post.news?.id ?? "";
    await app.get(NewsWriteService).publishScheduled({
      newsId,
      personId: seated.personId,
      sendEmail: false,
    });

    const response = await inject({
      method: "DELETE",
      url: `/api/feed/board-posts/${post.id}`,
      as: seated,
    });
    expect(response.statusCode).toBe(422);
    expect(reasonOf(response)).toBe("not-scheduled");
    expect(await prisma.news.count({ where: { id: newsId } })).toBe(1);
  });
});

describe("the read marker on the list of audiences", () => {
  it("says how far the reader has read, and nothing before they have", async () => {
    const before = (
      await inject({ method: "GET", url: "/api/feed/audiences", as: nils })
    ).json<AudienceListView>();
    const all = before.audiences.find((each) => each.id === allAudienceId);
    expect(all?.readAt ?? null).toBeNull();

    const readAt = new Date(Date.now() - 60 * 1000).toISOString();
    const marked = await inject({
      method: "POST",
      url: `/api/feed/audiences/${allAudienceId}/read`,
      payload: { readAt },
      as: nils,
    });
    expect(marked.statusCode, marked.body).toBe(200);

    const after = (
      await inject({ method: "GET", url: "/api/feed/audiences", as: nils })
    ).json<AudienceListView>();
    expect(
      after.audiences.find((each) => each.id === allAudienceId)?.readAt,
    ).toBe(readAt);
  });
});
