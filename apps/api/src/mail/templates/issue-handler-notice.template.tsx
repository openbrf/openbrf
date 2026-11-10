import type { IssuePriority } from "@openbrf/shared";
import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

/**
 * What happened to an issue that a handler is told of.
 *
 * - `assigned`: the issue was given to the recipient, by a handler or by its
 *   type's default when it was filed.
 * - `filed`: a new issue nobody is assigned, told to its type's handlers.
 * - `urgent`: an issue filed as Akut, or raised to it, told to every handler of
 *   its type (decision 12 of the issue module plan).
 * - `overdue`: the recipient's issue is past its target date and not closed.
 * - `reopened`: a closed issue was opened again.
 * - `message`: the reporter wrote a new issue message.
 * - `contractor`: the contractor of a work order on the issue answered it,
 *   wrote a note or added a photograph through its link (ADR 0055).
 */
export type IssueHandlerNoticeEvent =
  | "assigned"
  | "filed"
  | "urgent"
  | "overdue"
  | "reopened"
  | "message"
  | "contractor";

export interface IssueHandlerNoticeMailProps {
  /** The handler being told, by their own name. */
  recipientName: string;
  event: IssueHandlerNoticeEvent;
  /** The issue number (ärendenummer). */
  number: number;
  /** The type's name, as the board wrote it. */
  typeName: string;
  priority: IssuePriority;
  /** The target date, for `overdue`; a `@db.Date` column. */
  targetDate: Date | null;
}

/**
 * Tells a handler something happened to an issue: the issue number, its type,
 * its priority and a link to the queue, and nothing else (decision 21 of the
 * issue module plan).
 *
 * Nobody's words are in it. The description, the location, the reporter, an
 * issue message and an internal note stay in the instance, where the purge
 * removes the free text on its own clock; a copy in a mailbox would outlive
 * that clock for good and would have passed through the mail provider on the
 * way. The props carry none of it, so no later change to the body can print
 * it. The type's name is the board's own label, and is what tells the reader
 * whether to open the queue now.
 */
export const issueHandlerNoticeMail: MailTemplate<IssueHandlerNoticeMailProps> =
  {
    id: "issue-handler-notice",
    processing: "issues",

    subject: (props, { t }) =>
      t(`email.issueHandlerNotice.${props.event}.subject`, {
        number: props.number,
        type: props.typeName,
      }),

    body: (props, context): ReactElement => {
      const { t, appUrl, formatDateColumn } = context;
      const values = {
        number: props.number,
        type: props.typeName,
        priority: t(`issues.priority.${props.priority}`),
        targetDate:
          props.targetDate === null ? "" : formatDateColumn(props.targetDate),
      };

      return (
        <MailLayout
          context={context}
          preview={t(`email.issueHandlerNotice.${props.event}.subject`, values)}
          heading={t(`email.issueHandlerNotice.${props.event}.heading`, values)}
          recipientName={props.recipientName}
          footerNotice={t("email.issueHandlerNotice.footerNotice", {
            association: context.brand.associationName,
          })}
        >
          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "15px",
              lineHeight: 1.55,
              margin: "0 0 8px 0",
            }}
          >
            {t(`email.issueHandlerNotice.${props.event}.body`, values)}
          </Text>
          <Text
            style={{
              color: MAIL_COLORS.inkMuted,
              fontSize: "14px",
              lineHeight: 1.55,
              margin: "0 0 16px 0",
            }}
          >
            {t("email.issueHandlerNotice.facts", values)}
          </Text>

          <MailAction
            context={context}
            href={`${applicationUrl(appUrl)}/board/issues`}
            label={t("email.issueHandlerNotice.action")}
          />
        </MailLayout>
      );
    },
  };
