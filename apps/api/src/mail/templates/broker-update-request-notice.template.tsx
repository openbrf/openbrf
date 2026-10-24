import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface BrokerUpdateRequestNoticeMailProps {
  /** Board member being notified. */
  recipientName: string;
  /** The apartment as the broker wrote it, or null when they named none. */
  apartmentReference: string | null;
  receivedAt: Date;
}

/**
 * Tells the board a broker has asked it to look at the facts on the broker
 * information page.
 *
 * A pointer to the queue and nothing more: which apartment, when, and where
 * to read the rest. Who the broker is and how to reach them stay in the
 * instance, where the request is deleted on its own clock. A copy of them in
 * every board member's mailbox would outlive that clock for good, and the
 * board answers the broker by confirming the facts rather than by mail, so
 * the notice has no use for them. Its props carry none, so no later change to
 * the body can print them.
 *
 * The apartment is the one thing it does say, because it is what tells the
 * board whether the request is about a sale it already knows of.
 */
export const brokerUpdateRequestNoticeMail: MailTemplate<BrokerUpdateRequestNoticeMailProps> =
  {
    id: "broker-update-request-notice",
    processing: "brokerUpdateRequests",

    subject: (_props, { t }) => t("email.brokerUpdateRequestNotice.subject"),

    body: (props, context): ReactElement => {
      const { t, formatDate, appUrl } = context;

      return (
        <MailLayout
          context={context}
          preview={t("email.brokerUpdateRequestNotice.subject")}
          heading={t("email.brokerUpdateRequestNotice.heading")}
          recipientName={props.recipientName}
        >
          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "15px",
              lineHeight: 1.55,
              margin: "0 0 16px 0",
            }}
          >
            {props.apartmentReference === null
              ? t("email.brokerUpdateRequestNotice.bodyNoApartment", {
                  receivedAt: formatDate(props.receivedAt),
                })
              : t("email.brokerUpdateRequestNotice.body", {
                  receivedAt: formatDate(props.receivedAt),
                  apartment: props.apartmentReference,
                })}
          </Text>

          {/* The section of the association's settings the queue is in, by
              the id apps/web/src/settings/settings-sections.ts gives it. */}
          <MailAction
            context={context}
            href={`${applicationUrl(appUrl)}/board/settings/account-requests`}
            label={t("email.brokerUpdateRequestNotice.action")}
          />
        </MailLayout>
      );
    },
  };
