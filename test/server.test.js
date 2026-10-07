// The process as a client starts it: `node src/server.js` with stdio piped.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/server.js";

const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));

/** @param {Record<string, string>} env */
function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the process", () => {
  it("explains a missing setting on stderr and exits, leaving stdout clean", async () => {
    // stdout is the MCP channel. One stray line there and the client sees a
    // malformed protocol message instead of the actual problem.
    const r = /** @type {any} */ (await run({}));
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /Missing CADENCE_API_URL, CADENCE_EMAIL, CADENCE_PASSWORD/);
  });

  it("reports the version package.json declares", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(VERSION, pkg.version);
  });
});
