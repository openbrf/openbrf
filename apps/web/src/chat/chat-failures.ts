import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every reason the chat endpoints answer with.
 *
 * Mirrored from the API's own union rather than imported, like every wire shape
 * in this client, and written out so the map below can be total: a reason added
 * to the API and to this union without a sentence beside it fails the build
 * rather than reaching a board member as a code.
 *
 * `chat-not-found` is deliberately vaguer than what happened, and the screen
 * must not undo that in the wording. It answers a room that does not exist and a
 * room this person is not in, as one answer - anybody who could tell those apart
 * could walk the identifiers and learn what rooms the association has.
 */
type ChatReason =
  "chat-not-found" | "personal-identity-number" | "too-many-messages";

/**
 * Every refusal this screen can meet, in one sentence each.
 *
 * The API answers with a code rather than prose, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * the screen's decision.
 *
 * `invalid-body` is not one of the module's own reasons - it is the endpoint's
 * schema refusing a body this form should not have been able to send, an empty
 * message or one past the cap - so it sits beside the union rather than inside
 * it, and the type keeps the totality where totality is worth having.
 *
 * A 403 is answered before this map is consulted at all, by the shared branch in
 * {@link failureMessageKey}. That is the resident who holds no seat and no
 * capability, and the sentence it reaches is the general one about an account
 * not being allowed a screen. The board member holding the capability and no
 * seat is a different case entirely and is not a refusal: they are answered with
 * no rooms, and the screen says why.
 */
const CHAT_FAILURES = {
  "chat-not-found": "chat.errors.chatNotFound",
  "personal-identity-number": "chat.errors.personalIdentityNumber",
  "too-many-messages": "chat.errors.tooManyMessages",
  "invalid-body": "chat.errors.invalidBody",
} as const satisfies Record<ChatReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from a chat endpoint.
 *
 * The refusal for a personal identity number carries positions - a field name
 * and a character offset - and none of them is rendered. A message has one
 * field, so naming it says nothing the sentence has not, and an offset into a
 * textarea is not something a person can act on. What is never rendered is the
 * value: the response does not carry it, and a screen the whole board is looking
 * at is exactly where it must not appear.
 */
export function chatFailureKey(failure: ApiFailure): TranslationKey {
  return failureMessageKey(failure, CHAT_FAILURES, "chat.errors.unknown");
}
