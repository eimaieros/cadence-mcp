// @ts-check
/**
 * An append-only record of every tool call, one JSON object per line.
 *
 * WHY. An assistant calling tools is a second actor on the account. When a
 * session disappears or a scorecard was paid for twice, the question is "who
 * did that, when, and was a person asked?" — and the client's chat history is
 * not a record anyone can rely on. This file is.
 *
 * Each line carries the request ID that was also sent to cadence as
 * X-Request-ID, so one tool call can be followed into the API's own logs.
 *
 * WHAT IS NOT IN IT. Credentials and tokens never reach this module. Answer
 * text is reduced to its length: an interview answer can say anything about
 * the person giving it, and an audit trail needs to show that an answer was
 * submitted, not what it said.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @typedef {object} AuditEntry
 * @property {string} tool
 * @property {string} request_id
 * @property {"ok" | "error" | "declined"} outcome
 * @property {Record<string, unknown>} args
 * @property {number} duration_ms
 * @property {number} [status]   HTTP status from cadence, when there was one
 * @property {string} [detail]   why it failed or was declined
 */

export class AuditLog {
  /** @type {string | null} */
  #path;
  #warned = false;
  /** @type {Promise<void>} */
  #tail = Promise.resolve();
  /** @type {AuditEntry[] | null} kept in memory only when there is no file, for tests */
  entries;

  /** @param {string | null} path  null keeps entries in memory instead */
  constructor(path) {
    this.#path = path;
    this.entries = path ? null : [];
  }

  /**
   * Record one call. Never throws: a full disk must not turn a successful tool
   * call into a failed one. It complains on stderr once instead — stdout is
   * the MCP channel and must carry nothing else.
   *
   * @param {AuditEntry} entry
   */
  record(entry) {
    const line = { ts: new Date().toISOString(), ...entry };
    if (this.entries) {
      this.entries.push(line);
      return Promise.resolve();
    }
    const path = /** @type {string} */ (this.#path);
    // Chained so lines land in call order even when calls overlap.
    this.#tail = this.#tail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, JSON.stringify(line) + "\n", { mode: 0o600 });
      })
      .catch((err) => {
        if (!this.#warned) {
          this.#warned = true;
          process.stderr.write(`cadence-mcp: could not write the audit log at ${path}: ${err.message}\n`);
        }
      });
    return this.#tail;
  }
}

/**
 * The arguments as they go into the log. Free text a person typed is reduced
 * to its size; everything else is an identifier or a setting and is kept.
 *
 * @param {Record<string, unknown>} args
 */
export function redact(args) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === "answer" && typeof v === "string") out.answer_chars = v.length;
    else out[k] = v;
  }
  return out;
}
