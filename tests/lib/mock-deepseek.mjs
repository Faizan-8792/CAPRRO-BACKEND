// tests/lib/mock-deepseek.mjs
//
// W10 AP16 (2026-10-17): a stand-in for the AI provider, on a loopback port, so a contract can exercise the drafting
// routes end to end without a network or a key. The provider service reads DEEPSEEK_URL when it is first imported, so
// ensureMockDeepSeek() must run before anything imports src/app.js; the harnesses do that.
//
//   const mock = await ensureMockDeepSeek();
//   mock.on(reply);   // the key is set; reply(body) -> the model's text
//   mock.off();       // the key is blank again (the production state)
//   mock.calls        // every request body the provider saw, newest last
//
// One server for the whole process (unref'd, so it never keeps the process alive).

import http from "node:http";

let singleton = null;

export async function ensureMockDeepSeek() {
  if (singleton) return singleton;
  const state = { calls: [], reply: () => "A draft.", status: 200, usage: null };
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    state.calls.push({ url: request.url, authorization: request.headers.authorization || "", body });
    if (state.status !== 200) {
      response.writeHead(state.status, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const content = state.reply(body);
    response.writeHead(200, { "content-type": "application/json" });
    // W11 IN2: usage is sent only when a test set it, so every existing suite sees the old body exactly.
    response.end(JSON.stringify({ choices: [{ message: { content } }], ...(state.usage ? { usage: state.usage } : {}) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  process.env.DEEPSEEK_URL = `http://127.0.0.1:${server.address().port}/chat/completions`;
  singleton = {
    get calls() {
      return state.calls;
    },
    reset() {
      state.calls.length = 0;
      state.status = 200;
      state.reply = () => "A draft.";
      state.usage = null;
    },
    // W11 IN2: the usage block DeepSeek reports with an answer (prompt_tokens, prompt_cache_hit_tokens,
    // prompt_cache_miss_tokens, completion_tokens), or null for none.
    usage(value) {
      state.usage = value || null;
    },
    on(reply) {
      state.status = 200;
      if (reply) state.reply = reply;
      process.env.DEEPSEEK_API_KEY = "mock-key-not-a-credential";
    },
    off() {
      process.env.DEEPSEEK_API_KEY = "";
    },
    fail(status = 500) {
      state.status = status;
    },
  };
  return singleton;
}
