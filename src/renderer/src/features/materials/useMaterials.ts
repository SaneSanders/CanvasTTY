import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasMaterial,
  MaterialRemark,
  MaterialResult,
  MaterialsAddResult,
  MaterialsSnapshot,
  MaterialVersionResult,
  Point,
  RemarkDraft,
  RemarkPatch,
  RemarkResult,
  SessionBounds
} from "../../../../shared/contracts";
import { acceptMaterialsSnapshot, EMPTY_MATERIALS_SNAPSHOT, withPendingBounds } from "./materialSnapshot";

export interface MaterialsController {
  materials: CanvasMaterial[];
  snapshot: MaterialsSnapshot;
  addFiles(files: File[], point: Point): Promise<MaterialsAddResult>;
  pick(point: Point): Promise<MaterialsAddResult>;
  paste(point: Point): Promise<MaterialsAddResult>;
  setBounds(id: string, bounds: SessionBounds): void;
  setBoundsBatch(entries: Array<{ id: string; bounds: SessionBounds }>): void;
  remove(id: string): Promise<void>;
  pinVersion(id: string): Promise<MaterialVersionResult>;
  reveal(id: string): Promise<void>;
  relink(id: string): Promise<MaterialResult>;
  acceptMove(id: string): Promise<MaterialResult>;
  addRemark(draft: RemarkDraft): Promise<RemarkResult>;
  updateRemark(id: string, patch: RemarkPatch): Promise<RemarkResult>;
  deleteRemark(id: string): Promise<void>;
  remark(id: string): MaterialRemark | null;
}

export function useMaterials(): MaterialsController {
  const [snapshot, setSnapshot] = useState<MaterialsSnapshot>(EMPTY_MATERIALS_SNAPSHOT);
  const pendingBounds = useRef(new Map<string, SessionBounds>());

  useEffect(() => {
    let active = true;
    const apply = (next: MaterialsSnapshot): void => {
      if (active) setSnapshot((current) => acceptMaterialsSnapshot(current, next));
    };
    const unsubscribe = window.canvasTTY.materials.onChanged(apply);
    void window.canvasTTY.materials.snapshot().then(apply).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const materials = useMemo(
    () => withPendingBounds(snapshot.materials, pendingBounds.current),
    [snapshot]
  );

  const setBounds = useCallback((id: string, bounds: SessionBounds): void => {
    pendingBounds.current.set(id, { position: { ...bounds.position }, size: { ...bounds.size } });
    setSnapshot((current) => ({ ...current }));
    window.canvasTTY.materials.setBounds(id, bounds);
  }, []);

  const setBoundsBatch = useCallback((entries: Array<{ id: string; bounds: SessionBounds }>): void => {
    for (const entry of entries) {
      pendingBounds.current.set(entry.id, { position: { ...entry.bounds.position }, size: { ...entry.bounds.size } });
    }
    setSnapshot((current) => ({ ...current }));
    window.canvasTTY.materials.setBoundsBatch(entries);
  }, []);

  return useMemo(() => ({
    materials,
    snapshot,
    addFiles: (files, point) => window.canvasTTY.materials.addFiles(files, point),
    pick: (point) => window.canvasTTY.materials.pick(point),
    paste: (point) => window.canvasTTY.materials.paste(point),
    setBounds,
    setBoundsBatch,
    remove: (id) => window.canvasTTY.materials.remove(id),
    pinVersion: (id) => window.canvasTTY.materials.pinVersion(id),
    reveal: (id) => window.canvasTTY.materials.reveal(id),
    relink: (id) => window.canvasTTY.materials.relink(id),
    acceptMove: (id) => window.canvasTTY.materials.acceptMove(id),
    addRemark: (draft) => window.canvasTTY.materials.addRemark(draft),
    updateRemark: (id, patch) => window.canvasTTY.materials.updateRemark(id, patch),
    deleteRemark: (id) => window.canvasTTY.materials.deleteRemark(id),
    remark: (id) => snapshot.remarks.find((candidate) => candidate.id === id) ?? null
  }), [materials, setBounds, setBoundsBatch, snapshot]);
}
