import assert from "node:assert/strict";
import test from "node:test";
import { attachmentOutcome, createAskGate, createSpeechGate, createVoiceSession, parseSseBuffer } from "../sse.mjs";

test("SSE parsing accepts CRLF and a final record without a trailing blank line", () => {
  const crlf = "data: {\"type\":\"delta\",\"text\":\"Hello\"}\r\n\r\ndata: {\"type\":\"done\",\"answer\":\"Hello\"}\r\n\r\n";
  const parsed = parseSseBuffer(crlf, true);
  assert.equal(parsed.events.length, 2);
  assert.equal(JSON.parse(parsed.events[1].data).answer, "Hello");

  const split = parseSseBuffer("data: {\"type\":\"delta\",\"text\":\"Hi\"}\r", false);
  assert.equal(split.events.length, 0);
  const flushed = parseSseBuffer(`${split.rest}\n`, true);
  assert.equal(JSON.parse(flushed.events[0].data).text, "Hi");

  const partial = parseSseBuffer("data: {\"type\":\"delta\",\"text\":\"West\"}", true);
  assert.equal(JSON.parse(partial.events[0].data).text, "West");
  assert.equal(partial.events.some(event => JSON.parse(event.data).type === "done"), false);
});

test("Stop rejects a queued hands-free restart and a late voice result", async () => {
  const voice = createVoiceSession();
  let starts = 0;
  voice.setHandsFree(true);
  const first = voice.begin();
  voice.queueRestart(20, () => { starts += 1; });
  voice.stop();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(starts, 0);
  assert.equal(voice.acceptResult(first), false);
  voice.setHandsFree(true);
  const second = voice.begin();
  assert.equal(voice.acceptResult(first), false);
  assert.equal(voice.acceptResult(second), true);
});

test("Clear or Stop drops an in-flight answer and a late spoken reply", () => {
  const ask = createAskGate();
  const first = ask.begin();
  assert.equal(ask.begin(), null);
  ask.abort();
  assert.equal(ask.finish(first.token), false);

  const speech = createSpeechGate();
  const spoken = speech.begin();
  speech.invalidate();
  assert.equal(speech.current(spoken.token), false);
  assert.equal(attachmentOutcome(4, 4, false), "keep");
  assert.equal(attachmentOutcome(4, 5, true), "keep");
  assert.equal(attachmentOutcome(5, 5, true), "clear");
});
