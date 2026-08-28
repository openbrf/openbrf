import { stack } from "./stack";

/**
 * Reads the mail the instance actually sent.
 *
 * Invitations, activation links and sign-in links only exist as email, so the
 * criteria that involve them cannot be checked any other way. Mailpit stands in
 * for the association's SMTP server; the application is configured to use it
 * through the ordinary email settings, so the path under test is the real one.
 */

export type Message = {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Created: string;
};

type MessageList = { readonly messages: readonly Message[] };

const POLL_INTERVAL_MS = 500;

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${stack.mailpitUrl}${path}`);
  if (!response.ok) {
    throw new Error(`mailpit ${path} answered ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

/** Removes every message, so one spec never reads another's mail. */
export async function clearMailbox(): Promise<void> {
  const response = await fetch(`${stack.mailpitUrl}/api/v1/messages`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(
      `mailpit refused to clear the mailbox: ${String(response.status)}`,
    );
  }
}

export async function listMessages(): Promise<readonly Message[]> {
  const list = await readJson<MessageList>("/api/v1/messages?limit=200");
  return list.messages;
}

/** The plain-text part, which carries every link the HTML part carries. */
export async function messageText(id: string): Promise<string> {
  const response = await fetch(`${stack.mailpitUrl}/api/v1/message/${id}`);
  if (!response.ok) {
    throw new Error(
      `mailpit message ${id} answered ${String(response.status)}`,
    );
  }
  const message = (await response.json()) as { readonly Text: string };
  return message.Text;
}

/**
 * Waits for one message to a given address, newest first.
 *
 * Mail is sent from a request handler, so it can land a moment after the HTTP
 * response the test was waiting on; polling is the honest way to express that.
 */
export async function waitForMessage(
  recipient: string,
  options: { readonly timeoutMs?: number; readonly subjectMatch?: RegExp } = {},
): Promise<{ readonly message: Message; readonly text: string }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  const wanted = recipient.toLowerCase();

  for (;;) {
    const messages = await listMessages();
    const match = messages.find(
      (message) =>
        message.To.some((to) => to.Address.toLowerCase() === wanted) &&
        (options.subjectMatch === undefined ||
          options.subjectMatch.test(message.Subject)),
    );
    if (match !== undefined) {
      return { message: match, text: await messageText(match.ID) };
    }
    if (Date.now() > deadline) {
      const seen = messages
        .map(
          (message) =>
            `${message.To.map((to) => to.Address).join(", ")}: ${message.Subject}`,
        )
        .join("; ");
      throw new Error(
        `no message for ${recipient} within ${String(timeoutMs)} ms. Mailbox held: ${seen || "nothing"}`,
      );
    }
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
}

/** Asserts that nothing arrives for an address; used for the refusal paths. */
export async function expectNoMessage(
  recipient: string,
  windowMs = 4000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  const wanted = recipient.toLowerCase();
  for (;;) {
    const messages = await listMessages();
    const match = messages.find((message) =>
      message.To.some((to) => to.Address.toLowerCase() === wanted),
    );
    if (match !== undefined) {
      throw new Error(
        `expected no mail for ${recipient}, but "${match.Subject}" arrived`,
      );
    }
    if (Date.now() > deadline) {
      return;
    }
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
}

/** Pulls the one absolute URL out of an email body that matches a path. */
export function linkFrom(text: string, path: string): string {
  const pattern = new RegExp(
    `https?://[^\\s"'<>\\]]*${path.replaceAll("/", "\\/")}[^\\s"'<>\\]]*`,
  );
  const found = pattern.exec(text);
  if (found === null) {
    throw new Error(`no ${path} link in the message body:\n${text}`);
  }
  return found[0];
}
