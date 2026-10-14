// @ts-check
/**
 * A small HTTP client for the cadence API.
 *
 * It does three things the tools should not have to think about:
 *
 * 1. Authentication. Logs in with the configured account, keeps the token pair
 *    in memory only, and recovers from an expired access token by rotating the
 *    refresh token. cadence rotates on every refresh and the old refresh token
 *    stops working the moment it is used, so two concurrent refreshes would
 *    leave one of them holding a dead token. Refreshes are therefore
 *    single-flight: everyone who hits a 401 at the same time waits for the
 *    same rotation.
 *
 * 2. Errors. Every non-2xx becomes a CadenceError that keeps what a person
 *    needs to act on it — the status, the API's own `detail` text, the
 *    request ID to find it in the server logs, and Retry-After on a 429.
 *
 * 3. Streaming. The next interview question arrives as server-sent events,
 *    token by token. A tool call returns one result, so the stream is read to
 *    the end here and the question comes back whole.
 */

import { SseParser } from "./sse.js";

/** Endpoints that must never trigger a token refresh on 401. */
const AUTH_PATHS = new Set(["/auth/login", "/auth/refresh", "/auth/logout", "/auth/register"]);

/** A question longer than this is not a question; stop paying for it. */
const MAX_STREAM_CHARS = 64 * 1024;

export class CadenceError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, requestId?: string | null, retryAfter?: number | null }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "CadenceError";
    /** HTTP status, or 0 when the request never got a response. */
    this.status = info.status ?? 0;
    this.requestId = info.requestId ?? null;
    /** Seconds the API asked us to wait (429 only). */
    this.retryAfter = info.retryAfter ?? null;
  }
}

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl
 * @property {string} email
 * @property {string} password
 * @property {typeof fetch} [fetch]
 * @property {number} [timeoutMs]       per request, default 30 s
 * @property {number} [streamTimeoutMs] for a whole streamed question, default 120 s
 */

/**
 * @typedef {object} CallOptions
 * @property {string} [requestId]  sent as X-Request-ID; cadence logs it and echoes it back
 */

export class CadenceClient {
  #base;
  #email;
  #password;
  #fetch;
  #timeoutMs;
  #streamTimeoutMs;

  /** @type {string | null} */
  #access = null;
  /** @type {string | null} */
  #refresh = null;
  /** @type {Promise<void> | null} */
  #renewing = null;

