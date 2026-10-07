// @ts-check
/**
 * The tools an assistant gets, and the rules they follow.
 *
 * Most of them are thin: list, start, ask, answer, read. Two are not, because
 * they do things a person should decide:
 *
 *   finish_interview  closes the session for good and spends model budget on
 *                     scoring it;
 *   delete_interview  removes the session and its scorecard, permanently.
 *
 * Before either runs, a human is asked. Where the client supports MCP
 * elicitation, the server asks directly and only a person can answer. Where it
 * does not, the tool refuses until it is called again with `confirm: true`,
 * and the README is explicit about what that does and does not prove.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redact } from "./audit.js";
import { CadenceError } from "./client.js";

const sessionId = z.uuid().describe("The interview's ID, as returned by start_interview or list_interviews.");

/**
 * @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer
 * @typedef {import("./client.js").CadenceClient} CadenceClient
 * @typedef {import("./audit.js").AuditLog} AuditLog
 * @typedef {{ content: { type: "text", text: string }[], isError?: boolean }} ToolResult
 */

/** Thrown inside a tool when the person said no. Not an error — a decision. */
class Declined extends Error {}

/**
 * @param {McpServer} server
 * @param {{ client: CadenceClient, audit: AuditLog, newRequestId?: () => string }} deps
 */
