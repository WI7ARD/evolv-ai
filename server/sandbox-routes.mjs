// Sandbox HTTP surface.
//
// One rule shapes this module: no route here writes to the real workspace.
// Promotion is deliberately absent — it happens only by deciding the approval
// that `propose_sandbox_promotion` raises, through the existing
// /api/tool-runs/:id/decision endpoint. Adding a "promote" route here would
// create a second path to disk that bypasses the approval envelope, which is
// exactly the property the sandbox exists to guarantee.

import { perceive } from "../lib/world.mjs";

export async function handleSandboxRoutes(context) {
  const { req, res, url, readBody, bodyLimit, json, sandboxService } = context;

  if (req.method === "GET" && url.pathname === "/api/sandboxes") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    json(res, 200, { sessions: sandboxService.list({ limit }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sandboxes") {
    const body = await readBody(req, bodyLimit);
    if (typeof body.projectId !== "string" || !body.projectId.trim()) {
      throw Object.assign(new Error("A project is required to open a sandbox."), { status: 400, code: "PROJECT_REQUIRED" });
    }
    json(res, 201, await sandboxService.open({
      projectId: body.projectId,
      objective: String(body.objective || "").slice(0, 2000),
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null
    }));
    return true;
  }

  const match = url.pathname.match(/^\/api\/sandboxes\/([^/]+)(?:\/(files|validate|objects|world))?$/);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1]);
  const action = match[2] || "";

  if (req.method === "GET" && !action) {
    json(res, 200, sandboxService.get(sessionId));
    return true;
  }
  if (req.method === "GET" && action === "world") {
    // A spatial reading of the same session. Derived, never stored.
    json(res, 200, perceive(sandboxService.get(sessionId)));
    return true;
  }
  if (req.method === "GET" && action === "objects") {
    json(res, 200, sandboxService.objects(sessionId));
    return true;
  }
  if (req.method === "POST" && action === "files") {
    const body = await readBody(req, bodyLimit);
    json(res, 200, await sandboxService.applyEdit(sessionId, {
      path: body.path, content: body.content, summary: String(body.summary || "").slice(0, 500)
    }));
    return true;
  }
  if (req.method === "POST" && action === "validate") {
    const body = await readBody(req, bodyLimit);
    json(res, 200, await sandboxService.validate(sessionId, {
      scripts: Array.isArray(body.scripts) ? body.scripts : []
    }));
    return true;
  }
  if (req.method === "DELETE" && !action) {
    json(res, 200, await sandboxService.discard(sessionId, "discarded from the workspace"));
    return true;
  }
  return false;
}
