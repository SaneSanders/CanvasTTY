import { useCallback } from "react";
import type { RefObject } from "react";
import type { AppSettings, CanvasMaterial, MaterialsAddResult, Point } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import {
  addResultNeedsNotice,
  materialFailureKey,
  materialRejectionKey,
  type MaterialCommand
} from "./materialCardModel";
import type { MaterialsController } from "./useMaterials";

export interface MaterialCanvasActions {
  addMaterialFiles(files: File[], point: Point): void;
  pickMaterials(point: Point): void;
  pasteMaterials(point: Point): void;
  removeMaterial(id: string): void;
  runMaterialCommand(id: string, command: MaterialCommand): void;
  reportMaterialsFailure(): void;
}

export function useMaterialActions({
  materials,
  materialsRef,
  settingsRef,
  showToast,
  focusMaterial
}: {
  materials: MaterialsController;
  materialsRef: RefObject<readonly CanvasMaterial[]>;
  settingsRef: RefObject<AppSettings>;
  showToast(message: string): void;
  focusMaterial(material: CanvasMaterial): void;
}): MaterialCanvasActions {
  const reportMaterialsFailure = useCallback((): void => {
    showToast(t(settingsRef.current.locale, "materialsFailed"));
  }, [settingsRef, showToast]);

  const reportMaterialsAdded = useCallback((result: MaterialsAddResult): void => {
    if (!addResultNeedsNotice(result)) return;
    const locale = settingsRef.current.locale;
    if (result.rejected.length > 0) {
      const details = result.rejected
        .map((rejection) => `${rejection.name}: ${t(locale, materialRejectionKey(rejection.reason))}`)
        .join("; ");
      showToast(result.rejected.every((rejection) => rejection.reason === "empty-clipboard")
        ? t(locale, "materialsEmptyClipboard")
        : `${t(locale, "materialsNotAdded")} — ${details}`);
      return;
    }
    const existing = materialsRef.current.find((material) => material.id === result.existing[0]);
    showToast(t(locale, "materialsAlreadyOnCanvas"));
    if (existing) focusMaterial(existing);
  }, [focusMaterial, materialsRef, settingsRef, showToast]);

  const addMaterialFiles = useCallback((files: File[], point: Point): void => {
    void materials.addFiles(files, point).then(reportMaterialsAdded, reportMaterialsFailure);
  }, [materials, reportMaterialsAdded, reportMaterialsFailure]);

  const pickMaterials = useCallback((point: Point): void => {
    void materials.pick(point).then(reportMaterialsAdded, reportMaterialsFailure);
  }, [materials, reportMaterialsAdded, reportMaterialsFailure]);

  const pasteMaterials = useCallback((point: Point): void => {
    void materials.paste(point).then(reportMaterialsAdded, reportMaterialsFailure);
  }, [materials, reportMaterialsAdded, reportMaterialsFailure]);

  const removeMaterial = useCallback((id: string): void => {
    void materials.remove(id).catch(reportMaterialsFailure);
  }, [materials, reportMaterialsFailure]);

  const runMaterialCommand = useCallback((id: string, command: MaterialCommand): void => {
    const locale = settingsRef.current.locale;
    const fail = (reason: Parameters<typeof materialFailureKey>[0]): void => {
      const key = materialFailureKey(reason);
      if (key) showToast(t(locale, key));
    };
    if (command === "pin") {
      void materials.pinVersion(id).then((result) => {
        if (result.ok) showToast(`${t(locale, "materialVersionPinned")}: v${result.version.number}`);
        else fail(result.reason);
      }, reportMaterialsFailure);
    } else if (command === "reveal") {
      void materials.reveal(id).catch(reportMaterialsFailure);
    } else if (command === "copy-path") {
      const location = materialsRef.current.find((material) => material.id === id)?.location;
      if (!location) return;
      window.canvasTTY.clipboard.writeText(location);
      showToast(t(locale, "materialPathCopied"));
    } else {
      const request = command === "relink" ? materials.relink(id) : materials.acceptMove(id);
      void request.then((result) => {
        if (!result.ok) fail(result.reason);
      }, reportMaterialsFailure);
    }
  }, [materials, materialsRef, reportMaterialsFailure, settingsRef, showToast]);

  return { addMaterialFiles, pickMaterials, pasteMaterials, removeMaterial, runMaterialCommand, reportMaterialsFailure };
}
