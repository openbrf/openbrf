import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  recordProcessorAgreement,
  type ProcessorClassification,
  type ProcessorView,
} from "../api/data-protection";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";

export interface ProcessorAgreementsPanelProps {
  processors: ProcessorView[];
  onRecorded: () => void;
}

/**
 * Why each refusal reads as a sentence rather than a code.
 *
 * Every one of these is the record refusing to say two things at once, and a
 * board that meets one needs to know which half to change - not that something
 * called classification-inconsistent happened.
 */
const REASON: Record<string, TranslationKey> = {
  "processor-not-found": "dataProtection.processors.errors.notFound",
  "classification-inconsistent":
    "dataProtection.processors.errors.classificationInconsistent",
  "terms-required": "dataProtection.processors.errors.termsRequired",
  "counterparty-required":
    "dataProtection.processors.errors.counterpartyRequired",
  "note-required": "dataProtection.processors.errors.noteRequired",
  "signed-on-required": "dataProtection.processors.errors.signedOnRequired",
  "personal-identity-number":
    "dataProtection.processors.errors.personalIdentityNumber",
};

const STATE_LABEL: Record<ProcessorView["state"], TranslationKey> = {
  inPlace: "dataProtection.processors.state.inPlace",
  pending: "dataProtection.processors.state.pending",
  notAProcessor: "dataProtection.processors.state.notAProcessor",
  independentController:
    "dataProtection.processors.state.independentController",
  notRecorded: "dataProtection.processors.state.notRecorded",
};

/**
 * Who receives the association's personal data, and what covers each of them.
 *
 * The classification is asked first and the agreement second, which is the
 * whole shape of GDPR art. 28 and the reason this screen is not a list of
 * contracts. A board told to record an agreement for its own hard disk would
 * conclude the product had not understood the question.
 *
 * The instance's own answer is offered where it has one - local-disk storage is
 * no processor - so the board confirms rather than researches.
 */
