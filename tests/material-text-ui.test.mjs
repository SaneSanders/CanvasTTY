import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { change, findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";
import { withMaterials } from "./material-fixtures.mjs";

const diff = await importWithFakeReact("src/renderer/src/features/materials/TextDiffView.tsx", "TextDiffView");
const body = await importWithFakeReact("src/renderer/src/features/materials/TextMaterialBody.tsx", "TextMaterialBody");

test("diff scroll survives deferred updates", () => {
  diff.__reset();
  const props = {
    before: Array.from({ length: 80 }, (_, index) => `old ${index}`).join("\n"),
    after: Array.from({ length: 80 }, (_, index) => `new ${index}`).join("\n"),
    locale: "en", labels: { before: "Before", after: "After" }
  };
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    let tree = diff.__render(diff.TextDiffView, props);
    const element = {
      scrollTop: 0, clientHeight: 180,
      querySelector(selector) { return { offsetHeight: selector.includes("legend") ? 20 : 18 }; }
    };
    tree.props.ref.current = element;
    diff.__render(diff.TextDiffView, props);
    diff.__flush();
    tree = diff.__render(diff.TextDiffView, props);
    element.scrollTop = 360;
    const event = { currentTarget: element };
    tree.props.onScroll(event);
    event.currentTarget = null;
    let failure = null;
    try { diff.__flush(); } catch (error) { failure = error.message; }
    assert.equal(failure, null);
    tree = diff.__render(diff.TextDiffView, props);
    const spacers = findAll(tree, (node) => node.props?.style?.height > 0);
    assert.equal(spacers[0].props.style.height, 180);
  } finally {
    diff.__unmount();
    globalThis.ResizeObserver = previousObserver;
  }
});

async function withEditor(run, { name = "notes.txt", text = "original\n", editing = true } = {}) {
  await withMaterials(async ({ service, work }) => {
    await writeFile(join(work, name), text);
    const { added: [id] } = await service.addPaths([join(work, name)], { x: 0, y: 0 });
    const content = await service.readText(id, null);
    const timers = new Map();
    let nextTimer = 0;
    const previousWindow = globalThis.window;
    globalThis.window = {
      setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout(timer) { timers.delete(timer); },
      canvasTTY: { materials: {
        readText: async () => content,
        readDraft: async (...args) => service.readDraft(...args),
        writeDraft: (...args) => service.writeDraft(...args),
        discardDraft: async (...args) => service.discardDraft(...args)
      } }
    };
    const props = {
      material: service.material(id), locale: "en", editing,
      remarking: { remarks: [], mode: "none", selectedRemarkId: null, draftAnchor: null, referenceAnchor: null },
      remarkActions: {}, staleVersionIds: new Set(), onReadable() {},
      onEditingChange(value) { props.editing = value; }
    };
    body.__reset();
    let tree;
    const render = () => {
      props.material = service.material(id);
      body.__flush();
      tree = body.__render(body.TextMaterialBody, props);
      return tree;
    };
    const settle = async () => { await tick(); render(); await tick(); render(); };
    const editor = () => findAll(tree, (node) => node.type === "textarea")[0];
    const button = (label) => findAll(tree, (node) => node.type === "button"
      && (Array.isArray(node.props.children) ? node.props.children.includes(label) : node.props.children === label))[0];
    try {
      render();
      await settle();
      await run({ id, service, props, render, settle, editor, button, tree: () => tree });
    } finally {
      body.__unmount();
      await tick();
      globalThis.window = previousWindow;
    }
  });
}

