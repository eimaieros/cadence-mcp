// A stand-in for the cadence API, on a real socket.
//
// It implements the part of the contract this server uses, with the details
// that matter to a client: the status codes cadence sends, the shape of its
// error bodies, refresh-token rotation (a refresh token works exactly once),
// the X-Request-ID echo, Retry-After on 429, and an SSE stream that can be
// told to misbehave in the ways real ones do.
//
// The shapes follow cadence's backend/app/schemas.py and routers/; where the
// two could drift, the tests in client.test.js pin the behaviour this client
// depends on.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const ACCOUNT = { email: "candidate@example.test", password: "correct horse battery" };

/**
 * @typedef {object} Scenario
 * @property {"lf" | "crlf"} [lineEnding]
 * @property {boolean} [byteByByte]       write the stream one character per chunk
 * @property {boolean} [keepAlive]        send a `: keep-alive` comment first
 * @property {string} [streamError]       emit an `error` event instead of finishing
 * @property {boolean} [streamCutOff]     close the stream before the `done` event
 * @property {number} [rateLimitNext]     answer the next N session calls with 429
 */

export async function startFakeCadence() {
  /** @type {Scenario} */
  const scenario = {};
  const state = {
    scenario,
    /** @type {{ method: string, path: string, auth: string | null, requestId: string | null }[]} */
    requests: [],
    /** access token -> valid? */
    access: new Map(),
    /** refresh token -> "live" | "used" */
    refresh: new Map(),
    /** @type {Map<string, any>} */
    sessions: new Map(),
    logins: 0,
    refreshes: 0,
    scoringCalls: 0,
    question: "Tell me about a time a production system failed on your watch. What did you change afterwards?",
    /** Make every access token issued so far stop working, as if it expired. */
    expireAccess() {
      for (const k of state.access.keys()) state.access.set(k, false);
    },
  };

  const issue = () => {
    const a = `acc-${randomUUID()}`;
    const r = `ref-${randomUUID()}`;
    state.access.set(a, true);
    state.refresh.set(r, "live");
    return { access_token: a, refresh_token: r, token_type: "bearer", expires_in: 900 };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const rid = /** @type {string | undefined} */ (req.headers["x-request-id"]) ?? randomUUID();
    const auth = req.headers.authorization ?? null;
    state.requests.push({ method: req.method ?? "", path, auth, requestId: req.headers["x-request-id"]?.toString() ?? null });

    /** @param {number} code @param {unknown} [body] @param {Record<string, string>} [extra] */
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", "X-Request-ID": rid, ...extra });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const body = await readJson(req);

    // --- auth ---------------------------------------------------------------
    if (req.method === "POST" && path === "/auth/login") {
      if (body?.email !== ACCOUNT.email || body?.password !== ACCOUNT.password) {
        return send(401, { detail: "Incorrect email or password" });
      }
      state.logins++;
      return send(200, issue());
    }
    if (req.method === "POST" && path === "/auth/refresh") {
      const tok = body?.refresh_token;
      if (state.refresh.get(tok) !== "live") return send(401, { detail: "Invalid refresh token" });
      state.refresh.set(tok, "used");
      state.refreshes++;
      return send(200, issue());
    }

    // --- everything else needs a valid bearer token ------------------------
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || state.access.get(token) !== true) {
      return send(401, { detail: "Could not validate credentials" }, { "WWW-Authenticate": "Bearer" });
    }
    if (scenario.rateLimitNext && path.startsWith("/sessions")) {
      scenario.rateLimitNext--;
      return send(429, { detail: "Too many requests" }, { "Retry-After": "7" });
    }

    if (path === "/sessions" && req.method === "POST") {
      const errs = [];
      if (typeof body?.role_title !== "string" || body.role_title.trim().length < 2) {
        errs.push({ loc: ["body", "role_title"], msg: "String should have at least 2 characters" });
      }
      if (errs.length) return send(422, { detail: errs });
      const s = {
        id: randomUUID(),
        role_title: body.role_title.trim(),
        seniority: body.seniority ?? "mid",
        focus_areas: body.focus_areas ?? [],
        status: "active",
        cost_usd: 0,
        created_at: new Date().toISOString(),
        completed_at: null,
        turns: [],
        scorecard: null,
      };
      state.sessions.set(s.id, s);
      const { turns, scorecard, ...summary } = s;
      return send(201, summary);
    }
    if (path === "/sessions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const rows = [...state.sessions.values()].reverse().slice(0, limit).map(({ turns, scorecard, ...s }) => s);
      return send(200, rows);
    }

    const m = path.match(/^\/sessions\/([^/]+)(\/[a-z]+)?$/);
    const s = m ? state.sessions.get(m[1]) : undefined;
    if (!m || !s) return send(404, { detail: "Session not found" });
    const action = m[2] ?? "";

    if (action === "" && req.method === "GET") return send(200, s);
    if (action === "" && req.method === "DELETE") {
      state.sessions.delete(s.id);
      return send(204);
    }
    if (action === "/cost") {
      return send(200, { spent_usd: s.cost_usd, ceiling_usd: 0.5, remaining_usd: Math.max(0, 0.5 - s.cost_usd) });
    }
    if (action === "/answers" && req.method === "POST") {
      if (s.status !== "active") return send(409, { detail: "This session is already closed" });
      const turn = { id: randomUUID(), index: s.turns.length, speaker: "candidate", content: body.content, created_at: new Date().toISOString() };
      s.turns.push(turn);
      return send(201, turn);
    }
    if (action === "/complete" && req.method === "POST") {
      if (s.status === "completed" && s.scorecard) return send(200, s.scorecard);
      if (!s.turns.some((/** @type {any} */ t) => t.speaker === "candidate")) {
        return send(400, { detail: "Answer at least one question before ending the session." });
      }
      state.scoringCalls++;
      s.cost_usd += 0.02;
      s.status = "completed";
      s.completed_at = new Date().toISOString();
      s.scorecard = {
        overall: 72,
        summary: "Clear structure; thin on measurement.",
        dimensions: [{ name: "Communication", score: 4, note: "Concrete and ordered." }],
        strengths: ["Owned the incident"],
        gaps: ["No numbers on impact"],
        created_at: new Date().toISOString(),
      };
      return send(200, s.scorecard);
    }
    if (action === "/stream" && req.method === "GET") {
      if (s.status !== "active") return send(409, { detail: "This session is already closed" });
      return stream(res, rid, s, state);
    }
    return send(405, { detail: "Method Not Allowed" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    // fetch keeps sockets alive between calls; without closing them first, the
    // server waits out their idle timeout and the test run stalls on exit.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/**
 * The interviewer's question as cadence streams it: `start`, a `token` per
 * word, then `done` with the stored text and the call's cost.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} rid
 * @param {any} s
 * @param {any} state
 */
async function stream(res, rid, s, state) {
  const sc = state.scenario;
  const nl = sc.lineEnding === "crlf" ? "\r\n" : "\n";
  /** @param {string} event @param {unknown} data */
  const frame = (event, data) => `event: ${event}${nl}data: ${JSON.stringify(data)}${nl}${nl}`;
  const index = s.turns.length;
  const words = state.question.split(/(?<= )/);

  let out = "";
  if (sc.keepAlive) out += `: keep-alive${nl}${nl}`;
  out += frame("start", { index });
  for (const w of words) out += frame("token", { text: w });
  if (sc.streamError) out += frame("error", { detail: sc.streamError });
  else if (!sc.streamCutOff) {
    s.turns.push({ id: "q", index, speaker: "interviewer", content: state.question, created_at: new Date().toISOString() });
    s.cost_usd += 0.001;
    out += frame("done", { index, content: state.question, cost_usd: 0.001 });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Request-ID": rid });
  const chunks = sc.byteByByte ? [...out] : out.match(/[\s\S]{1,17}/g) ?? [];
  for (const c of chunks) {
    res.write(c);
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}

/** @param {import("node:http").IncomingMessage} req */
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
