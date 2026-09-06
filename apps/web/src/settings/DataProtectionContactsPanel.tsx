import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  saveDataProtectionContacts,
  type DataProtectionContacts,
} from "../api/instance";
import { FIELD, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";

export interface DataProtectionContactsPanelProps {
  contacts: DataProtectionContacts;
  /** False for a board member, who reads the settings without changing them. */
  mayManage: boolean;
}

/**
 * Who answers for the association's processing of personal data.
 *
 * Three things the record and the notice both need, and neither could state
 * before: how the association is reached as controller (GDPR art. 13(1)(a),
 * art. 30(1)(a)), its data protection officer where it has appointed one
 * (art. 13(1)(b)), and a joint controller where there is one (art. 30(1)(a)).
 *
 * Recorded once here rather than typed onto the privacy notice, because a copy
 * on the page would go stale the day the board changed it - and the page is a
 * document the association is answerable for.
 *
 * The officer is empty on most instances and that is the right answer, not an
 * unfinished one: art. 37(1) rarely reaches a housing cooperative, and the
 * screen says so rather than leaving a board wondering what it has missed.
 */
export function DataProtectionContactsPanel({
  contacts,
  mayManage,
}: DataProtectionContactsPanelProps): ReactElement {
  const { t } = useTranslation();

  const [contactEmail, setContactEmail] = useState(
    contacts.controller.contactEmail ?? "",
  );
  const [postalAddress, setPostalAddress] = useState(
    contacts.controller.postalAddress ?? "",
  );
  const [officerName, setOfficerName] = useState(contacts.officer.name ?? "");
  const [officerEmail, setOfficerEmail] = useState(
    contacts.officer.email ?? "",
  );
  const [officerPhone, setOfficerPhone] = useState(
    contacts.officer.phone ?? "",
  );
  const [jointName, setJointName] = useState(
    contacts.jointController.name ?? "",
  );
  const [jointContact, setJointContact] = useState(
    contacts.jointController.contact ?? "",
  );

  const save = useSaveAction(saveDataProtectionContacts);

  return (
    <Panel
      title={t("settings.dataProtectionContacts.title")}
      description={t("settings.dataProtectionContacts.description")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save.submit({
            controller: { contactEmail, postalAddress },
            officer: {
              name: officerName,
              email: officerEmail,
              phone: officerPhone,
            },
            jointController: { name: jointName, contact: jointContact },
          });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.contactEmail")}
          </span>
          <input
            className={FIELD}
            value={contactEmail}
            disabled={!mayManage}
            onChange={(event) => {
              setContactEmail(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.postalAddress")}
          </span>
          <input
            className={FIELD}
            value={postalAddress}
            disabled={!mayManage}
            onChange={(event) => {
              setPostalAddress(event.target.value);
            }}
          />
        </label>

        <p className={HINT}>
          {t("settings.dataProtectionContacts.officerHint")}
        </p>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.officerName")}
          </span>
          <input
            className={FIELD}
            value={officerName}
            disabled={!mayManage}
            onChange={(event) => {
              setOfficerName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.officerEmail")}
          </span>
          <input
            className={FIELD}
            value={officerEmail}
            disabled={!mayManage}
            onChange={(event) => {
              setOfficerEmail(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.officerPhone")}
          </span>
          <input
            className={FIELD}
            value={officerPhone}
            disabled={!mayManage}
            onChange={(event) => {
              setOfficerPhone(event.target.value);
            }}
          />
        </label>

        <p className={HINT}>{t("settings.dataProtectionContacts.jointHint")}</p>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.jointName")}
          </span>
          <input
            className={FIELD}
            value={jointName}
            disabled={!mayManage}
            onChange={(event) => {
              setJointName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("settings.dataProtectionContacts.jointContact")}
          </span>
          <input
            className={FIELD}
            value={jointContact}
            disabled={!mayManage}
            onChange={(event) => {
              setJointContact(event.target.value);
            }}
          />
        </label>

        {mayManage ? (
          <div>
            <button type="submit" className={PRIMARY_BUTTON}>
              {save.state.kind === "saving"
                ? t("settings.saving")
                : t("settings.save")}
            </button>
          </div>
        ) : null}

        {save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {save.state.failure.reason === "joint-controller-incomplete"
              ? t("settings.dataProtectionContacts.errors.jointIncomplete")
              : t("settings.dataProtectionContacts.errors.unknown")}
          </Notice>
        ) : null}
      </form>
    </Panel>
  );
}
