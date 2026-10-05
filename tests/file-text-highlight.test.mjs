import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact, tick } from "./helpers/fake-react.mjs";

test("late highlighting follows current text", async () => {
  const loaded = Promise.withResolvers();
  globalThis.__textHighlighter = loaded.promise;
  const calls = [];
  const hook = await importWithFakeReact("src/renderer/src/features/files/useTextHighlight.ts", "useTextHighlight", {
    plugins: [{
      name: "delayed-highlight",
      setup(builder) {
        builder.onResolve({ filter: /\/codeHighlight(?:\.ts)?$/ }, () => ({ path: "codeHighlight", namespace: "delayed-highlight" }));
        builder.onLoad({ filter: /.*/, namespace: "delayed-highlight" }, () => ({
          contents: "export const highlightCodeLines = (await globalThis.__textHighlighter).highlightCodeLines;",
          loader: "js"
        }));
      }
    }]
  });
  let input = { name: "source.ts", text: "const old = 1;", hash: "old", byteSize: 14 };
  const render = () => {
    hook.__flush();
    return hook.__render(hook.useTextHighlight, input);
  };
  try {
    assert.equal(render().lines, null);
    input = { ...input, text: "const current = 2;", hash: "current", byteSize: 18 };
    assert.equal(render().lines, null);
    loaded.resolve({ highlightCodeLines(text, language) {
      calls.push({ text, language });
      return [[{ text, classNames: [language] }]];
    } });
    await tick();
    assert.deepEqual(render().lines, [[{ text: "const current = 2;", classNames: ["typescript"] }]]);
    render();
    await tick();
    render();
    assert.deepEqual(calls, [{ text: "const current = 2;", language: "typescript" }]);
    input = { ...input, name: "source.json" };
    assert.equal(render().lines, null);
    await tick();
    assert.deepEqual(render().lines, [[{ text: "const current = 2;", classNames: ["json"] }]]);
    input = { ...input, text: "plain text", hash: "plain", name: "source.txt", byteSize: 10 };
    assert.deepEqual(render(), { lines: null, plain: false });
  } finally {
    hook.__unmount();
    delete globalThis.__textHighlighter;
  }
});

test("failed highlighting keeps raw text", async () => {
  const hook = await importWithFakeReact("src/renderer/src/features/files/useTextHighlight.ts", "useTextHighlight", {
    plugins: [{
      name: "failed-highlight",
      setup(builder) {
        builder.onResolve({ filter: /\/codeHighlight(?:\.ts)?$/ }, () => ({ path: "codeHighlight", namespace: "failed-highlight" }));
        builder.onLoad({ filter: /.*/, namespace: "failed-highlight" }, () => ({ contents: 'throw new Error("unavailable"); export const highlightCodeLines = () => null;', loader: "js" }));
      }
    }]
  });
  const input = { name: "source.ts", text: "const x = 1;", hash: "a", byteSize: 12 };
  try {
    hook.__render(hook.useTextHighlight, input);
    await tick();
    hook.__flush();
    assert.deepEqual(hook.__render(hook.useTextHighlight, input), { lines: null, plain: true });
  } finally {
    hook.__unmount();
  }
});
