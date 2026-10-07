#!/usr/bin/env node
// @ts-check
/**
 * cadence-mcp — entry point.
 *
 * Speaks MCP over stdio, which is how desktop clients such as Claude Desktop
 * and Claude Code start local servers. That makes stdout the protocol channel:
 * nothing else may ever be written to it, so every diagnostic goes to stderr.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog } from "./audit.js";
import { CadenceClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

/**
 * What the client tells the model about this server. The last two sentences
 * are the point: the assistant relays the interview, it does not sit it.
 */
export const INSTRUCTIONS = [
  "Runs practice technical interviews on cadence.",
  "Flow: start_interview, then ask_next_question and submit_answer in turns, then finish_interview for a scorecard.",
  "Show each question to the user exactly as returned.",
  "Submit the user's own answer; never answer a question on the user's behalf or improve the answer before submitting it.",
].join(" ");

/**
 * @param {{ client: import("./client.js").CadenceClient, audit: AuditLog, newRequestId?: () => string }} deps
 */
export function createServer(deps) {
  const server = new McpServer({ name: "cadence", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, deps);
  return server;
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`cadence-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const client = new CadenceClient({ baseUrl: config.apiUrl, email: config.email, password: config.password });
  const server = createServer({ client, audit: new AuditLog(config.auditLog) });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`cadence-mcp ${VERSION}: connected to ${config.apiUrl}\n`);
}

/**
 * True when this file is the program being run rather than a module being
 * imported (by the tests, say). The path is resolved first because `npx` and a
 * global install start us through a symlink in a `bin` folder, and comparing
 * the symlink's path with this file's real one would quietly never start the
 * server — a process that runs, prints nothing and answers nothing.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    process.stderr.write(`cadence-mcp: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
