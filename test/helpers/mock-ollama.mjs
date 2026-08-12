import http from "node:http";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scriptable stand-in for the Ollama HTTP API so streamed chat and tool
 * loops can be tested offline.
 *
 * `script(body, callIndex)` is invoked for every POST /api/chat and returns an
 * array of steps executed in order:
 *   { content: "..." }              stream a content delta
 *   { thinking: "..." }             stream a thinking delta
 *   { tool_calls: [...] }           stream tool calls
 *   { delayMs: 50 }                 pause between chunks
 *   { raw: "..." }                  write a raw line verbatim (malformed-line tests)
 *   "stall"                         stop writing but keep the socket open
 * The final chunk ({done:true}) is emitted automatically unless the script
 * stalled.
 */
export async function startMockOllama({ capabilities = ["completion", "tools"], models, script, failPull = false, failCreate = false } = {}) {
  let currentScript = script || (() => [{ content: "mock reply" }]);
  let currentCapabilities = capabilities;
  const chatRequests = [];
  // Model management mutates state the way the real thing does: a pull and a
  // create both leave a model behind that /api/tags then reports.
  let currentModels = models || [{ name: "mock-model", size: 1, details: { parameter_size: "1B", family: "mock" } }];
  const pullRequests = [];
  const createRequests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0-mock" }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: currentModels }));
      return;
    }
    if (req.url === "/api/pull") {
      pullRequests.push(body);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (failPull) {
        // Ollama reports most failures in the body of a 200, not in the status.
        res.end(`${JSON.stringify({ error: "max retries exceeded: connection reset" })}\n`);
        return;
      }
      const total = 2_000_000;
      res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
      for (const completed of [400_000, 1_200_000, total]) {
        res.write(`${JSON.stringify({ status: "pulling aa11bb22", digest: "sha256:aa11bb22", total, completed })}\n`);
      }
      res.write(`${JSON.stringify({ status: "success" })}\n`);
      currentModels = [...currentModels, { name: body.model, size: total, details: { parameter_size: "3B" } }];
      res.end();
      return;
    }
    if (req.url === "/api/create") {
      createRequests.push(body);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (failCreate) {
        res.end(`${JSON.stringify({ error: "invalid model reference" })}\n`);
        return;
      }
      res.write(`${JSON.stringify({ status: "using existing layer" })}\n`);
      res.write(`${JSON.stringify({ status: "writing manifest" })}\n`);
      res.write(`${JSON.stringify({ status: "success" })}\n`);
      currentModels = [...currentModels, { name: body.model, size: 2_000_000, details: { parameter_size: "3B" } }];
      res.end();
      return;
    }
    if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      // A created model remembers the prompt it was built with, which is how
      // Evolv tells a current model from one built before the prompt changed.
      const built = createRequests.find((request) => request.model === body.model);
      res.end(JSON.stringify({ capabilities: currentCapabilities, ...(built ? { system: built.system } : {}) }));
      return;
    }
    if (req.url === "/api/embed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      return;
    }
    if (req.url === "/api/chat") {
      chatRequests.push(body);
      const steps = currentScript(body, chatRequests.length - 1) || [];
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let stalled = false;
      try {
        for (const step of steps) {
          if (step === "stall") {
            stalled = true;
            break; // keep the socket open; the server's watchdog must fire
          }
          if (step.delayMs) {
            await delay(step.delayMs);
            continue;
          }
          if (step.raw != null) {
            res.write(`${step.raw}\n`);
            continue;
          }
          const message = { role: "assistant", content: "" };
          if (step.content) message.content = step.content;
          if (step.thinking) message.thinking = step.thinking;
          if (step.tool_calls) message.tool_calls = step.tool_calls;
          res.write(`${JSON.stringify({ model: body.model, message, done: false })}\n`);
        }
        if (!stalled) {
          res.write(`${JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true })}\n`);
          res.end();
        }
      } catch {
        // Client aborted mid-stream; nothing to clean up.
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown mock route" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    chatRequests,
    pullRequests,
    createRequests,
    installedModels: () => currentModels.map((model) => model.name),
    setModels(next) {
      currentModels = next;
    },
    setScript(fn) {
      currentScript = fn;
    },
    setCapabilities(next) {
      currentCapabilities = next;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
