#!/usr/bin/env node
/**
 * One whole interview, through the real server process, against a running
 * cadence: start, two questions and answers, budget, finish (twice), read,
 * a closed-session error, a 404, delete.
 *
 * Not part of CI — it needs cadence up and an account on it. It is how the
 * tools were checked against the real API rather than only against the fake
 * one in test/, and it is the thing to run before trusting a change to either.
 *
 *   # cadence: docker compose up   (no API key needed: the scripted interviewer runs)
 *   CADENCE_API_URL=http://localhost:8000 \
 *   CADENCE_EMAIL=you@example.com CADENCE_PASSWORD='…' \
 *   node tools/e2e.mjs
 *
 * Confirmations are answered "yes" automatically — this script plays the
 * person — and the interview it creates is deleted at the end.
 */

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = fileURLToPath(new URL("../src/server.js", import.meta.url));
const pass = ["CADENCE_API_URL", "CADENCE_EMAIL", "CADENCE_PASSWORD", "CADENCE_MCP_AUDIT_LOG", "PATH", "HOME", "USERPROFILE"];
/** @type {Record<string, string>} */
const env = {};
for (const k of pass) if (process.env[k]) env[k] = /** @type {string} */ (process.env[k]);

const client = new Client({ name: "cadence-mcp-e2e", version: "0" }, { capabilities: { elicitation: {} } });
/** @type {string[]} */
const asked = [];
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  asked.push(String(req.params.message));
  return { action: "accept", content: { confirm: true } };
});
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env }));

/** @param {string} name @param {Record<string, unknown>} [args] */
async function call(name, args = {}) {
  const r = /** @type {any} */ (await client.callTool({ name, arguments: args }));
  const text = r.content.map((/** @type {any} */ c) => c.text).join("\n");
  console.log(`\n### ${name}${r.isError ? "  [isError]" : ""}\n${text}`);
  return text;
}

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const started = await call("start_interview", { role_title: "Backend Engineer", focus_areas: ["PostgreSQL", "API design"] });
const id = started.match(/[0-9a-f-]{36}/)?.[0];
if (!id) throw new Error("start_interview did not return an ID");

await call("ask_next_question", { session_id: id });
await call("submit_answer", { session_id: id, answer: "I would start from the slow query log, add the index, and compare p95 before and after." });
await call("ask_next_question", { session_id: id });
await call("submit_answer", { session_id: id, answer: "An idempotency key on the POST, stored under a unique constraint." });
await call("get_budget", { session_id: id });
await call("finish_interview", { session_id: id });
await call("finish_interview", { session_id: id }); // already scored: no second prompt, no second charge
await call("get_interview", { session_id: id });
await call("ask_next_question", { session_id: id }); // closed: 409
await call("get_interview", { session_id: "7c0e6f9e-0000-4000-8000-000000000000" }); // 404
await call("delete_interview", { session_id: id });

console.log(`\nconfirmations asked: ${asked.length} (expected 2: finish once, delete once)`);
await client.close();
if (asked.length !== 2) process.exit(1);
