// The same cases as cadence's frontend/lib/sse.test.ts, on the same parser.
// If the two ever disagree, one of the two clients has a bug the other fixed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser } from "../src/sse.js";

/** @param {string[]} chunks */
const feed = (chunks) => {
  const p = new SseParser();
  const out = chunks.flatMap((c) => p.push(c));
  return [...out, ...p.flush()];
};

/** The single event a test expected, or a failure that says so. @param {string[]} chunks */
const one = (chunks) => {
  const events = feed(chunks);
  assert.equal(events.length, 1);
  return events[0];
};

describe("frames", () => {
  it("reads one complete event", () => {
    assert.deepEqual(feed(['event: token\ndata: {"t":"hi"}\n\n']), [{ event: "token", data: '{"t":"hi"}' }]);
  });

  it("reads several events out of one chunk", () => {
    const events = feed(['event: token\ndata: {"t":"a"}\n\nevent: token\ndata: {"t":"b"}\n\n']);
    assert.deepEqual(events.map((e) => e.data), ['{"t":"a"}', '{"t":"b"}']);
  });

  it("defaults to `message` when the frame omits event:", () => {
    assert.deepEqual(feed(["data: plain\n\n"]), [{ event: "message", data: "plain" }]);
  });

  it("joins repeated data: lines with newlines, per spec", () => {
    assert.deepEqual(feed(["data: one\ndata: two\n\n"]), [{ event: "message", data: "one\ntwo" }]);
  });

  it("ignores comment lines", () => {
    assert.deepEqual(feed([": keep-alive\n\n", 'data: {"t":"x"}\n\n']), [{ event: "message", data: '{"t":"x"}' }]);
  });

  it("emits nothing for a frame with no data", () => {
    assert.deepEqual(feed(["event: token\n\n"]), []);
  });
});

describe("TCP does not respect message boundaries", () => {
  it("holds a partial event until the rest arrives", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('event: token\ndata: {"t":"wal'), []);
    assert.deepEqual(p.push('k"}\n\n'), [{ event: "token", data: '{"t":"walk"}' }]);
  });

  it("survives a split inside the separator itself", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: {"t":"a"}\n'), []);
    assert.deepEqual(p.push('\ndata: {"t":"b"}\n\n'), [
      { event: "message", data: '{"t":"a"}' },
      { event: "message", data: '{"t":"b"}' },
    ]);
  });

  it("survives one byte at a time", () => {
    const source = 'event: token\ndata: {"t":"slow"}\n\nevent: done\ndata: {}\n\n';
    const p = new SseParser();
    const out = [...source].flatMap((c) => p.push(c));
    assert.deepEqual(out, [
      { event: "token", data: '{"t":"slow"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("does not lose an event the server never terminated", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('event: done\ndata: {"ok":true}'), []);
    assert.deepEqual(p.flush(), [{ event: "done", data: '{"ok":true}' }]);
  });

  it("flushes nothing when the stream ended cleanly", () => {
    const p = new SseParser();
    p.push('data: {"t":"x"}\n\n');
    assert.deepEqual(p.flush(), []);
  });
});

describe("line endings", () => {
  it("reads CRLF", () => {
    assert.deepEqual(feed(['event: token\r\ndata: {"t":"hi"}\r\n\r\n']), [{ event: "token", data: '{"t":"hi"}' }]);
  });

  it("keeps a CRLF pair intact when the chunk boundary splits it", () => {
    const p = new SseParser();
    assert.deepEqual(p.push("event: token\r"), []);
    assert.deepEqual(p.push('\ndata: {"t":"hi"}\r\n\r\n'), [{ event: "token", data: '{"t":"hi"}' }]);
  });

  it("reads bare CR", () => {
    assert.deepEqual(feed(['event: token\rdata: {"t":"hi"}\r\r']), [{ event: "token", data: '{"t":"hi"}' }]);
  });

  it("reads a stream that mixes them", () => {
    assert.deepEqual(feed(["data: a\r\n\r\ndata: b\n\n"]).map((e) => e.data), ["a", "b"]);
  });

  it("keeps a \\r from ending up inside a value", () => {
    const e = one(['data: {"t":"x"}\r\n\r\n']);
    assert.equal(e.data, '{"t":"x"}');
    assert.equal(JSON.parse(e.data).t, "x");
  });
});

describe("field parsing", () => {
  it("strips exactly one leading space, not the rest", () => {
    const e = one(['data: {"t":"  two"}\n\n']);
    assert.equal(JSON.parse(e.data).t, "  two");
  });

  it("accepts a field with no space after the colon", () => {
    assert.deepEqual(feed(["data:tight\n\n"]), [{ event: "message", data: "tight" }]);
  });

  it("keeps colons inside the value", () => {
    const e = one(['data: {"url":"https://x.test/a"}\n\n']);
    assert.equal(JSON.parse(e.data).url, "https://x.test/a");
  });

  it("ignores fields it does not know", () => {
    assert.deepEqual(feed(["id: 7\nretry: 3000\ndata: x\n\n"]), [{ event: "message", data: "x" }]);
  });
});