export function ProcessorAgreementsPanel({
  processors,
  onRecorded,
}: ProcessorAgreementsPanelProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);

  /**
   * What the row is called.
   *
   * A mail server names itself and so does a bucket, but storage on the
   * association's own disk and whoever runs the machine have no name the
   * instance can read. Those rows are called what kind they are, in the
   * reader's own language: a board looking at its recipients should not find
   * one of them labelled in English because the server had nothing to put
   * there.
   */
  const nameOf = (processor: ProcessorView): string =>
    processor.identity ??
    t(`dataProtection.processors.kind.${processor.processorKind}`);

  return (
    <Panel
      title={t("dataProtection.processors.title")}
      description={t("dataProtection.processors.description")}
    >
      <ul className="flex flex-col gap-3">
        {processors.map((processor) => (
          <li
            key={processor.processorKey}
            className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-body font-semibold">
                {nameOf(processor)}
              </span>
              {/*
               * The kind, where it is not already the name. A row the instance
               * has no name for is called what kind it is, and printing that
               * twice would read as a stutter rather than as two facts.
               */}
              {processor.identity === null ? null : (
                <span className={HINT}>
                  {t(
                    `dataProtection.processors.kind.${processor.processorKind}`,
                  )}
                </span>
              )}
              <span className="text-small font-semibold">
                {t(STATE_LABEL[processor.state])}
              </span>
            </div>

            {processor.detail === null ? null : (
              <p className={HINT}>{processor.detail}</p>
            )}

            {processor.seededClassification === "NOT_A_PROCESSOR" &&
            processor.state === "notRecorded" ? (
              <p className={HINT}>
                {t("dataProtection.processors.localDiskHint")}
              </p>
            ) : null}

            {processor.agreement?.counterparty == null ? null : (
              <p className={HINT}>{processor.agreement.counterparty}</p>
            )}

            <div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                // Names the recipient, because every row offers the same act
                // and a screen reader hears one button per row otherwise.
                aria-label={t("dataProtection.processors.classifyNamed", {
                  identity: nameOf(processor),
                })}
                onClick={() => {
                  setOpen(
                    open === processor.processorKey
                      ? null
                      : processor.processorKey,
                  );
                }}
              >
                {t("dataProtection.processors.classify")}
              </button>
            </div>

            {open === processor.processorKey ? (
              <ClassifyForm
                processor={processor}
                onRecorded={() => {
                  setOpen(null);
                  onRecorded();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ClassifyForm({
  processor,
  onRecorded,
}: {
  processor: ProcessorView;
  onRecorded: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [classification, setClassification] = useState<ProcessorClassification>(
    processor.agreement?.classification ??
      processor.seededClassification ??
      "PROCESSOR",
  );
  const [status, setStatus] = useState<"IN_PLACE" | "PENDING">(
    processor.agreement?.status ?? "PENDING",
  );
  const [counterparty, setCounterparty] = useState(
    processor.agreement?.counterparty ?? "",
  );
  const [signedOn, setSignedOn] = useState(processor.agreement?.signedOn ?? "");
  const [termsConfirmed, setTermsConfirmed] = useState(
    processor.agreement?.termsConfirmed ?? false,
  );
  const [subProcessorsAuthorised, setSubProcessorsAuthorised] = useState(
    processor.agreement?.subProcessorsAuthorised ?? false,
  );
  const [note, setNote] = useState(processor.agreement?.note ?? "");

  const save = useSaveAction(recordProcessorAgreement, () => {
    onRecorded();
  });

  const isProcessor = classification === "PROCESSOR";

  return (
    <form
      className="flex flex-col gap-3 border-l border-line pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit(processor.processorKey, {
          classification,
          // Only a processor has an agreement to describe; the other two
          // classifications refuse these fields outright.
          status: isProcessor ? status : null,
          counterparty: counterparty === "" ? null : counterparty,
          signedOn: isProcessor && signedOn !== "" ? signedOn : null,
          termsConfirmed: isProcessor ? termsConfirmed : null,
          subProcessorsAuthorised: isProcessor ? subProcessorsAuthorised : null,
          note: note === "" ? null : note,
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>
          {t("dataProtection.processors.classification")}
        </span>
        <select
          className={FIELD}
          value={classification}
          onChange={(event) => {
            setClassification(event.target.value as ProcessorClassification);
          }}
        >
          <option value="PROCESSOR">
            {t("dataProtection.processors.state.processor")}
          </option>
          <option value="NOT_A_PROCESSOR">
            {t("dataProtection.processors.state.notAProcessor")}
          </option>
          <option value="INDEPENDENT_CONTROLLER">
            {t("dataProtection.processors.state.independentController")}
          </option>
        </select>
      </label>

      {classification === "NOT_A_PROCESSOR" ||
      classification === "INDEPENDENT_CONTROLLER" ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t("dataProtection.processors.note")}</span>
          <textarea
            className={FIELD}
            rows={2}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </label>
      ) : null}

      {classification !== "NOT_A_PROCESSOR" ? (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {t("dataProtection.processors.counterparty")}
          </span>
          <input
            className={FIELD}
            value={counterparty}
            onChange={(event) => {
              setCounterparty(event.target.value);
            }}
          />
        </label>
      ) : null}

      {isProcessor ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>
              {t("dataProtection.processors.status")}
            </span>
            <select
              className={FIELD}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "IN_PLACE" | "PENDING");
              }}
            >
              <option value="PENDING">
                {t("dataProtection.processors.state.pending")}
              </option>
              <option value="IN_PLACE">
                {t("dataProtection.processors.state.inPlace")}
              </option>
            </select>
          </label>

          {status === "IN_PLACE" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>
                  {t("dataProtection.processors.signedOn")}
                </span>
                <input
                  className={FIELD}
                  type="date"
                  value={signedOn}
                  onChange={(event) => {
                    setSignedOn(event.target.value);
                  }}
                />
              </label>

              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={termsConfirmed}
                  onChange={(event) => {
                    setTermsConfirmed(event.target.checked);
                  }}
                />
                <span className="text-small">
                  {t("dataProtection.processors.termsConfirmed")}
                </span>
              </label>
            </>
          ) : null}

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={subProcessorsAuthorised}
              onChange={(event) => {
                setSubProcessorsAuthorised(event.target.checked);
              }}
            />
            <span className="text-small">
              {t("dataProtection.processors.subProcessorsAuthorised")}
            </span>
          </label>
        </>
      ) : null}

      <div>
        <button type="submit" className={SECONDARY_BUTTON}>
          {save.state.kind === "saving"
            ? t("dataProtection.processors.saving")
            : t("dataProtection.processors.save")}
        </button>
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            REASON[save.state.failure.reason ?? ""] ??
              "dataProtection.processors.errors.unknown",
          )}
        </Notice>
      ) : null}
    </form>
  );
}
