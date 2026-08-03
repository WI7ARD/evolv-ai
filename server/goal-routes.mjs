export async function handleGoalRoutes(context) {
  const { req, res, url, authenticated, readBody, bodyLimit, json, goalRunner, agentRuntime, vaultService,
    writeStreamEvent, activeControllers, activeRunKey } = context;
  if (req.method === "POST" && url.pathname === "/api/agent-goals") {
    json(res, 201, await goalRunner.create(await readBody(req, bodyLimit)));
    return true;
  }
  const planMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/plan(?:\/(approve))?$/);
  if (planMatch) {
    const runId = decodeURIComponent(planMatch[1]);
    if (req.method === "PATCH" && !planMatch[2]) json(res, 200, goalRunner.revise(runId, (await readBody(req, bodyLimit)).plan));
    else if (req.method === "POST" && planMatch[2] === "approve") json(res, 200, await goalRunner.approve(runId));
    else return false;
    return true;
  }
  const actionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/(start|replan|artifacts)$/);
  if (actionMatch) {
    const runId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const run = agentRuntime.get(runId);
    if (!run || run.executor !== "goal-runner-v1") throw Object.assign(new Error("Goal run not found."), { status: 404, code: "RUN_NOT_FOUND" });
    if (action === "artifacts" && req.method === "GET") {
      json(res, 200, { artifacts: agentRuntime.listArtifacts(runId), journal: vaultService.journalForRun(runId) });
      return true;
    }
    if (action === "replan" && req.method === "POST") {
      json(res, 200, await goalRunner.replan(runId, await readBody(req, bodyLimit)));
      return true;
    }
    if (action === "start" && req.method === "POST") {
      await streamExecution({ ...context, runId, path: "start" });
      return true;
    }
  }
  const retryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/steps\/([^/]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const runId = decodeURIComponent(retryMatch[1]);
    const stepId = decodeURIComponent(retryMatch[2]);
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    try {
      const completed = await goalRunner.retry(runId, stepId, { onEvent: (event) => writeStreamEvent(res, event) });
      writeStreamEvent(res, { type: "completion", runId, state: completed.state, run: completed });
    } catch (error) { writeStreamEvent(res, { type: "error", runId, code: error.code || "GOAL_RETRY_ERROR", message: error.message }); }
    res.end();
    return true;
  }
  return false;
}

export async function streamGoalResume(context, runId) {
  return streamExecution({ ...context, runId, path: "resume" });
}

async function streamExecution({ req, res, authenticated, goalRunner, writeStreamEvent, activeControllers, activeRunKey, runId, path }) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  const controller = new AbortController();
  const key = activeRunKey(authenticated.session.userId, runId);
  activeControllers.set(key, controller);
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const completed = await goalRunner.execute(runId, { signal: controller.signal, onEvent: (event) => writeStreamEvent(res, event) });
    writeStreamEvent(res, { type: "completion", runId, state: completed.state, verified: completed.state === "completed", run: completed, path });
  } catch (error) {
    writeStreamEvent(res, { type: "error", runId, code: error.code || "GOAL_RUNNER_ERROR", message: error.message });
  } finally {
    activeControllers.delete(key);
    res.end();
  }
}
