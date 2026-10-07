// @ts-check
/**
 * Configuration, from the environment the MCP client starts us with.
 *
 * Everything is checked here, at startup, so a typo surfaces as one sentence
 * on stderr instead of as the first tool call failing for a reason nobody can
 * see from inside a chat.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {}

/**
 * @typedef {object} Config
 * @property {string} apiUrl
 * @property {string} email
 * @property {string} password
 * @property {string | null} auditLog  path of the JSON-lines audit log, or null when switched off
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env) {
  const missing = ["CADENCE_API_URL", "CADENCE_EMAIL", "CADENCE_PASSWORD"].filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new ConfigError(`Missing ${missing.join(", ")}. See "Configuration" in the README.`);
  }

  const raw = /** @type {string} */ (env.CADENCE_API_URL).trim();
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`CADENCE_API_URL is not a URL: ${raw}`);
  }
  // The password and the bearer tokens travel on every login and call. Plain
  // HTTP is accepted only where nothing leaves the machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new ConfigError(`CADENCE_API_URL must use https (plain http is allowed for localhost only): ${raw}`);
  }

  const audit = env.CADENCE_MCP_AUDIT_LOG?.trim();
  return {
    apiUrl: url.href.replace(/\/+$/, ""),
    email: /** @type {string} */ (env.CADENCE_EMAIL).trim(),
    password: /** @type {string} */ (env.CADENCE_PASSWORD),
    auditLog: audit === "off" ? null : audit || join(homedir(), ".cadence-mcp", "audit.jsonl"),
  };
}
