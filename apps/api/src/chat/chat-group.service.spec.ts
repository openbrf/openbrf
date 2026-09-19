import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { ChatGroupService } from "./chat-group.service";

/**
 * The rules a group lives under, decided before any row is written.
 *
 * **Whoever wants a group makes one, and living here is the whole condition.**
 * No capability decides it beyond the one that opens the endpoints and no board
 * member approves it - so the refusal for somebody who does not live here is
 * asserted, and so is the absence of any other gate.
 *
 * **Nobody administers a group.** Anybody in it may put somebody in, and each
 * may take only themselves out. There is no method that takes another person out
 * and the shape of this service is what says so; what is asserted here is the
 * half that could go wrong quietly - that somebody outside the room can do
 * neither.
 *
 * **A place in a group ends the day the residency does.** The membership row
 * stays and answers nothing, which is what lets the words somebody wrote stay in
 * the room attributed exactly as before.
 *
 * **Every act that changes who can read the room is audited, and nothing else
 * is.** Making one, putting somebody in, somebody going out. A second press is
 * not a second act: an add that changes nothing writes no entry, and neither
 * does a leave that removes no row.
 *
 * **One refusal for two cases.** A room this person is not in and a room that
 * does not exist answer identically, and so does the board chat - nobody is put
 * into that one or taken out of it, an election is.
 *
 * What the database does with these rows is `chat-group.int-spec.ts`.
 */

const GROUP_ID = "chat-garden";
const BOARD_ID = "chat-board";

interface PersonFixture {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  /** Null while they live here, undefined for somebody who never has. */
  movedOutOn?: Date | null;
  apartment?: string;
}

interface ChatFixture {
  id: string;
  kind: "BOARD" | "GROUP";
  name: string | null;
  createdByPersonId: string | null;
}

const NILS: PersonFixture = {
  id: "person-nils",
  firstName: "Nils",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  movedOutOn: null,
  apartment: "1001",
};

const ASTRID: PersonFixture = {
  id: "person-astrid",
  firstName: "Astrid",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  movedOutOn: null,
  apartment: "1001",
};

/** Holds a seat, lives nowhere: an external board member. */
const EXTERNAL: PersonFixture = {
  id: "person-bo",
  firstName: "Bo",
  lastName: "Ek",
  protectedPersonalData: false,
};

const PROTECTED: PersonFixture = {
  id: "person-elin",
  firstName: "Elin",
  lastName: "Rydberg",
  protectedPersonalData: true,
  movedOutOn: null,
  apartment: "1102",
};

const GARDEN: ChatFixture = {
  id: GROUP_ID,
  kind: "GROUP",
  name: "Trädgårdsgruppen",
  createdByPersonId: NILS.id,
};

const BOARD: ChatFixture = {
  id: BOARD_ID,
  kind: "BOARD",
  name: null,
  createdByPersonId: null,
};

