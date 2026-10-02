import assert from "node:assert/strict";
import test from "node:test";
import { SessionScreen } from "../src/main/services/materials/sessionScreen.ts";

const port = (buffer) => ({
  geometry: () => ({ cols: 60, rows: 12 }),
  readBuffer: () => ({ buffer, outputOffset: buffer.length })
});

test("typed text continues past the marker line until a rule", async () => {
  const screen = new SessionScreen(port("previous output\r\n❯ \r\n  user draft on second line\r\n  and third\r\n"), "s1");
  assert.equal((await screen.typedAfter("❯")).replace(/\s+/g, ""), "userdraftonsecondlineandthird");
  screen.dispose();
});

test("status chrome below the rule stays out", async () => {
  const screen = new SessionScreen(port("❯ \r\n" + "─".repeat(60) + "\r\n⏵⏵ bypass permissions on\r\n"), "s2");
  assert.equal(await screen.typedAfter("❯"), "");
  screen.dispose();
});

test("no marker means not ready", async () => {
  const screen = new SessionScreen(port("plain output only\r\n"), "s3");
  assert.equal(await screen.typedAfter("❯"), null);
  screen.dispose();
});

test("blank and lone-box lines inside the prompt do not end the draft", async () => {
  const blank = new SessionScreen(port("❯ \r\n  \r\n  user draft\r\n" + "─".repeat(60) + "\r\n"), "s4");
  assert.equal((await blank.typedAfter("❯")).replace(/\s+/g, ""), "userdraft");
  blank.dispose();
  const loneBox = new SessionScreen(port("❯ \r\n  │\r\n  user draft\r\n" + "─".repeat(60) + "\r\n"), "s5");
  assert.equal((await loneBox.typedAfter("❯")).replace(/\s+/g, ""), "│userdraft");
  loneBox.dispose();
});

test("an earlier draft is seen even with another marker further down", async () => {
  const screen = new SessionScreen(port("❯ real draft\r\n  ❯ \r\n" + "─".repeat(60) + "\r\n"), "s6");
  assert.equal((await screen.typedAfter("❯")).replace(/\s+/g, ""), "realdraft❯");
  screen.dispose();
});