export function registerTools(server, { client, audit, newRequestId = randomUUID }) {
  /**
   * Run one tool call: give it a request ID, record it, and turn failures into
   * a result the model can read instead of an exception it cannot.
   *
   * @param {string} tool
   * @param {Record<string, unknown>} args
   * @param {(requestId: string) => Promise<string>} fn
   * @returns {Promise<ToolResult>}
   */
  async function run(tool, args, fn) {
    const request_id = newRequestId();
    const started = performance.now();
    const took = () => Math.round(performance.now() - started);
    try {
      const text = await fn(request_id);
      await audit.record({ tool, request_id, outcome: "ok", args: redact(args), duration_ms: took() });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (err instanceof Declined) {
        await audit.record({ tool, request_id, outcome: "declined", args: redact(args), duration_ms: took(), detail: err.message });
        return { content: [{ type: "text", text: err.message }] };
      }
      const status = err instanceof CadenceError ? err.status : undefined;
      const detail = err instanceof Error ? err.message : String(err);
      await audit.record({
        tool, request_id, outcome: "error", args: redact(args), duration_ms: took(),
        ...(status ? { status } : {}), detail,
      });
      return { content: [{ type: "text", text: explain(err, request_id) }], isError: true };
    }
  }

  /**
   * Ask a person, not the model. Returns normally on an explicit yes and throws
   * Declined on anything else — a decline, a cancel, a closed dialog.
   *
   * @param {string} message
   * @param {boolean | undefined} confirmArg
   * @param {string} retryHint  what the model should do to proceed without elicitation
   */
  async function confirm(message, confirmArg, retryHint) {
    const canAsk = Boolean(server.server.getClientCapabilities()?.elicitation);
    if (canAsk) {
      const answer = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Go ahead", description: "Tick to confirm." },
          },
          required: ["confirm"],
        },
      });
      if (answer.action === "accept" && answer.content?.confirm === true) return;
      throw new Declined("Not done: the user did not confirm.");
    }
    // No way to reach the person from here. Refuse, and hand the decision back
    // to the client, whose own tool-approval prompt is then what stands between
    // the model and the action.
    if (confirmArg !== true) {
      throw new Declined(`${message}\n\nNothing has been done yet. ${retryHint}`);
    }
  }

  server.registerTool(
    "list_interviews",
    {
      title: "List practice interviews",
      description: "List the account's practice interviews, newest first: ID, role, seniority, status and what each has cost.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("How many to return (1–100).") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run("list_interviews", args, async (rid) => {
        const rows = await client.listSessions(args.limit, { requestId: rid });
        if (!rows.length) return "No interviews yet. Start one with start_interview.";
        return [`${rows.length} interview${rows.length === 1 ? "" : "s"}:`, ...rows.map(summaryLine)].join("\n");
      }),
  );

  server.registerTool(
    "start_interview",
    {
      title: "Start a practice interview",
      description:
        "Create a new practice interview for a role. It starts empty: call ask_next_question to get the first question.",
      inputSchema: {
        role_title: z.string().trim().min(2).max(160).describe("The role to practise for, e.g. 'Backend Engineer'."),
        seniority: z.enum(["junior", "mid", "senior", "staff"]).default("mid"),
        focus_areas: z
          .array(z.string().trim().min(1).max(60))
          .max(6)
          .default([])
          .describe("Up to six topics to emphasise, e.g. ['PostgreSQL', 'API design']."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run("start_interview", args, async (rid) => {
        const s = await client.createSession(
          { role_title: args.role_title, seniority: args.seniority, focus_areas: args.focus_areas },
          { requestId: rid },
        );
        return `Started interview ${s.id} — ${s.role_title} (${s.seniority}). Call ask_next_question with this ID for the first question.`;
      }),
  );

  server.registerTool(
    "ask_next_question",
    {
      title: "Get the next interview question",
      description:
        "Have the interviewer ask its next question. Show it to the user exactly as returned and let them answer in their own words.",
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run("ask_next_question", args, async (rid) => {
        const q = await client.streamQuestion(args.session_id, { requestId: rid });
        return `${q.content}\n\n— Pass the user's own answer to submit_answer.`;
      }),
  );

  server.registerTool(
    "submit_answer",
    {
      title: "Submit the user's answer",
      description:
        "Record the user's answer to the last question. Submit what the user said, not a rewritten version — the scorecard is about them.",
      inputSchema: {
        session_id: sessionId,
        answer: z
          .string()
          .max(8000)
          .refine((s) => s.trim().length > 0, "The answer cannot be blank.")
          .describe("The answer, in the user's words (up to 8000 characters)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run("submit_answer", args, async (rid) => {
        const turn = await client.submitAnswer(args.session_id, args.answer, { requestId: rid });
        return `Answer recorded as turn ${turn.index}. Next: ask_next_question, or finish_interview to be scored.`;
      }),
  );

  server.registerTool(
    "get_interview",
    {
      title: "Read an interview",
      description: "The full transcript of an interview and, if it has been finished, its scorecard.",
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run("get_interview", args, async (rid) => {
        const s = await client.getSession(args.session_id, { requestId: rid });
        const lines = [`${s.role_title} (${s.seniority}) — ${s.status}, $${money(s.cost_usd)} spent`, ""];
        if (!s.turns.length) lines.push("No questions asked yet.");
        for (const t of s.turns) lines.push(`${t.speaker === "interviewer" ? "Interviewer" : "Candidate"}: ${t.content}`, "");
        if (s.scorecard) lines.push(scorecardText(s.scorecard));
        return lines.join("\n").trimEnd();
      }),
  );

  server.registerTool(
    "get_budget",
    {
      title: "Check an interview's budget",
      description: "How much of the interview's spend guardrail has been used. cadence stops asking questions once it is reached.",
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run("get_budget", args, async (rid) => {
        const c = await client.getCost(args.session_id, { requestId: rid });
        return `Spent $${money(c.spent_usd)} of the $${money(c.ceiling_usd)} guardrail; $${money(c.remaining_usd)} left.`;
      }),
  );

  server.registerTool(
    "finish_interview",
    {
      title: "Finish and score an interview",
      description:
        "Close the interview and have it scored. Irreversible — no more questions afterwards — and the scoring call is charged to the interview's budget, so the user is asked first.",
      inputSchema: {
        session_id: sessionId,
        confirm: z
          .boolean()
          .optional()
          .describe("Only for clients without elicitation: set true after the user has explicitly agreed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run("finish_interview", args, async (rid) => {
        const s = await client.getSession(args.session_id, { requestId: rid });
        // Finishing a finished interview just returns its scorecard: no cost,
        // nothing irreversible left to do, nothing to ask about.
        if (s.status !== "completed" || !s.scorecard) {
          const c = await client.getCost(args.session_id, { requestId: rid });
          await confirm(
            `Finish the "${s.role_title}" interview and have it scored? This closes it for good, and scoring is charged to its budget ($${money(c.spent_usd)} of $${money(c.ceiling_usd)} used so far).`,
            args.confirm,
            "Ask the user, and only if they agree call finish_interview again with confirm: true.",
          );
        }
        const card = await client.completeSession(args.session_id, { requestId: rid });
        return scorecardText(card);
      }),
  );

  server.registerTool(
    "delete_interview",
    {
      title: "Delete an interview",
      description: "Permanently delete an interview, its transcript and its scorecard. The user is asked first.",
      inputSchema: {
        session_id: sessionId,
        confirm: z
          .boolean()
          .optional()
          .describe("Only for clients without elicitation: set true after the user has explicitly agreed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run("delete_interview", args, async (rid) => {
        const s = await client.getSession(args.session_id, { requestId: rid });
        await confirm(
          `Permanently delete the "${s.role_title}" interview (${s.turns.length} turns${s.scorecard ? " and its scorecard" : ""})? This cannot be undone.`,
          args.confirm,
          "Ask the user, and only if they agree call delete_interview again with confirm: true.",
        );
        await client.deleteSession(args.session_id, { requestId: rid });
        return `Deleted the "${s.role_title}" interview.`;
      }),
  );
}

/** @param {any} s */
function summaryLine(s) {
  return `- ${s.id} · ${s.role_title} (${s.seniority}) · ${s.status} · $${money(s.cost_usd)} · started ${s.created_at}`;
}

/** @param {any} card */
function scorecardText(card) {
  const lines = [`Scorecard — overall ${card.overall}/100`, "", card.summary, ""];
  for (const d of card.dimensions ?? []) lines.push(`- ${d.name}: ${d.score}/5 — ${d.note}`);
  if (card.strengths?.length) lines.push("", "Strengths:", ...card.strengths.map((/** @type {string} */ s) => `- ${s}`));
  if (card.gaps?.length) lines.push("", "To work on:", ...card.gaps.map((/** @type {string} */ g) => `- ${g}`));
  return lines.join("\n");
}

/** @param {unknown} n */
function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(4) : "?";
}

/**
 * The error as the model should read it: what cadence said, what to do next,
 * and the request ID for anyone who has to look it up in the server logs.
 *
 * @param {unknown} err
 * @param {string} requestId
 */
function explain(err, requestId) {
  if (!(err instanceof CadenceError)) {
    return `Unexpected error: ${err instanceof Error ? err.message : String(err)} (request ${requestId}).`;
  }
  // cadence's own messages come with or without a full stop; ours follow them.
  const parts = [/[.!?]$/.test(err.message) ? err.message : `${err.message}.`];
  if (err.status === 404) parts.push("There is no interview with that ID on this account.");
  if (err.status === 429 && err.retryAfter) parts.push(`Rate limited: try again in ${err.retryAfter} s.`);
  parts.push(`(${err.status ? `HTTP ${err.status}, ` : ""}request ${err.requestId ?? requestId})`);
  return parts.join(" ");
}