  /** @param {ClientOptions} opts */
  constructor(opts) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#email = opts.email;
    this.#password = opts.password;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#streamTimeoutMs = opts.streamTimeoutMs ?? 120_000;
  }

  // ------------------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------------------

  /** True once a token pair is held. Exposed for tests and diagnostics only. */
  get authenticated() {
    return this.#access !== null;
  }

  async #login() {
    const res = await this.#send("POST", "/auth/login", {
      body: { email: this.#email, password: this.#password },
      auth: false,
    });
    if (!res.ok) throw await toError(res, "Could not log in to cadence");
    this.#store(await res.json());
  }

  /**
   * Get a working token pair, whatever it takes: rotate the refresh token if we
   * have one, log in again if that fails. Single-flight — see the file header.
   */
  #renew() {
    if (this.#renewing) return this.#renewing;
    this.#renewing = (async () => {
      try {
        if (this.#refresh) {
          const res = await this.#send("POST", "/auth/refresh", {
            body: { refresh_token: this.#refresh },
            auth: false,
          });
          if (res.ok) {
            this.#store(await res.json());
            return;
          }
          // A refresh token that cadence refused is spent or revoked. Holding
          // on to it would make every later call fail the same way.
        }
        this.#access = null;
        this.#refresh = null;
        await this.#login();
      } finally {
        this.#renewing = null;
      }
    })();
    return this.#renewing;
  }

  /** @param {any} pair */
  #store(pair) {
    if (!pair || typeof pair.access_token !== "string" || typeof pair.refresh_token !== "string") {
      throw new CadenceError("cadence returned an unexpected token response");
    }
    this.#access = pair.access_token;
    this.#refresh = pair.refresh_token;
  }

  // ------------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------------

  /**
   * One HTTP exchange. No retries here; see #call.
   *
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, auth?: boolean, requestId?: string, signal?: AbortSignal, accept?: string }} [o]
   */
  async #send(method, path, o = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: o.accept ?? "application/json" };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.auth !== false && this.#access) headers.Authorization = `Bearer ${this.#access}`;
    if (o.requestId) headers["X-Request-ID"] = o.requestId;

    try {
      return await this.#fetch(`${this.#base}${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.signal ?? AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
      throw new CadenceError(`Request to cadence ${reason} (${method} ${path})`, {
        requestId: o.requestId ?? null,
      });
    }
  }

  /**
   * An authenticated call that survives an expired access token.
   *
   * Retrying after a 401 is safe for every method, mutations included: cadence
   * checks the token in a dependency that runs before the handler, so a 401
   * means nothing was written.
   *
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, requestId?: string, signal?: AbortSignal, accept?: string }} [o]
   */
  async #call(method, path, o = {}) {
    if (!this.#access) await this.#renew();
    const used = this.#access;
    let res = await this.#send(method, path, o);

    if (res.status === 401 && !AUTH_PATHS.has(path)) {
      // Another call may already have rotated the pair while this one was in
      // flight. Retry with the new token before spending a rotation of our own.
      if (this.#access === used) await this.#renew();
      res = await this.#send(method, path, o);
    }
    return res;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown } & CallOptions} [o]
   */
  async #json(method, path, o = {}) {
    const res = await this.#call(method, path, o);
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return null;
    return res.json();
  }

  // ------------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------------

  /** @param {number} limit @param {CallOptions} [o] */
  listSessions(limit, o = {}) {
    return this.#json("GET", `/sessions?limit=${encodeURIComponent(limit)}`, o);
  }

  /**
   * @param {{ role_title: string, seniority?: string, focus_areas?: string[] }} input
   * @param {CallOptions} [o]
   */
  createSession(input, o = {}) {
    return this.#json("POST", "/sessions", { ...o, body: input });
  }

  /** @param {string} id @param {CallOptions} [o] */
  getSession(id, o = {}) {
    return this.#json("GET", `/sessions/${encodeURIComponent(id)}`, o);
  }

  /** @param {string} id @param {CallOptions} [o] */
  getCost(id, o = {}) {
    return this.#json("GET", `/sessions/${encodeURIComponent(id)}/cost`, o);
  }

  /**
   * The interviewer's own tool calls for one session, oldest first — the audit
   * cadence keeps of what its model looked up before each question.
   *
   * @param {string} id
   * @param {CallOptions} [o]
   */
  listToolCalls(id, o = {}) {
    return this.#json("GET", `/sessions/${encodeURIComponent(id)}/tool-calls`, o);
  }

  /** @param {string} id @param {string} content @param {CallOptions} [o] */
  submitAnswer(id, content, o = {}) {
    return this.#json("POST", `/sessions/${encodeURIComponent(id)}/answers`, {
      ...o,
      body: { content },
    });
  }

  /** @param {string} id @param {CallOptions} [o] */
  completeSession(id, o = {}) {
    return this.#json("POST", `/sessions/${encodeURIComponent(id)}/complete`, o);
  }

  /** @param {string} id @param {CallOptions} [o] */
  deleteSession(id, o = {}) {
    return this.#json("DELETE", `/sessions/${encodeURIComponent(id)}`, o);
  }

  /**
   * Ask cadence for the next question and wait for all of it.
   *
   * The `done` event carries the question exactly as cadence stored it, so
   * that is what comes back — not the concatenated tokens, which would only
   * match if nothing was lost on the way.
   *
   * @param {string} id
   * @param {CallOptions} [o]
   * @returns {Promise<{ index: number, content: string, cost_usd: number }>}
   */
  async streamQuestion(id, o = {}) {
    const signal = AbortSignal.timeout(this.#streamTimeoutMs);
    const res = await this.#call("GET", `/sessions/${encodeURIComponent(id)}/stream`, {
      ...o,
      signal,
      accept: "text/event-stream",
    });
    if (!res.ok) throw await toError(res);
    if (!res.body) throw new CadenceError("cadence sent an empty stream", meta(res));

    const parser = new SseParser();
    const decoder = new TextDecoder();
    let streamed = 0;
    /** @type {{ index: number, content: string, cost_usd: number } | null} */
    let done = null;

    /** @param {import("./sse.js").SseEvent[]} events */
    const handle = (events) => {
      for (const e of events) {
        const data = safeJson(e.data);
        if (e.event === "token") {
          streamed += typeof data?.text === "string" ? data.text.length : 0;
          if (streamed > MAX_STREAM_CHARS) {
            throw new CadenceError("The question stream exceeded the size limit; stopped reading.", meta(res));
          }
        } else if (e.event === "error") {
          const detail = typeof data?.detail === "string" ? data.detail : "The interviewer failed mid-stream.";
          throw new CadenceError(detail, { ...meta(res), status: 502 });
        } else if (e.event === "done") {
          if (typeof data?.content !== "string") {
            throw new CadenceError("cadence ended the stream without the question text", meta(res));
          }
          done = { index: Number(data.index), content: data.content, cost_usd: Number(data.cost_usd ?? 0) };
        }
      }
    };

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
        if (done) break;
      }
      if (!done) handle(parser.push(decoder.decode()).concat(parser.flush()));
    } catch (err) {
      if (err instanceof CadenceError) throw err;
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new CadenceError(
        timedOut ? "The question stream timed out." : "The question stream broke off.",
        meta(res),
      );
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!done) throw new CadenceError("The question stream ended before the question was complete.", meta(res));
    return done;
  }
}

/** @param {Response} res */
function meta(res) {
  return { status: res.status, requestId: res.headers.get("x-request-id") };
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Turn a failed response into a CadenceError a person can act on.
 *
 * FastAPI sends `{"detail": "..."}` for errors the API raises itself and
 * `{"detail": [{loc, msg}, ...]}` for validation failures; both are flattened
 * into one readable sentence.
 *
 * @param {Response} res
 * @param {string} [fallback]
 */
async function toError(res, fallback) {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") detail = body.detail;
    else if (Array.isArray(body?.detail)) {
      detail = body.detail
        .map((/** @type {any} */ d) => [Array.isArray(d?.loc) ? d.loc.slice(1).join(".") : "", d?.msg].filter(Boolean).join(": "))
        .join("; ");
    }
  } catch {
    // Not JSON — a proxy error page, say. The status still says what happened.
  }
  const retry = Number(res.headers.get("retry-after"));
  return new CadenceError(detail || fallback || `cadence answered HTTP ${res.status}`, {
    ...meta(res),
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
  });
}