function principal(personId: string): Principal {
  return {
    personId,
    capabilities: new Set<Capability>(["chat:participate"]),
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

interface MemberFixture {
  chatId: string;
  personId: string;
  addedByPersonId: string;
  joinedAt: Date;
}

/**
 * A database holding these rooms, memberships and people.
 *
 * Every query is implemented rather than stubbed with an answer, because what is
 * under test is what the service asks of it: a residency lookup that answered
 * regardless of its `where` would let a service that never checks a residency
 * pass every assertion below.
 */
function build(options: {
  chats?: ChatFixture[];
  persons?: PersonFixture[];
  members?: { chatId: string; personId: string; addedByPersonId?: string }[];
}) {
  const chats = [...(options.chats ?? [])];
  const persons = options.persons ?? [];
  const members: MemberFixture[] = (options.members ?? []).map(
    (member, index) => ({
      chatId: member.chatId,
      personId: member.personId,
      addedByPersonId: member.addedByPersonId ?? member.personId,
      joinedAt: new Date(Date.UTC(2026, 0, 1, index)),
    }),
  );

  const livesHere = (personId: string, now: Date): boolean => {
    const person = persons.find((each) => each.id === personId);
    if (person?.movedOutOn === undefined) {
      return false;
    }
    return (
      person.movedOutOn === null || person.movedOutOn.getTime() > now.getTime()
    );
  };

  const chatRow = (chat: ChatFixture) => ({
    ...chat,
    members: members
      .filter((member) => member.chatId === chat.id)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()),
  });

  const client = {
    chat: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const chat = chats.find((each) => each.id === args.where.id);
        return chat === undefined ? null : chatRow(chat);
      }),
      create: vi.fn(
        async (args: {
          data: {
            kind: "GROUP";
            name: string;
            createdByPersonId: string;
            members: { create: { personId: string; addedByPersonId: string } };
          };
        }) => {
          const row: ChatFixture = {
            id: `chat-${String(chats.length + 1)}`,
            kind: args.data.kind,
            name: args.data.name,
            createdByPersonId: args.data.createdByPersonId,
          };
          chats.push(row);
          members.push({
            chatId: row.id,
            personId: args.data.members.create.personId,
            addedByPersonId: args.data.members.create.addedByPersonId,
            joinedAt: new Date(),
          });
          return { id: row.id, name: row.name };
        },
      ),
    },
    chatGroupMember: {
      findUnique: vi.fn(
        async (args: {
          where: { chatId_personId: { chatId: string; personId: string } };
        }) =>
          members.find(
            (member) =>
              member.chatId === args.where.chatId_personId.chatId &&
              member.personId === args.where.chatId_personId.personId,
          ) ?? null,
      ),
      findMany: vi.fn(
        async (args: { where: { personId?: string; chatId?: string } }) =>
          members
            .filter(
              (member) =>
                (args.where.personId === undefined ||
                  member.personId === args.where.personId) &&
                (args.where.chatId === undefined ||
                  member.chatId === args.where.chatId),
            )
            .map((member) => ({
              ...member,
              chat: chats.find((chat) => chat.id === member.chatId),
            })),
      ),
      count: vi.fn(
        async (args: { where: { chatId: string } }) =>
          members.filter((member) => member.chatId === args.where.chatId)
            .length,
      ),
      create: vi.fn(
        async (args: {
          data: { chatId: string; personId: string; addedByPersonId: string };
        }) => {
          members.push({ ...args.data, joinedAt: new Date() });
          return args.data;
        },
      ),
      deleteMany: vi.fn(
        async (args: { where: { chatId: string; personId: string } }) => {
          const before = members.length;
          for (let index = members.length - 1; index >= 0; index -= 1) {
            const member = members[index];
            if (
              member !== undefined &&
              member.chatId === args.where.chatId &&
              member.personId === args.where.personId
            ) {
              members.splice(index, 1);
            }
          }
          return { count: before - members.length };
        },
      ),
    },
    residency: {
      findFirst: vi.fn(
        async (args: {
          where: {
            personId: string;
            OR: [unknown, { movedOutOn: { gt: Date } }];
          };
        }) => {
          const [, future] = args.where.OR;
          return livesHere(args.where.personId, future.movedOutOn.gt)
            ? { id: `residency-${args.where.personId}` }
            : null;
        },
      ),
    },
    person: {
      /*
       * The board seat, asked for whenever a room of kind BOARD is reached. No
       * fixture here holds one: this service refuses the board chat as a room
       * that does not exist, and a fake that answered otherwise would let that
       * refusal pass for the wrong reason.
       */
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(
        async (args: {
          where: {
            id?: { in?: string[]; notIn?: string[] };
            protectedPersonalData?: boolean;
            residencies?: {
              some: { OR: [unknown, { movedOutOn: { gt: Date } }] };
            };
            OR?: {
              firstName?: { contains: string };
              lastName?: { contains: string };
            }[];
          };
        }) =>
          persons
            .filter((person) => {
              if (
                args.where.id?.in !== undefined &&
                !args.where.id.in.includes(person.id)
              ) {
                return false;
              }
              if (args.where.id?.notIn?.includes(person.id) === true) {
                return false;
              }
              if (
                args.where.protectedPersonalData === false &&
                person.protectedPersonalData
              ) {
                return false;
              }
              if (args.where.residencies !== undefined) {
                const [, future] = args.where.residencies.some.OR;
                if (!livesHere(person.id, future.movedOutOn.gt)) {
                  return false;
                }
              }
              if (args.where.OR !== undefined) {
                const term = (
                  args.where.OR[0]?.firstName?.contains ?? ""
                ).toLowerCase();
                return `${person.firstName} ${person.lastName}`
                  .toLowerCase()
                  .includes(term);
              }
              return true;
            })
            .map((person) => ({
              ...person,
              residencies:
                person.apartment === undefined
                  ? []
                  : [{ apartment: { number: person.apartment } }],
            })),
      ),
    },
  };

  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };

  return {
    service: new ChatGroupService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    audit,
    chats,
    members,
  };
}

