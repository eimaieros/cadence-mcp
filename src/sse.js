// @ts-check
/**
 * Server-sent events, parsed as a pure function of the text that arrived.
 *
 * This is the parser from cadence's own front end (`frontend/lib/sse.ts`),
 * ported to plain JavaScript and kept behaviourally identical on purpose. The
 * front end earned it the hard way: the first version split on "\n\n" and
 * nothing else, and a server or proxy that ends lines with "\r\n" sends
 * "\r\n\r\n" between events — which never contains "\n\n", so no event is ever
 * emitted and the stream looks hung while the answer streams in full.
 *
 * Two clients of one API reading the same wire format with two different
 * parsers is how one of them ends up with the bug the other already fixed.
 * Same code, same tests.
 */

/**
 * @typedef {object} SseEvent
 * @property {string} event `event:` field, or "message" when the frame omits it.
 * @property {string} data  `data:` lines joined with "\n", per the spec.
 */

export class SseParser {
  #buffer = "";
  #pendingCR = false;

  /**
   * Feed one chunk; get back the events it completed.
   *
   * Whatever follows the last blank line is a partial event and waits for the
   * next chunk — TCP does not respect message boundaries.
   *
   * @param {string} chunk
   * @returns {SseEvent[]}
   */
  push(chunk) {
    // A CRLF pair can be split across chunks. Hold a trailing CR until the next
    // push, so it cannot become one newline here and a second one at the start
    // of the next chunk, which would invent a blank line and end an event early.
    let normalised = "";
    if (this.#pendingCR) {
      normalised = "\n";
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      this.#pendingCR = false;
    }
    if (chunk.endsWith("\r")) {
      this.#pendingCR = true;
      chunk = chunk.slice(0, -1);
    }
    normalised += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.#buffer += normalised;

    const parts = this.#buffer.split("\n\n");
    this.#buffer = parts.pop() ?? "";

    /** @type {SseEvent[]} */
    const out = [];
    for (const part of parts) {
      const e = parseFrame(part);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * What is left when the stream ends. A server that closes right after its
   * last `data:` line leaves a complete event in the buffer; dropping it would
   * lose the last answer of a conversation.
   *
   * @returns {SseEvent[]}
   */
  flush() {
    if (this.#pendingCR) {
      this.#buffer += "\n";
      this.#pendingCR = false;
    }
    const rest = this.#buffer;
    this.#buffer = "";
    const e = rest.trim() ? parseFrame(rest) : null;
    return e ? [e] : [];
  }
}

/**
 * One frame (the text between two blank lines) into an event, or null.
 *
 * @param {string} frame
 * @returns {SseEvent | null}
 */
function parseFrame(frame) {
  let event = "message";
  /** @type {string[]} */
  const data = [];

  for (const line of frame.split("\n")) {
    // A line starting with ":" is a comment — keep-alives from servers and
    // proxies. Treating one as data would hand JSON.parse something that was
    // never meant for it.
    if (line.startsWith(":")) continue;

    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    // Exactly one leading space is stripped, per spec; the rest is the value.
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value.trim();
    else if (field === "data") data.push(value);
  }

  if (!data.length) return null;
  return { event, data: data.join("\n") };
}
