import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  CADENCE_API_URL: "https://cadence.example.test/",
  CADENCE_EMAIL: " candidate@example.test ",
  CADENCE_PASSWORD: "correct horse battery",
};

describe("configuration", () => {
  it("names every missing variable at once", () => {
    assert.throws(() => loadConfig({}), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CADENCE_API_URL, CADENCE_EMAIL, CADENCE_PASSWORD/);
      return true;
    });
  });

  it("refuses to send a password over plain http to another machine", () => {
    assert.throws(() => loadConfig({ ...base, CADENCE_API_URL: "http://cadence.example.test" }), /must use https/);
  });

  it("allows plain http to this machine, for local development", () => {
    assert.equal(loadConfig({ ...base, CADENCE_API_URL: "http://localhost:8000/" }).apiUrl, "http://localhost:8000");
    assert.equal(loadConfig({ ...base, CADENCE_API_URL: "http://127.0.0.1:8000" }).apiUrl, "http://127.0.0.1:8000");
  });

  it("normalises the URL and trims the email, but not the password", () => {
    const c = loadConfig({ ...base, CADENCE_PASSWORD: " spaces count " });
    assert.equal(c.apiUrl, "https://cadence.example.test");
    assert.equal(c.email, "candidate@example.test");
    assert.equal(c.password, " spaces count ");
  });

  it("rejects something that is not a URL", () => {
    assert.throws(() => loadConfig({ ...base, CADENCE_API_URL: "cadence" }), /not a URL/);
  });

  it("keeps an audit log by default, where it can be switched off or moved", () => {
    assert.equal(loadConfig(base).auditLog, join(homedir(), ".cadence-mcp", "audit.jsonl"));
    assert.equal(loadConfig({ ...base, CADENCE_MCP_AUDIT_LOG: "off" }).auditLog, null);
    assert.equal(loadConfig({ ...base, CADENCE_MCP_AUDIT_LOG: "/var/log/x.jsonl" }).auditLog, "/var/log/x.jsonl");
  });
});
