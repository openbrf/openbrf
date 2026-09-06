import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface BoardMailboxReplyMailProps {
  /** What the correspondent called themselves, when the envelope said. */
  recipientName: string | null;
  /** The subject of the thread being answered, as it was received. */
  subject: string;
  /** What the board wrote. */
  body: string;
  /** The address the board publishes, which answers to this come back to. */
  boardAddress: string;
}

/**
 * The board's answer to somebody who wrote to its shared mailbox.
 *
 * The one message this instance sends to a recipient it holds no record of, and
 * the template is shaped by that. It carries no link into the application,
 * because the person reading it has no account and an invitation they did not
 * ask for is not an answer to their question. It greets them by whatever name
 * their own envelope carried, or not at all, because that is the only name the
 * association has - and it is a string the sender chose rather than an identity,
 * which is why nothing here treats it as one.
 *
 * The subject keeps the thread's own, prefixed the way a mail client prefixes a
 * reply, so the answer arrives in the conversation the question was asked in.
 * The prefix is translated with the rest of the message: an answer written in
 * Swedish that said "Re:" would be the one English word in it.
 *
 * What makes the reply answerable is set on the envelope rather than written
 * here: Reply-To carries the board's published address, so pressing reply writes
 * to the shared mailbox and lands back on this thread. The address is stated in
 * the closing line as well, for a client that hides the header and for a person
 * who wants to write again next month.
 */
export const boardMailboxReplyMail: MailTemplate<BoardMailboxReplyMailProps> = {
  id: "board-mailbox-reply",

  subject: (props, { t }) =>
    t("email.boardMailboxReply.subject", { subject: props.subject }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.boardMailboxReply.subject", {
          subject: props.subject,
        })}
        heading={t("email.boardMailboxReply.heading", {
          association: brand.associationName,
        })}
        recipientName={props.recipientName ?? undefined}
      >
        {/*
         * The board's answer as it was written, with its own line breaks kept: a
         * paragraph break is part of what somebody wrote. react-email escapes
         * the value like any other child, so nothing in it can become markup -
         * which matters more here than anywhere else in this folder, because a
         * board member composing a reply is quoting a letter from outside the
         * association.
         */}
        <Text
          style={{
            color: MAIL_COLORS.ink,
            fontSize: "15px",
            lineHeight: 1.55,
            margin: "0 0 16px 0",
            whiteSpace: "pre-wrap",
          }}
        >
          {props.body}
        </Text>

        <Text
          style={{
            color: MAIL_COLORS.inkMuted,
            fontSize: "13px",
            lineHeight: 1.55,
            margin: "0",
          }}
        >
          {t("email.boardMailboxReply.footer", {
            association: brand.associationName,
            address: props.boardAddress,
          })}
        </Text>
      </MailLayout>
    );
  },
};
