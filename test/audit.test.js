import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AuditLog, redact } from "../src/audit.js";

/** @type {string} */
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadence-mcp-audit-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const entry = (/** @type {string} */ tool) => ({
  tool, request_id: `r-${tool}`, outcome: /** @type {const} */ ("ok"), args: {}, duration_ms: 1,
});

describe("audit log", () => {
  it("appends one JSON object per line, in call order, creating the folder", async () => {
    const path = join(dir, "nested", "audit.jsonl");
    const log = new AuditLog(path);
    // Fired without awaiting each one, the way overlapping tool calls would.
    const writes = ["a", "b", "c"].map((t) => log.record(entry(t)));
    await Promise.all(writes);

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.tool), ["a", "b", "c"]);
    assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.ts))));
  });

  it("is readable by its owner only", { skip: process.platform === "win32" && "POSIX permissions" }, async () => {
    const path = join(dir, "private.jsonl");
    await new AuditLog(path).record(entry("x"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("never fails the tool call when it cannot write", async () => {
    // A path whose parent is a file: mkdir and append both fail.
    const blocker = join(dir, "not-a-folder");
    await writeFile(blocker, "");
    const log = new AuditLog(join(blocker, "audit.jsonl"));
    const original = process.stderr.write.bind(process.stderr);
    /** @type {string[]} */
    const said = [];
    process.stderr.write = /** @type {any} */ ((/** @type {string} */ s) => (said.push(String(s)), true));
    try {
      await log.record(entry("one"));
      await log.record(entry("two"));
    } finally {
      process.stderr.write = original;
    }
    assert.equal(said.length, 1, "it should complain once, not on every call");
    assert.match(said[0], /could not write the audit log/);
  });

  it("reduces an answer to its length and keeps everything else", () => {
    assert.deepEqual(redact({ session_id: "s1", answer: "I would add a canary.", confirm: true }), {
      session_id: "s1",
      answer_chars: 21,
      confirm: true,
    });
  });
});
