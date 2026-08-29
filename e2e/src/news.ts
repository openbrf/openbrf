import type { APIRequestContext } from "@playwright/test";

import { stack } from "./stack";

/**
 * The association's news, over HTTP.
 *
 * The board's own screen creates and publishes news, and the spec drives that
 * screen where the screen is what is under test. These calls exist for the
 * other half of it: what the mailing does is a property of the instance rather
 * than of a form, and asserting on it takes several publishes, an edit and a
 * republish - which through the interface would be a spec about clicking rather
 * than about the one guarantee this module makes.
 */

export type NewsRow = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly published: boolean;
  readonly visibility: "PUBLIC" | "MEMBER";
  readonly emailQueuedAt: string | null;
  readonly delivery: {
    readonly pending: number;
    readonly sent: number;
    readonly failed: number;
    readonly mailNotConfigured: boolean;
  };
};

export type PublishedNewsRow = NewsRow & {
  readonly mailedTo: number | null;
};

async function expectOk(
  response: {
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  },
  what: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${what} answered ${String(response.status())}: ${await response.text()}`,
    );
  }
}

/** A body of plain paragraphs, in the block shape the API stores. */
export function newsBody(paragraphs: readonly string[]): {
  blocks: { type: "paragraph"; runs: { text: string }[] }[];
} {
  return {
    blocks: paragraphs.map((text) => ({
      type: "paragraph" as const,
      runs: [{ text }],
    })),
  };
}

export async function listNews(
  request: APIRequestContext,
): Promise<readonly NewsRow[]> {
  const response = await request.get(`${stack.baseUrl}/api/news`);
  await expectOk(response, "GET /api/news");
  return (await response.json()) as readonly NewsRow[];
}

export async function createNews(
  request: APIRequestContext,
  input: { slug: string; title: string; paragraphs: readonly string[] },
): Promise<NewsRow> {
  const response = await request.post(`${stack.baseUrl}/api/news`, {
    data: {
      slug: input.slug,
      title: input.title,
      content: newsBody(input.paragraphs),
    },
  });
  await expectOk(response, "POST /api/news");
  return (await response.json()) as NewsRow;
}

export async function editNews(
  request: APIRequestContext,
  id: string,
  input: { slug: string; title: string; paragraphs: readonly string[] },
): Promise<NewsRow> {
  const response = await request.put(`${stack.baseUrl}/api/news/${id}`, {
    data: {
      slug: input.slug,
      title: input.title,
      content: newsBody(input.paragraphs),
    },
  });
  await expectOk(response, `PUT /api/news/${id}`);
  return (await response.json()) as NewsRow;
}

export async function publishNews(
  request: APIRequestContext,
  id: string,
  input: {
    published: boolean;
    visibility?: "PUBLIC" | "MEMBER";
    sendEmail?: boolean;
  },
): Promise<PublishedNewsRow> {
  const response = await request.post(
    `${stack.baseUrl}/api/news/${id}/publish`,
    { data: input },
  );
  await expectOk(response, `POST /api/news/${id}/publish`);
  return (await response.json()) as PublishedNewsRow;
}

/** The language a person is written to in. Their own decision, so their call. */
export async function setPreferredLocale(
  request: APIRequestContext,
  preferredLocale: "sv" | "en",
): Promise<void> {
  const response = await request.put(`${stack.baseUrl}/api/settings/profile`, {
    data: { preferredLocale },
  });
  await expectOk(response, "PUT /api/settings/profile");
}
