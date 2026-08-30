import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface NewsMailProps {
  recipientName: string;
  /** The news item's own title, as the board wrote it. */
  title: string;
  /** The opening of the body. Empty when the item begins with a heading. */
  teaser: string;
  /** Absolute address of the article on the association's website. */
  articleUrl: string;
}

/**
 * Sent to the members when the board publishes a news item and asks for it.
 *
 * A notice rather than the article: the title, the opening, and a link to the
 * association's own website. Mailing the whole body would put a member-only
 * announcement into everybody's mailbox in full, where it outlives the decision
 * to publish it, and would make the mail a second place the association's
 * writing lives.
 *
 * The recipient's own language, like every other message: which language a
 * person is written to in is theirs to decide and not the board's.
 */
export const newsMail: MailTemplate<NewsMailProps> = {
  id: "news",

  subject: (props, { t, brand }) =>
    t("email.news.subject", {
      title: props.title,
      association: brand.associationName,
    }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;

    return (
      <MailLayout
        context={context}
        preview={props.title}
        heading={props.title}
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
          {props.teaser === ""
            ? t("email.news.body", { association: brand.associationName })
            : props.teaser}
        </Text>

        <MailAction
          context={context}
          href={props.articleUrl}
          label={t("email.news.action")}
        />
      </MailLayout>
    );
  },
};
