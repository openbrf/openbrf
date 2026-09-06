import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface BreachReminderMailProps {
  /** Board member being reminded. */
  recipientName: string;
  breachTitle: string;
  /** When the association became aware; the 72 hours run from here. */
  discoveredAt: Date;
  /** The bound art. 33(1) sets on that discovery. */
  notifyBy: Date;
}

/**
 * Sent to the board a day before the 72 hours of GDPR art. 33(1) run out on a
 * recorded breach that nobody has decided about.
 *
 * Scheduled as a job rather than sent inline, because the trigger is a date
 * rather than a request - the same shape as the board's move-out reminder.
 *
 * The title travels and nothing else does. What the breach touched, whose data
 * it was and how many people it reached are on the record behind the link, and
 * a mailbox is not where any of that belongs: this message exists to get
 * somebody to open the register, not to be the register.
 */
export const breachReminderMail: MailTemplate<BreachReminderMailProps> = {
  id: "personal-data-breach-reminder",

  subject: (props, { t }) =>
    t("email.breachReminder.subject", { title: props.breachTitle }),

  body: (props, context): ReactElement => {
    const { t, formatDate, formatTime, appUrl } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.breachReminder.subject", {
          title: props.breachTitle,
        })}
        heading={t("email.breachReminder.heading")}
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
          {t("email.breachReminder.body", {
            title: props.breachTitle,
            discoveredAt: formatDate(props.discoveredAt),
            notifyBy: `${formatDate(props.notifyBy)} ${formatTime(props.notifyBy)}`,
          })}
        </Text>

        <MailAction
          context={context}
          href={`${applicationUrl(appUrl)}/data-protection`}
          label={t("email.breachReminder.action")}
        />
      </MailLayout>
    );
  },
};
