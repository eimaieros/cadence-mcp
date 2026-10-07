# cadence-mcp

![62 tests](https://img.shields.io/badge/tests-62-brightgreen)
![Node 22+](https://img.shields.io/badge/node-22%2B-blue)
![MIT](https://img.shields.io/badge/license-MIT-lightgrey)

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant run a
[cadence](https://github.com/eimaieros/cadence) practice interview: start one,
get the next question, submit the user's answer, have it scored. The two
actions that cannot be undone — scoring, which closes the interview and spends
its budget, and deleting it — are confirmed by a person, not by the model.

```text
You      Let's practise for a backend role. PostgreSQL and API design.
Claude   start_interview → ask_next_question
         "Walk me through a system you've shipped that had real users on it…"
You      (your answer, in your words)
Claude   submit_answer → ask_next_question → …
You      That's enough, score me.
Claude   finish_interview
         ┌ Finish the "Backend Engineer" interview and have it scored? This closes
         │ it for good, and scoring is charged to its budget ($0.0019 of $0.5000 used).
         └ [x] Go ahead
         Scorecard — overall 68/100 …
```

## Tools

| Tool | What it does | Asks first |
|---|---|---|
| `list_interviews` | The account's interviews, newest first, with status and cost | — |
| `start_interview` | A new interview for a role, seniority and up to six focus areas | — |
| `ask_next_question` | Streams the interviewer's next question and returns it whole | — |
| `submit_answer` | Records the user's answer to the last question | — |
| `get_interview` | Transcript and, once finished, the scorecard | — |
| `get_budget` | Spend against the interview's guardrail | — |
| `finish_interview` | Closes the interview and scores it | **yes** |
| `delete_interview` | Deletes the interview and its scorecard, permanently | **yes** |

Inputs are validated against the same limits cadence enforces (a role title of
2–160 characters, at most six focus areas, an answer of up to 8000 characters
that is not blank, a UUID for the ID), so a bad call fails before it costs a
round trip — and an ID like `../../auth/me` never becomes part of a URL.

## Configuration

| Variable | |
|---|---|
| `CADENCE_API_URL` | Where cadence runs. `https://…`, or plain `http://` to localhost only — the password and tokens travel on every call. |
| `CADENCE_EMAIL`, `CADENCE_PASSWORD` | The cadence account the assistant acts as. Use one made for this. |
| `CADENCE_MCP_AUDIT_LOG` | Optional. Path of the audit log; `off` to disable. Default `~/.cadence-mcp/audit.jsonl`. |

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cadence": {
      "command": "node",
      "args": ["/absolute/path/to/cadence-mcp/src/server.js"],
      "env": {
        "CADENCE_API_URL": "http://localhost:8000",
        "CADENCE_EMAIL": "you@example.com",
        "CADENCE_PASSWORD": "…"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add cadence \
  -e CADENCE_API_URL=http://localhost:8000 \
  -e CADENCE_EMAIL=you@example.com \
  -e CADENCE_PASSWORD='…' \
  -- node /absolute/path/to/cadence-mcp/src/server.js
```

cadence itself runs with `docker compose up` and no API key at all: a scripted
interviewer takes the same code paths, which is enough to try everything here.

## Decisions worth defending

### A person confirms, and the fallback says what it proves

An assistant that can call `delete_interview` can call it by mistake, and a
model that has been told "ask the user first" can decide the user already
agreed. So the server asks, through MCP **elicitation**: the client shows the
person a dialog, and only an explicit "yes" from that dialog lets the call
through. A decline or a dismissed dialog is a no, and is recorded as
`declined`.

Not every client supports elicitation. There, the tool refuses and says why,
and only goes ahead when called again with `confirm: true`. That is weaker,
and the code does not pretend otherwise: it proves the model was shown the
consequences, not that a person agreed. In that mode the human gate is the
client's own per-tool approval prompt, which is why both risky tools carry
honest annotations (`destructiveHint` on delete) for clients that use them to
decide when to ask.

Finishing an interview that is already scored asks nothing: cadence returns the
stored scorecard, nothing is charged and nothing irreversible is left to do.

### Refresh tokens rotate, so refreshing is single-flight

cadence issues a new refresh token on every refresh and the old one stops
working the moment it is used. When an access token expires, every call in
flight gets a 401 at once. If each refreshed on its own, the first would win
and the rest would present a token that was already spent. Here they all wait
for one rotation; a call that finds the token already rotated retries with the
new one instead of rotating again. If the refresh itself is refused, the
server logs in again with the configured account. Tokens live in memory only.

A retry after a 401 is safe even for `submit_answer`: cadence checks the token
in a dependency that runs before the handler, so a 401 means nothing was
written.

### The question comes back whole, and from `done`

cadence streams the question as server-sent events, token by token; an MCP tool
returns one result. The client reads the stream to the end and returns the text
from the `done` event — the question exactly as cadence stored it — rather than
its own concatenation of the tokens. The SSE parser is cadence's front-end
parser, ported line for line with its tests, because the bug that parser was
written to fix (CRLF line endings never matching `"\n\n"`, so no event is ever
emitted) is not one to rediscover in a second client of the same API. The
stream also has a hard timeout and a size limit: a question that never ends is
not a question.

### The audit log, and the bug it found

Every tool call appends one JSON line — tool, outcome (`ok`, `error`,
`declined`), arguments, duration and a request ID. The same ID goes to cadence
as `X-Request-ID`, so one call can be followed into the API's logs. Answers are
recorded as their length, never their text: an audit trail needs to show that
an answer was submitted, not what a person said in an interview.

Following those IDs into cadence's logs is how a cadence bug turned up: every
access-log line said `"request_id": "-"`, because the ID was reset one
statement before the line that exists to carry it. The response header was
right; nothing compared the two. [Fixed in cadence](https://github.com/eimaieros/cadence/commits/main),
with the test extended to check the log line as well as the header.

### stdout is the protocol

Desktop clients start this server over stdio, so stdout carries MCP messages
and nothing else. Every diagnostic goes to stderr, and the startup check runs
before the transport opens: a missing variable is one sentence on stderr and
exit code 1, not a malformed message the client cannot explain. There is a test
for exactly that.

### The assistant relays the interview; it does not sit it

The server's instructions and the tool descriptions say it plainly: show each
question as returned, submit the user's own answer, never answer on the user's
behalf or polish the answer first. A scorecard of the model's answers would be
worthless, and the tools are where that rule can be stated to every client at
once.

## Tests

62 tests, no network: the tools run through the real MCP protocol (the SDK's
client, over a linked in-memory transport) against a fake cadence on a local
socket that implements the parts of the contract a client depends on —
status codes, FastAPI's error bodies, refresh-token rotation, `Retry-After`,
and an SSE stream that can be told to arrive one character at a time, with CRLF,
behind a keep-alive, cut off, or with an error event.

The fake is only as good as its fidelity, so the whole flow was also run
against the real cadence backend with `tools/e2e.mjs`: the server started as a
real process over stdio, a full interview, both confirmations, the 409 and the
404. Run it before trusting a change to either side.

```bash
npm ci
npm test                    # the suite
npm run check               # tsc --strict over the JavaScript
node tools/contagem.js      # the count above is checked, not typed
```

## License

MIT.