describe("making a group", () => {
  it("is refused to somebody who does not live here", async () => {
    /*
     * The administrator's case and the external board member's. A group is for
     * the people in the building, so holding every capability is not what
     * decides it - and the refusal says which, rather than answering as though
     * the act did not exist.
     */
    const { service, chats } = build({ persons: [EXTERNAL] });

    await expect(
      service.create(principal(EXTERNAL.id), "Uppgång C"),
    ).rejects.toMatchObject({ reason: "not-a-resident" });
    expect(chats).toEqual([]);
  });

  it("puts its maker in it, and records the act against them", async () => {
    const { service, audit, members } = build({ persons: [NILS] });

    const made = await service.create(principal(NILS.id), "Uppgång C");

    expect(made.name).toBe("Uppgång C");
    expect(members).toEqual([
      expect.objectContaining({
        chatId: made.chatId,
        personId: NILS.id,
        // Themselves: nobody else put them in the room they made.
        addedByPersonId: NILS.id,
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHAT_GROUP_CREATED",
        actorPersonId: NILS.id,
        targetPersonId: NILS.id,
        targetId: made.chatId,
      }),
      expect.anything(),
    );
  });

  it("keeps the name out of the audit entry", async () => {
    /*
     * The log is append-only and outside every purge, so a name copied into it
     * would outlive the room the purge erased. Its length is a fact about the
     * act; the words are not.
     */
    const { service, audit } = build({ persons: [NILS] });

    await service.create(principal(NILS.id), "Uppgång C");

    const entry = audit.record.mock.calls.at(0)?.at(0) as unknown as {
      context: Record<string, unknown>;
    };
    expect(JSON.stringify(entry.context)).not.toContain("Uppgång");
    expect(entry.context).toMatchObject({ nameLength: "Uppgång C".length });
  });
});

describe("who may put somebody into a group", () => {
  it("is anybody in it", async () => {
    const { service, audit, members } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    const after = await service.addMember(
      principal(NILS.id),
      GROUP_ID,
      ASTRID.id,
    );

    expect(after).toHaveLength(2);
    expect(members.map((member) => member.personId)).toContain(ASTRID.id);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHAT_GROUP_MEMBER_ADDED",
        actorPersonId: NILS.id,
        // Being able to read a private room is something done to them.
        targetPersonId: ASTRID.id,
      }),
      expect.anything(),
    );
  });

  it("is nobody outside it, answered as a room that does not exist", async () => {
    const { service, members } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    await expect(
      service.addMember(principal(ASTRID.id), GROUP_ID, ASTRID.id),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
    expect(members).toHaveLength(1);
  });

  it("refuses somebody who does not live here", async () => {
    const { service, members } = build({
      chats: [GARDEN],
      persons: [NILS, EXTERNAL],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    await expect(
      service.addMember(principal(NILS.id), GROUP_ID, EXTERNAL.id),
    ).rejects.toMatchObject({ reason: "not-a-resident" });
    expect(members).toHaveLength(1);
  });

  it("writes nothing and records nothing on a second press", async () => {
    const { service, audit, members } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [
        { chatId: GROUP_ID, personId: NILS.id },
        { chatId: GROUP_ID, personId: ASTRID.id },
      ],
    });

    const after = await service.addMember(
      principal(NILS.id),
      GROUP_ID,
      ASTRID.id,
    );

    // Not a second act, and an audit log saying it was would be saying somebody
    // was admitted to a room twice.
    expect(after).toHaveLength(2);
    expect(members).toHaveLength(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses the board chat exactly as a room that does not exist", async () => {
    /*
     * Nobody is put into that room or taken out of it - an election is - so the
     * acts here have no meaning there, and one refusal keeps every answer about
     * a room identical.
     */
    const { service } = build({
      chats: [BOARD],
      persons: [NILS, ASTRID],
    });

    await expect(
      service.addMember(principal(NILS.id), BOARD_ID, ASTRID.id),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
  });
});

describe("leaving a group", () => {
  it("takes the row away and records it against the person who left", async () => {
    const { service, audit, members } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [
        { chatId: GROUP_ID, personId: NILS.id },
        { chatId: GROUP_ID, personId: ASTRID.id },
      ],
    });

    await service.leave(principal(ASTRID.id), GROUP_ID);

    expect(members.map((member) => member.personId)).toEqual([NILS.id]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHAT_GROUP_MEMBER_REMOVED",
        actorPersonId: ASTRID.id,
        targetPersonId: ASTRID.id,
      }),
      expect.anything(),
    );
  });

  it("is refused to somebody who is not in the room", async () => {
    const { service, members } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    await expect(
      service.leave(principal(ASTRID.id), GROUP_ID),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
    expect(members).toHaveLength(1);
  });
});

describe("who the room can still be offered", () => {
  it("leaves out the people already in it and anybody with protected data", async () => {
    /*
     * The resident directory's own rule. A room made by a neighbour is not a
     * place to put somebody whose whereabouts are protected, and the picker not
     * offering them is how that holds without anybody deciding it per room.
     */
    const { service } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID, PROTECTED, EXTERNAL],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    const offered = await service.candidates(
      GROUP_ID,
      principal(NILS.id),
      null,
    );

    expect(offered.map((each) => each.personId)).toEqual([ASTRID.id]);
    // The apartment travels with the name, so two neighbours who share one can
    // be told apart.
    expect(offered[0]?.apartment).toBe("1001");
  });

  it("is refused to somebody who is not in the room", async () => {
    const { service } = build({
      chats: [GARDEN],
      persons: [NILS, ASTRID],
      members: [{ chatId: GROUP_ID, personId: NILS.id }],
    });

    await expect(
      service.candidates(GROUP_ID, principal(ASTRID.id), null),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
  });
});