test("highlighted source keeps line anchors", async () => {
  await withEditor(async ({ props, render, settle, tree }) => {
    await settle();
    const lines = findAll(tree(), (node) => node.props?.className === "material-text__line");
    assert.equal(lines.length, 4);
    assert.ok(findAll(lines, (node) => node.props?.className?.includes("hljs-keyword")).length > 0);
    const shownText = (node) => typeof node === "string" ? node
      : Array.isArray(node) ? node.map(shownText).join("") : shownText(node?.props?.children ?? "");
    assert.deepEqual(lines.map(shownText), ["const value = `one", "two`;", "value;", " "]);
    let anchor;
    props.remarking.mode = "draw";
    props.remarkActions.draw = (_id, value) => { anchor = value; };
    render();
    const scroller = () => findAll(tree(), (node) => node.props?.className === "material-text__scroller")[0];
    const element = { offsetHeight: 180, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, height: 180 }), setPointerCapture() {} };
    const event = (clientY) => ({ currentTarget: element, clientY, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    scroller().props.onPointerDown(event(19));
    render();
    scroller().props.onPointerUp(event(37));
    assert.deepEqual(anchor, { kind: "lines", start: 2, end: 3 });
    props.editing = true;
    render();
    await settle();
    assert.equal(findAll(tree(), (node) => node.type === "textarea")[0].props.value, "const value = `one\ntwo`;\nvalue;\n");
  }, { name: "source.ts", text: "const value = `one\ntwo`;\nvalue;\n", editing: false });
});

test("large previews retain virtual rows", async () => {
  await withEditor(async ({ settle, tree }) => {
    await settle();
    const lines = findAll(tree(), (node) => node.props?.className === "material-text__line");
    assert.ok(lines.length < 100);
    assert.equal(lines[0].props.children, "const x = 1;");
    assert.equal(findAll(tree(), (node) => node.props?.className === "material-text__highlight-note").length, 1);
  }, { name: "source.ts", text: "const x = 1;\n".repeat(10_000), editing: false });
});

test("Done retains oversized edits after rejection", async () => {
  await withEditor(async ({ id, service, props, render, settle, editor, button, tree }) => {
    const reply = Promise.withResolvers();
    let submitted;
    window.canvasTTY.materials.writeDraft = (_id, edit) => { submitted = edit; return reply.promise; };
    const text = "x".repeat(14 * 1024 * 1024 + 1);
    change(editor(), text);
    render();
    button("Done editing").props.onClick();
    render();
    reply.resolve(await service.writeDraft(id, submitted));
    await settle();
    assert.equal(service.readDraft(id), null);
    assert.ok(findAll(tree(), (node) => node.props?.role === "alert").length > 0);
    props.editing = true;
    render();
    await settle();
    assert.equal(editor().props.value === text, true);
  });
});

test("discard clears edits retained after Done", async () => {
  await withEditor(async ({ props, render, settle, editor, button }) => {
    change(editor(), "kept draft\n");
    render();
    button("Done editing").props.onClick();
    render();
    await settle();
    button("Discard edits").props.onClick();
    render();
    props.editing = true;
    render();
    await settle();
    assert.equal(editor().props.value, "original\n");
  });
});

test("draft IPC failures preserve edits after reopening", async () => {
  await withEditor(async ({ service, props, render, settle, editor, button, tree }) => {
    const reply = Promise.withResolvers();
    window.canvasTTY.materials.writeDraft = () => reply.promise;
    change(editor(), "kept locally\n");
    render();
    button("Done editing").props.onClick();
    render();
    props.editing = true;
    render();
    await settle();
    reply.reject(new Error("IPC failed"));
    await settle();
    assert.equal(editor().props.value, "kept locally\n");
    assert.ok(findAll(tree(), (node) => node.props?.className === "material-text__status-error").length > 0);
    window.canvasTTY.materials.writeDraft = (...args) => service.writeDraft(...args);
    button("Done editing").props.onClick();
    render();
    await service.flush();
    await settle();
    assert.equal(findAll(tree(), (node) => node.props?.role === "alert").length, 0);
  });
});

test("late draft failures do not undo discard", async () => {
  await withEditor(async ({ props, render, settle, editor, button, tree }) => {
    const reply = Promise.withResolvers();
    window.canvasTTY.materials.writeDraft = () => reply.promise;
    change(editor(), "discard me\n");
    render();
    button("Done editing").props.onClick();
    render();
    button("Discard edits").props.onClick();
    render();
    reply.resolve({ ok: false, reason: "write-failed" });
    await settle();
    assert.equal(findAll(tree(), (node) => node.props?.role === "alert").length, 0);
    props.editing = true;
    render();
    await settle();
    assert.equal(editor().props.value, "original\n");
  });
});
