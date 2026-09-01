import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { type BookingMailPeriod, bookingPeriodText } from "./booking-period";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface BookingConfirmationMailProps extends BookingMailPeriod {
  /** The person who made the booking. Nobody else is written to. */
  recipientName: string;
  /** The resource as the board named it. Holds no personal data. */
  resourceName: string;
}

/**
 * Confirmation of a booking, sent to whoever made it.
 *
 * It carries the resource and the period and nothing else. Which apartment the
 * booking was counted against is deliberately absent: the recipient is the
 * person who made it, so it tells them nothing they did not just type, and the
 * apartment reference on a booking is nullable - a mail with a branch for the
 * household having been deleted would be a sentence written for a case that
 * cannot happen between the commit and the send.
 *
 * Wanted weekly by the pilot for the guest apartment and the common room, where
 * the booking is made days ahead and the confirmation is what the household
 * keeps.
 */
export const bookingConfirmationMail: MailTemplate<BookingConfirmationMailProps> =
  {
    id: "booking-confirmation",

    subject: (props, { t }) =>
      t("email.bookingConfirmation.subject", { resource: props.resourceName }),

    body: (props, context): ReactElement => {
      const { t, appUrl } = context;

      return (
        <MailLayout
          context={context}
          preview={t("email.bookingConfirmation.subject", {
            resource: props.resourceName,
          })}
          heading={t("email.bookingConfirmation.heading")}
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
            {t("email.bookingConfirmation.body", {
              resource: props.resourceName,
            })}
          </Text>

          {/*
           * The period on its own line rather than inside the sentence above.
           * It is what the recipient came to the message for, and the three
           * modes read too differently for one sentence to hold all of them
           * without reading badly in two of the three.
           */}
          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "17px",
              fontWeight: 700,
              lineHeight: 1.4,
              margin: 0,
            }}
          >
            {bookingPeriodText(props, context)}
          </Text>

          <MailAction
            context={context}
            href={applicationUrl(appUrl)}
            label={t("email.bookingConfirmation.action")}
          />
        </MailLayout>
      );
    },
  };
