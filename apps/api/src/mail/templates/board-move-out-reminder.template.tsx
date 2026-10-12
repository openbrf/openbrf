import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface BoardMoveOutReminderMailProps {
  /** Board member being notified. */
  recipientName: string;
  /** Person who moved out. */
  personName: string;
  apartmentNumber: string;
  movedOutOn: Date;
  purgeOn: Date;
}

/**
 * Sent to the board on the move-out date so the handover is not forgotten.
 * Scheduled as a job rather than sent inline, because the trigger is a date
 * rather than a request.
 */
export const boardMoveOutReminderMail: MailTemplate<BoardMoveOutReminderMailProps> =
  {
    id: "board-move-out-reminder",
    // A resident's move-out, which the address book records.
    processing: "addressBookAndAccounts",

    subject: (props, { t }) =>
      t("email.boardMoveOutReminder.subject", {
        apartment: props.apartmentNumber,
      }),

    body: (props, context): ReactElement => {
      const { t, formatDateColumn, appUrl } = context;

      return (
        <MailLayout
          context={context}
          preview={t("email.boardMoveOutReminder.subject", {
            apartment: props.apartmentNumber,
          })}
          heading={t("email.boardMoveOutReminder.heading")}
          recipientName={props.recipientName}
        >
          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "15px",
              lineHeight: 1.55,
              margin: "0 0 8px 0",
            }}
          >
            {t("email.boardMoveOutReminder.body", {
              name: props.personName,
              apartment: props.apartmentNumber,
              movedOutOn: formatDateColumn(props.movedOutOn),
              purgeOn: formatDateColumn(props.purgeOn),
            })}
          </Text>

          <MailAction
            context={context}
            href={applicationUrl(appUrl)}
            label={t("email.boardMoveOutReminder.action")}
          />
        </MailLayout>
      );
    },
  };
