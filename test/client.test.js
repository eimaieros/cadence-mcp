import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { CadenceClient, CadenceError } from "../src/client.js";
import { ACCOUNT, startFakeCadence } from "./fake-cadence.js";

/** @type {Awaited<ReturnType<typeof startFakeCadence>>} */
let api;
/** @type {CadenceClient} */
let client;

before(async () => {
  api = await startFakeCadence();
});
after(() => api.close());

beforeEach(() => {
  for (const k of Object.keys(api.state.scenario)) delete api.state.scenario[/** @type {keyof typeof api.state.scenario} */ (k)];
  api.state.requests.length = 0;
  client = new CadenceClient({ baseUrl: api.url, ...ACCOUNT });
});

const newSession = () => client.createSession({ role_title: "Backend Engineer", seniority: "mid", focus_areas: [] });

/** @param {() => Promise<unknown>} fn */
async function failure(fn) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CadenceError, `expected a CadenceError, got ${err}`);
    return err;
  }
  assert.fail("expected the call to fail");
}

describe("authentication", () => {
  it("logs in on the first call and sends the bearer token", async () => {
    assert.equal(client.authenticated, false);
    await client.listSessions(5);
    assert.equal(client.authenticated, true);
    const call = api.state.requests.find((r) => r.path === "/sessions");
    assert.match(call?.auth ?? "", /^Bearer acc-/);
  });

  it("rotates the refresh token when the access token expires, and retries the call", async () => {
    await client.listSessions(5);
    const before = api.state.refreshes;
    api.state.expireAccess();

    await client.listSessions(5);

    assert.equal(api.state.refreshes, before + 1);
    const used = [...api.state.refresh.values()].filter((v) => v === "used").length;
    assert.ok(used >= 1, "the old refresh token must have been consumed");
  });

  it("refreshes once for any number of calls that hit the same expiry", async () => {
    // cadence rotates on every refresh, and a used refresh token is dead. Five
    // independent refreshes would leave four calls holding a spent token.
    const s = await newSession();
    const before = api.state.refreshes;
    api.state.expireAccess();

    await Promise.all(Array.from({ length: 5 }, () => client.getSession(s.id)));

    assert.equal(api.state.refreshes, before + 1);
  });

  it("logs in again when the refresh token is refused", async () => {
    await client.listSessions(5);
    const logins = api.state.logins;
    api.state.expireAccess();
    for (const k of api.state.refresh.keys()) api.state.refresh.set(k, "used");

    await client.listSessions(5);

    assert.equal(api.state.logins, logins + 1);
  });

  it("reports a wrong password as cadence worded it, without looping", async () => {
    const bad = new CadenceClient({ baseUrl: api.url, email: ACCOUNT.email, password: "wrong password" });
    const err = await failure(() => bad.listSessions(5));
    assert.equal(err.status, 401);
    assert.equal(err.message, "Incorrect email or password");
    assert.equal(api.state.requests.filter((r) => r.path === "/auth/login").length, 1);
  });
});

describe("errors a person can act on", () => {
  it("echoes the request ID the call was given", async () => {
    await client.listSessions(5, { requestId: "trace-123" });
    assert.ok(api.state.requests.some((r) => r.path === "/sessions" && r.requestId === "trace-123"));

    const err = await failure(() => client.getSession("7c0e6f9e-0000-4000-8000-000000000000", { requestId: "trace-404" }));
    assert.equal(err.status, 404);
    assert.equal(err.requestId, "trace-404");
  });

  it("flattens FastAPI validation errors into one sentence", async () => {
    const err = await failure(() => client.createSession({ role_title: "x" }));
    assert.equal(err.status, 422);
    assert.equal(err.message, "role_title: String should have at least 2 characters");
  });

  it("keeps Retry-After from a 429", async () => {
    api.state.scenario.rateLimitNext = 1;
    const err = await failure(() => client.listSessions(5));
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, 7);
  });

  it("turns a dead server into an error, not a hang", async () => {
    const dead = new CadenceClient({ baseUrl: "http://127.0.0.1:9", ...ACCOUNT, timeoutMs: 2000 });
    const err = await failure(() => dead.listSessions(5));
    assert.equal(err.status, 0);
    assert.match(err.message, /failed|timed out/);
  });
});

describe("the interviewer's tool audit", () => {
  it("reads it from /tool-calls, with the request ID it was given", async () => {
    const s = await newSession();
    await client.streamQuestion(s.id);

    const rows = await client.listToolCalls(s.id, { requestId: "rid-tools" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "get_coverage");
    const req = api.state.requests.find((r) => r.path === `/sessions/${s.id}/tool-calls`);
    assert.equal(req?.requestId, "rid-tools");
  });

  it("reports an unknown interview as a 404, not an empty audit", async () => {
    const err = await failure(() => client.listToolCalls("7c0e6f9e-0000-4000-8000-000000000000"));
    assert.equal(err.status, 404);
  });
});

describe("streaming the next question", () => {
  it("returns the question cadence stored", async () => {
    const s = await newSession();
    const q = await client.streamQuestion(s.id);
    assert.equal(q.content, api.state.question);
    assert.equal(q.index, 0);
    assert.equal(q.cost_usd, 0.001);
  });

  it("reads a CRLF stream that arrives one character at a time, behind a keep-alive", async () => {
    Object.assign(api.state.scenario, { lineEnding: "crlf", byteByByte: true, keepAlive: true });
    const s = await newSession();
    const q = await client.streamQuestion(s.id);
    assert.equal(q.content, api.state.question);
  });

  it("surfaces an error event with cadence's own words", async () => {
    api.state.scenario.streamError = "The interviewer is unavailable right now.";
    const s = await newSession();
    const err = await failure(() => client.streamQuestion(s.id));
    assert.equal(err.message, "The interviewer is unavailable right now.");
    assert.equal(err.status, 502);
  });

  it("does not mistake a stream that broke off for a question", async () => {
    api.state.scenario.streamCutOff = true;
    const s = await newSession();
    const err = await failure(() => client.streamQuestion(s.id));
    assert.match(err.message, /ended before the question was complete/);
  });

  it("recovers from an expired token before the first byte", async () => {
    const s = await newSession();
    api.state.expireAccess();
    const q = await client.streamQuestion(s.id);
    assert.equal(q.content, api.state.question);
  });

  it("reports a closed interview as a 409 with the reason", async () => {
    const s = await newSession();
    await client.streamQuestion(s.id);
    await client.submitAnswer(s.id, "We rolled back, then added a canary.");
    await client.completeSession(s.id);
    const err = await failure(() => client.streamQuestion(s.id));
    assert.equal(err.status, 409);
    assert.equal(err.message, "This session is already closed");
  });
});
