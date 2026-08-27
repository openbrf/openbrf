import { Text } from "@react-email/components";
import type { ReactElement } from "react";

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

    subject: (props, { t }) =>
      t("email.boardMoveOutReminder.subject", {
        apartment: props.apartmentNumber,
      }),

    body: (props, context): ReactElement => {
      const { t, formatDate, appUrl } = context;

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
              movedOutOn: formatDate(props.movedOutOn),
              purgeOn: formatDate(props.purgeOn),
            })}
          </Text>

          <MailAction
            context={context}
            href={`${appUrl}/address-book`}
            label={t("email.boardMoveOutReminder.action")}
          />
        </MailLayout>
      );
    },
  };
