#!/usr/bin/env node
/**
 * Plain-Node driver for src/notice.ts — the seam that proves the extension loads
 * and runs under the runtime pi actually uses (Node + jiti; plain Node is strictly
 * stricter, so green here means green in pi).
 *
 * Usage: node test/fixtures/notice-driver.mjs <absNoticePath> <scenario> <repoRoot>
 * Scenarios: read | wiring | disabled | absent-db
 *
 * Seeds nothing (bun test seeds KANBAN_DB). The wiring scenario mutates the board
 * by spawning the resolved CLI (KANBAN_CLI, else ~/.bun/bin/kanban, else
 * `bun <repoRoot>/src/cli.ts`) with `add` and the inherited KANBAN_DB.
 * Prints exactly one JSON line:
 *   { scenario, node, sends: [{customType, display, content}], overview?, dbExists? }
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [noticePath, scenario, repoRoot] = process.argv.slice(2);
if (!noticePath || !scenario) {
  console.error("usage: node notice-driver.mjs <absNoticePath> <scenario> <repoRoot>");
  process.exit(2);
}

const sends = [];
const fakePi = {
  on(event, handler) {
    this.handlers[event] = handler;
    return () => {};
  },
  handlers: {},
  async sendMessage(message) {
    sends.push({ customType: message.customType, display: message.display, content: message.content });
  },
};

function resolveCli() {
  if (process.env.KANBAN_CLI) return { cmd: process.env.KANBAN_CLI, args: [] };
  const installed = join(homedir(), ".bun", "bin", "kanban");
  if (existsSync(installed)) return { cmd: installed, args: [] };
  return { cmd: "bun", args: [join(repoRoot ?? process.cwd(), "src", "cli.ts")] };
}

const notice = await import(pathToFileURL(noticePath).href);
const result = { scenario, node: process.version, sends };

if (scenario === "read") {
  result.overview = await notice.readOverview();
} else {
  notice.default(fakePi);

  if (scenario === "wiring") {
    await fakePi.handlers.session_start({ type: "session_start", reason: "startup" }, {});
    await sleep(200); // settle: the initial send has landed
    result.sendsAfterStart = sends.length;

    const { cmd, args } = resolveCli();
    await exec(cmd, [...args, "add", "notice mutation card"], { env: process.env });

    const deadline = Date.now() + 3000;
    while (sends.length < 2 && Date.now() < deadline) await sleep(100);
    result.sendsAfterChange = sends.length;

    await sleep(notice.noticeIntervalMs() + 500); // idle interval: nothing should change
    result.sendsAfterIdle = sends.length;
  } else if (scenario === "disabled") {
    await fakePi.handlers.session_start({ type: "session_start", reason: "startup" }, {});
    await sleep(1500);
    result.sendsAfterStart = sends.length;
  } else if (scenario === "absent-db") {
    await fakePi.handlers.session_start({ type: "session_start", reason: "startup" }, {});
    await sleep(1500);
    result.sendsAfterStart = sends.length;
    result.dbExists = existsSync(process.env.KANBAN_DB ?? "");
  }
}

console.log(JSON.stringify(result));
process.exit(0);
