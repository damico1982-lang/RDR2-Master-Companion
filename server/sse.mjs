import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(new URL("./public/frontier-session.js", import.meta.url));
const sandbox = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout };
const context = createContext(sandbox);
runInContext(readFileSync(filename, "utf8"), context, { filename });

export const {
  parseSseBuffer,
  createVoiceSession,
  createAskGate,
  createSpeechGate,
  attachmentOutcome
} = sandbox.module.exports;
