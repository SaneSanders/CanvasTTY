import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact } from "./helpers/fake-react.mjs";

const { MaterialCard, __render, __flush, __unmount } = await importWithFakeReact(
  "src/renderer/src/features/materials/MaterialCard.tsx", "MaterialCard"
);

function fixture(t) {
  t.after(__unmount);
  let zoom = 1;
  const props = {
    material: {
      id: "m", kind: "text", name: "notes.txt", location: "/work/notes.txt", state: "ready",
      position: { x: 0, y: 0 }, size: { width: 520, height: 400 }, versions: [],
      liveRevision: 1, byteSize: 5, origin: null, draft: null, scenario: null
    },
    locale: "en", camera: { get: () => ({ x: 0, y: 0, zoom }), subscribe: () => () => {} },
    stackIndex: 1, snapEnabled: false, getSnapTargets: () => [], removeRequest: 0,
    remarking: { mode: "view", remarks: [], referencedBy: 0, selectedRemarkId: null },
    remarkActions: {}, onBoundsChange() {}, onRemove() {}, onOpenMenu() {}, onAction() {}
  };
  let tree;
  const render = () => {
    __flush();
    tree = __render(MaterialCard, props);
    return tree;
  };
  const body = () => findAll(tree, (node) => node.type?.name === "MaterialBody")[0];
  const button = (label) => findAll(tree, (node) => node.type === "button"
    && (node.props.children === label || node.props["aria-label"] === label))[0];
  const bodyPath = () => {
    const visit = (node, path) => {
      if (node === body()) return path;
      if (!node || typeof node !== "object") return null;
      for (const [index, child] of [].concat(node.props?.children ?? []).entries()) {
        const found = visit(child, [...path, child?.key ?? index]);
        if (found) return found;
      }
      return null;
    };
    return visit(tree, []);
  };
  render();
  body().props.onPendingText(true);
  return { render, body, button, bodyPath, zoom: (value) => { zoom = value; } };
}

test("cancelled removal keeps pending text mounted", (t) => {
  const { render, body, button, bodyPath } = fixture(t);
  const path = bodyPath();
  button("Remove from canvas").props.onClick();
  const confirmation = render();
  assert.ok(body());
  assert.deepEqual(bodyPath(), path);
  const hidden = findAll(confirmation, (node) => node.props?.hidden && findAll(node, (child) => child === body()).length > 0)[0];
  assert.ok(hidden);
  assert.equal(hidden.props.inert, true);
  assert.equal(hidden.props.style.display, "none");
  const focusTarget = findAll(confirmation, (node) => node.props?.["data-material-focus"])[0];
  assert.equal(focusTarget.props.hidden, undefined);
  assert.equal(focusTarget.props.tabIndex, -1);
  button("Cancel").props.onClick();
  const restored = render();
  assert.deepEqual(bodyPath(), path);
  assert.equal(findAll(restored, (node) => node.props?.hidden).length, 0);
});

test("zooming preserves pending text", (t) => {
  const { render, body, bodyPath, zoom } = fixture(t);
  const path = bodyPath();
  zoom(0.2);
  render();
  assert.ok(body());
  assert.deepEqual(bodyPath(), path);
  zoom(1);
  render();
  assert.deepEqual(bodyPath(), path);
});
