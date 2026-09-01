import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { type BookingMailPeriod, bookingPeriodText } from "./booking-period";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface BookingCancellationMailProps extends BookingMailPeriod {
  /** The person whose booking it was. Nobody else is written to. */
  recipientName: string;
  /** The resource as the board named it. Holds no personal data. */
  resourceName: string;
}

/**
 * Notice that somebody else cancelled a booking, sent to whoever made it.
 *
 * Only ever sent when the cancellation was not the recipient's own act - see
 * BookingMailerService, which is where that is decided.
 *
 * It says the association cancelled it and does not name who. "The association"
 * rather than "the board" because the capability that reaches the route is held
 * by the administrator as well, so naming the board would be false for one of
 * the two principals who can do it. The board member's own name is not in the
 * body at all: the audit entry records the actor, and the resident reads it in
 * their own data subject access report, which is the place a claim about who did
 * something can be answered.
 */
export const bookingCancellationMail: MailTemplate<BookingCancellationMailProps> =
  {
    id: "booking-cancellation",

    subject: (props, { t }) =>
      t("email.bookingCancellation.subject", { resource: props.resourceName }),

    body: (props, context): ReactElement => {
      const { t, appUrl } = context;

      return (
        <MailLayout
          context={context}
          preview={t("email.bookingCancellation.subject", {
            resource: props.resourceName,
          })}
          heading={t("email.bookingCancellation.heading")}
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
            {t("email.bookingCancellation.body", {
              resource: props.resourceName,
            })}
          </Text>

          {/* The period on its own line, for the reason the confirmation
              states: three modes read three different ways. */}
          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "17px",
              fontWeight: 700,
              lineHeight: 1.4,
              margin: "0 0 16px 0",
            }}
          >
            {bookingPeriodText(props, context)}
          </Text>

          <Text
            style={{
              color: MAIL_COLORS.inkMuted,
              fontSize: "13px",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {t("email.bookingCancellation.freedNotice")}
          </Text>

          <MailAction
            context={context}
            href={applicationUrl(appUrl)}
            label={t("email.bookingCancellation.action")}
          />
        </MailLayout>
      );
    },
  };
