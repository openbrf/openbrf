import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate, MailTemplateContext } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

/**
 * Which general meeting is being summoned, as this mail carries it.
 *
 * Written out here rather than imported from the generated enums, on the
 * booking period's precedent: this directory is the shared correspondence layer
 * and has no business depending on the schema. The call site assigns the enum to
 * it, so a kind added to the schema and not answered below is a compile error
 * rather than a heading that silently falls through.
 */
export type MeetingNoticeMailKind = "ORDINARY" | "EXTRAORDINARY";

/**
 * What kind of meeting it is, as a heading and as a subject line.
 *
 * The screens' own keys rather than a second pair under `email`. This is one
 * term, and translating it twice is how the notice and the meeting screen come
 * to call the same meeting two things.
 */
function kindText(
  kind: MeetingNoticeMailKind,
  { t }: MailTemplateContext,
): string {
  switch (kind) {
    case "ORDINARY":
      return t("meetings.kind.ORDINARY");
    case "EXTRAORDINARY":
      return t("meetings.kind.EXTRAORDINARY");
  }
}

/**
 * The same kind of meeting, inside a sentence.
 *
 * A second label rather than {@link kindText} reused, because the screens' term
 * is a heading: it is capitalised and carries no article, and both are wrong in
 * running text. English needs an article before either kind and needs the term
 * lowercase; Swedish needs no article and also needs it lowercase, because a
 * common noun mid-sentence is not capitalised there either. So the article
 * travels with the label and the sentence around it states none, which is the
 * only arrangement that lets each language answer for itself.
 */
function kindInSentence(
  kind: MeetingNoticeMailKind,
  { t }: MailTemplateContext,
): string {
  switch (kind) {
    case "ORDINARY":
      return t("email.meetingNotice.bodyKind.ORDINARY");
    case "EXTRAORDINARY":
      return t("email.meetingNotice.bodyKind.EXTRAORDINARY");
  }
}

export interface MeetingNoticeMailProps {
  recipientName: string;
  /** Which meeting is being summoned. */
  kind: MeetingNoticeMailKind;
  /** When the meeting begins. Formatted in the recipient's locale. */
  startsAt: Date;
  /** Where it is held, as the board wrote it into the notice. */
  place: string;
  /**
   * How to take part and to vote, where the meeting is held digitally. Null for
   * a meeting held in a room.
   */
  digitalParticipation: string | null;
  /** The matters to be dealt with, in the order the meeting deals with them. */
  agenda: readonly string[];
}

/**
 * The notice (kallelse) that summons a member to a general meeting.
 *
 * The whole notice and not a link to it, which is the opposite of what the news
 * mail does and is the point of this template rather than an oversight. A news
 * mail carries a title and a link because the article lives on the
 * association's website and mailing the body would put a member-only
 * announcement into every mailbox in full. A notice has no such home: EFL 6
 * kap. 22 § makes what it states the requirement - the time, the place, how to
 * take part where the meeting is digital, and the matters to be dealt with,
 * clearly stated - and a link to a page behind a sign-in is not a notice that
 * has been given.
 *
 * So there is no action button either. Nothing here asks the member to click,
 * because the message is the document.
 *
 * The recipient's own language, like every other message: which language a
 * person is written to in is theirs to decide. What the board wrote - the place
 * and the agenda - is stored as written and never translated (decision 59), so
 * it appears in the language the board used whatever the recipient's is.
 */
export const meetingNoticeMail: MailTemplate<MeetingNoticeMailProps> = {
  id: "meeting-notice",

  subject: (props, context) =>
    context.t("email.meetingNotice.subject", {
      kind: kindText(props.kind, context),
      date: context.formatDate(props.startsAt),
      association: context.brand.associationName,
    }),

  body: (props, context): ReactElement => {
    const { t, brand, formatDate, formatTime } = context;
    const kind = kindText(props.kind, context);

    const line = {
      color: MAIL_COLORS.ink,
      fontSize: "15px",
      lineHeight: 1.55,
      margin: "0 0 8px 0",
    } as const;

    return (
      <MailLayout
        context={context}
        preview={t("email.meetingNotice.preview", {
          kind,
          date: formatDate(props.startsAt),
        })}
        heading={kind}
        recipientName={props.recipientName}
      >
        <Text style={line}>
          {t("email.meetingNotice.body", {
            association: brand.associationName,
            kind: kindInSentence(props.kind, context),
          })}
        </Text>

        <Text style={line}>
          {t("email.meetingNotice.when", {
            date: formatDate(props.startsAt),
            time: formatTime(props.startsAt),
          })}
        </Text>

        <Text style={line}>
          {t("email.meetingNotice.where", { place: props.place })}
        </Text>

        {props.digitalParticipation === null ? null : (
          <Text style={line}>
            {t("email.meetingNotice.digital", {
              instructions: props.digitalParticipation,
            })}
          </Text>
        )}

        <Text style={{ ...line, fontWeight: 600, margin: "16px 0 8px 0" }}>
          {t("email.meetingNotice.agendaHeading")}
        </Text>

        {/*
         * Numbered in the text rather than as a list, because the running order
         * is part of what the notice states and a mail client that drops list
         * markup would drop it. The position is one-based, as a board writes an
         * agenda.
         */}
        {props.agenda.map((item, index) => (
          <Text key={`${String(index)}-${item}`} style={line}>
            {t("email.meetingNotice.agendaItem", {
              position: index + 1,
              item,
            })}
          </Text>
        ))}
      </MailLayout>
    );
  },
};
