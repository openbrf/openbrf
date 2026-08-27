/**
 * The Brf Eksemplet demo association.
 *
 * These values are not arbitrary: they mirror the pinned Adressbok design
 * canvas (two addresses, 42 apartments, 67 persons, and the named residents
 * shown on the board). Keeping them in step means the seeded instance can be
 * compared against the design directly, and the e2e suite has the same fixture
 * the exit criteria describe.
 */

export interface DemoBuilding {
  street: string;
  number: string;
  postalCode: string;
  city: string;
  sortOrder: number;
  /** Apartments per floor, index 0 being the ground floor (entreplan). */
  apartmentsPerFloor: readonly number[];
}

export const DEMO_ASSOCIATION = {
  name: "Brf Eksemplet",
  organizationNumber: "769600-0000",
  city: "Stockholm",
} as const;

/** 28 + 14 = 42 apartments, matching the canvas header. */
export const DEMO_BUILDINGS: readonly DemoBuilding[] = [
  {
    street: "Storgatan",
    number: "12",
    postalCode: "11122",
    city: "Stockholm",
    sortOrder: 0,
    apartmentsPerFloor: [6, 8, 8, 6],
  },
  {
    street: "Storgatan",
    number: "14",
    postalCode: "11122",
    city: "Stockholm",
    sortOrder: 1,
    apartmentsPerFloor: [4, 5, 5],
  },
];

export type DemoRole = "MEMBER" | "RESIDENT";
export type DemoBoardPosition =
  "CHAIR" | "BOARD_MEMBER" | "DEPUTY_BOARD_MEMBER";

export interface DemoPerson {
  /** Stable id so re-seeding updates rather than duplicates. */
  key: string;
  firstName: string;
  lastName: string;
  apartmentNumber: string;
  role: DemoRole;
  movedInOn: string;
  movedOutOn?: string;
  email?: string;
  phone?: string;
  personalIdentityNumber?: string;
  boardPosition?: DemoBoardPosition;
  /** Protected personal data: masked everywhere, every reveal logged. */
  protectedPersonalData?: boolean;
  preferredLocale?: "sv" | "en";
}

/**
 * The residents shown on the canvas, in the same order. Every state the board
 * has to render is represented here on purpose: a trust role, a plain member, a
 * non-member resident, a protected person, and a moved-out row.
 */
export const DEMO_PEOPLE: readonly DemoPerson[] = [
  {
    key: "anna-lindqvist",
    firstName: "Anna",
    lastName: "Lindqvist",
    apartmentNumber: "1001",
    role: "MEMBER",
    movedInOn: "2019-06-01",
    phone: "070-123 45 67",
    email: "anna.lindqvist@exempel.se",
    personalIdentityNumber: "811228-9874",
    boardPosition: "CHAIR",
  },
  {
    key: "erik-sandstrom",
    firstName: "Erik",
    lastName: "Sandström",
    apartmentNumber: "1002",
    role: "MEMBER",
    movedInOn: "2021-04-12",
    email: "erik.sandstrom@exempel.se",
    personalIdentityNumber: "121212-1212",
  },
  {
    key: "johan-berg",
    firstName: "Johan",
    lastName: "Berg",
    apartmentNumber: "1103",
    role: "MEMBER",
    movedInOn: "2022-11-15",
    email: "johan.berg@exempel.se",
  },
  {
    key: "sara-berg",
    firstName: "Sara",
    lastName: "Berg",
    apartmentNumber: "1103",
    role: "RESIDENT",
    movedInOn: "2022-11-15",
    phone: "070-555 12 34",
    email: "sara.berg@exempel.se",
    protectedPersonalData: true,
  },
  {
    key: "maria-holm",
    firstName: "Maria",
    lastName: "Holm",
    apartmentNumber: "1104",
    role: "MEMBER",
    movedInOn: "2026-08-01",
    phone: "073-987 65 43",
  },
  {
    key: "karin-ohman",
    firstName: "Karin",
    lastName: "Öhman",
    apartmentNumber: "1201",
    role: "MEMBER",
    movedInOn: "2015-02-01",
    // Moved out, so the row renders dimmed with a purge date.
    movedOutOn: "2026-08-01",
    email: "karin.ohman@exempel.se",
  },
  {
    key: "ali-hassan",
    firstName: "Ali",
    lastName: "Hassan",
    apartmentNumber: "1202",
    role: "MEMBER",
    movedInOn: "2024-03-01",
    email: "ali.hassan@exempel.se",
  },
  {
    key: "lena-wikstrom",
    firstName: "Lena",
    lastName: "Wikström",
    apartmentNumber: "1203",
    role: "MEMBER",
    movedInOn: "2017-09-01",
    email: "lena.wikstrom@exempel.se",
    boardPosition: "BOARD_MEMBER",
  },
  {
    key: "omar-aziz",
    firstName: "Omar",
    lastName: "Aziz",
    apartmentNumber: "1204",
    role: "RESIDENT",
    movedInOn: "2025-05-01",
    phone: "072-456 78 90",
  },
  {
    key: "gustav-ek",
    firstName: "Gustav",
    lastName: "Ek",
    apartmentNumber: "1301",
    role: "MEMBER",
    movedInOn: "2020-10-01",
    phone: "070-234 56 78",
    preferredLocale: "en",
  },
];

/** Total persons on the canvas; the rest are generated filler. */
export const DEMO_PERSON_COUNT = 67;

/**
 * Name pools for generated residents. Fixed lists rather than randomness so a
 * re-seed produces the same register and tests stay stable.
 */
export const FILLER_FIRST_NAMES = [
  "Astrid",
  "Bengt",
  "Cecilia",
  "David",
  "Elin",
  "Fredrik",
  "Greta",
  "Hassan",
  "Ingrid",
  "Jonas",
  "Karolina",
  "Lars",
  "Malin",
  "Nils",
  "Olga",
  "Per",
  "Quynh",
  "Rebecka",
  "Sven",
  "Tove",
  "Ulf",
  "Vera",
  "Wilhelm",
  "Yasmin",
  "Zara",
  "Ake",
  "Barbro",
  "Curt",
] as const;

export const FILLER_LAST_NAMES = [
  "Andersson",
  "Bergqvist",
  "Carlsson",
  "Dahl",
  "Ekstrom",
  "Forsberg",
  "Gustafsson",
  "Hedlund",
  "Isaksson",
  "Jonsson",
  "Karlsson",
  "Lundgren",
  "Martinsson",
  "Nyberg",
  "Olsson",
  "Palm",
  "Rosen",
  "Sjoberg",
  "Tornqvist",
  "Ullman",
] as const;
