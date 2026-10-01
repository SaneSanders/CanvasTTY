import { useEffect, useRef, useState } from "react";
import type { CanvasMaterial, LocaleId, MaterialRemark, ScenarioStep } from "../../../../shared/contracts";
import { materialStepUrl, SCENARIO_TEXT_LIMIT } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import type { MaterialRemarkActions, MaterialRemarking } from "./materialRemarksModel";
import { RemarkChip } from "./RemarkChips";
import { scenarioStepIcon, scenarioStepSummary, scenarioStopKey } from "./scenarioModel";

export interface ScenarioControls {
  recordingId: string | null;
  stop(materialId: string): void;
  expect(text: string): Promise<boolean>;
}

export function ScenarioBody({
  material,
  locale,
  controls,
  remarking,
  remarkActions
}: {
  material: CanvasMaterial;
  locale: LocaleId;
  controls: ScenarioControls;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
}): React.JSX.Element {
  const scenario = material.scenario!;
  const [marking, setMarking] = useState(false);
  const [text, setText] = useState("");
  const [savingMark, setSavingMark] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const markInput = useRef<HTMLTextAreaElement>(null);
  const recording = scenario.state === "recording";
  const live = recording && controls.recordingId === material.id;
  const stopKey = scenarioStopKey(scenario.stopReason);
  const drawing = remarking.mode === "draw";
  const selectedAnchor = remarking.remarks.find((remark) => remark.id === remarking.selectedRemarkId)?.target.anchor;
  const marked = remarking.draftAnchor?.kind === "step" ? remarking.draftAnchor.index : selectedAnchor?.kind === "step" ? selectedAnchor.index : null;
  const stepRemarks = (index: number): MaterialRemark[] => remarking.remarks.filter((remark) => remark.target.anchor.kind === "step" && remark.target.anchor.index === index);

  useEffect(() => {
    if (marking) markInput.current?.focus({ preventScroll: true });
  }, [marking]);

  const saveMark = async (): Promise<void> => {
    if (savingMark) return;
    setSavingMark(true);
    try {
      if (await controls.expect(text)) {
        setText("");
        setMarking(false);
      }
    } finally {
      setSavingMark(false);
    }
  };

  return (
    <div className={["material-scenario", recording ? "material-scenario--recording" : "", drawing ? "material-scenario--drawing" : ""].filter(Boolean).join(" ")}>
      <div className="scenario__status" role="status">
        {recording && <span className="scenario__dot" aria-hidden="true" />}
        <strong>{t(locale, recording ? "scenarioRecording" : "scenarioDone")}</strong>
        <span>{`${t(locale, "scenarioSteps")} ${scenario.steps.length}`}</span>
        {!recording && stopKey && <span className="scenario__reason">{t(locale, stopKey)}</span>}
        {recording && (
          <span className="scenario__controls">
            {live && (
              <button type="button" aria-pressed={marking} onClick={() => setMarking((value) => !value)}>
                <UiIcon name="flag" size="1em" />{t(locale, "scenarioMark")}
              </button>
            )}
            <button type="button" className="scenario__stop" onClick={() => controls.stop(material.id)}>
              <UiIcon name="stop" size="1em" />{t(locale, "scenarioStop")}
            </button>
          </span>
        )}
      </div>
      {recording && <p className="scenario__hint">{t(locale, "scenarioPrivacy")}</p>}
      {marking && live && (
        <div className="scenario__mark">
          <textarea
            ref={markInput}
            value={text}
            maxLength={SCENARIO_TEXT_LIMIT}
            placeholder={t(locale, "scenarioMarkPlaceholder")}
            aria-label={t(locale, "scenarioMark")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void saveMark();
            }}
          />
          <span>
            <button type="button" onClick={() => setMarking(false)}>{t(locale, "cancel")}</button>
            <button type="button" className="scenario__save" disabled={!text.trim() || savingMark} onClick={() => void saveMark()}>{t(locale, "save")}</button>
          </span>
        </div>
      )}
      <ol className="scenario__steps">
        {scenario.steps.map((step) => (
          <ScenarioStepRow
            key={step.index}
            material={material}
            step={step}
            locale={locale}
            expanded={expanded === step.index}
            marked={marked === step.index}
            remarks={stepRemarks(step.index)}
            onToggle={() => setExpanded((value) => value === step.index ? null : step.index)}
            onPick={drawing ? () => remarkActions.draw(material.id, { kind: "step", index: step.index }) : null}
            onSelectRemark={remarkActions.select}
          />
        ))}
      </ol>
    </div>
  );
}

function ScenarioStepRow({
  material,
  step,
  locale,
  expanded,
  marked,
  remarks,
  onToggle,
  onPick,
  onSelectRemark
}: {
  material: CanvasMaterial;
  step: ScenarioStep;
  locale: LocaleId;
  expanded: boolean;
  marked: boolean;
  remarks: readonly MaterialRemark[];
  onToggle(): void;
  onPick: (() => void) | null;
  onSelectRemark(remarkId: string): void;
}): React.JSX.Element {
  return (
    <li className={["scenario-step", `scenario-step--${step.kind}`, marked ? "scenario-step--marked" : ""].filter(Boolean).join(" ")}>
      <span className="scenario-step__number">{step.index + 1}</span>
      <UiIcon name={scenarioStepIcon(step.kind)} size="1.1em" />
      {onPick ? (
        <button type="button" className="scenario-step__text scenario-step__pick" onClick={onPick}>{scenarioStepSummary(step, locale)}</button>
      ) : (
        <span className="scenario-step__text">{scenarioStepSummary(step, locale)}</span>
      )}
      {remarks.length > 0 && (
        <span className="scenario-step__remarks">
          {remarks.map((remark) => <RemarkChip key={remark.id} locale={locale} remark={remark} onSelect={onSelectRemark} />)}
        </span>
      )}
      {step.image ? (
        <button type="button" className={`scenario-step__shot ${expanded ? "scenario-step__shot--expanded" : ""}`} onClick={onToggle}
          aria-label={t(locale, "scenarioScreenshot")} aria-expanded={expanded}>
          <img src={materialStepUrl(material.id, step.index)} alt="" loading="lazy" draggable={false} />
        </button>
      ) : step.kind !== "tab-left" && step.kind !== "tab-returned" ? (
        <span className="scenario-step__no-shot">{t(locale, "scenarioNoShot")}</span>
      ) : null}
    </li>
  );
}
