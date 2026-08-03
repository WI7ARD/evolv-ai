import crypto from "node:crypto";

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  try { return value == null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function approvalError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export class ApprovalService {
  constructor(database) {
    this.database = database;
    this.db = database.raw;
  }

  create({ id = crypto.randomUUID(), kind, risk = "approval-write", resourceType, resourceId, toolRunId = null,
    conversationId = null, agentRunId = null, summary = "", before = {}, after = {}, metadata = {}, expiresAt = null,
    status = "pending", decidedAt = null, executedAt = null }) {
    const existing = toolRunId ? this.getByToolRun(toolRunId) : this.getByResource(resourceType, resourceId);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO approval_requests(id,kind,risk,status,resource_type,resource_id,tool_run_id,conversation_id,
        agent_run_id,summary,before_json,after_json,metadata_json,created_at,expires_at,decided_at,executed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, String(kind).slice(0, 80), risk, status, String(resourceType).slice(0, 80), String(resourceId).slice(0, 200),
      toolRunId, conversationId, agentRunId, String(summary || "").slice(0, 1000), JSON.stringify(before || {}),
      JSON.stringify(after || {}), JSON.stringify(metadata || {}), now(), expiresAt, decidedAt, executedAt);
    this.database.audit("approval.created", `Created ${kind} approval request`, {
      entityType: "approval-request", entityId: id, metadata: { risk, resourceType }
    });
    return this.get(id);
  }

  recordImmediate(item) {
    const stamp = now();
    return this.create({ ...item, status: "approved", decidedAt: stamp, executedAt: stamp,
      metadata: { ...(item.metadata || {}), explicitRequest: true } });
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id,kind,risk,status,resource_type AS resourceType,resource_id AS resourceId,tool_run_id AS toolRunId,
        conversation_id AS conversationId,agent_run_id AS agentRunId,summary,before_json AS beforeJson,
        after_json AS afterJson,metadata_json AS metadataJson,created_at AS createdAt,expires_at AS expiresAt,
        decided_at AS decidedAt,executed_at AS executedAt,result_json AS resultJson,error FROM approval_requests WHERE id=?
    `).get(id);
    if (!row) return null;
    row.before = parseJson(row.beforeJson); row.after = parseJson(row.afterJson); row.metadata = parseJson(row.metadataJson);
    row.result = parseJson(row.resultJson); delete row.beforeJson; delete row.afterJson; delete row.metadataJson; delete row.resultJson;
    return row;
  }

  getByToolRun(toolRunId) {
    const row = this.db.prepare("SELECT id FROM approval_requests WHERE tool_run_id=? ORDER BY created_at DESC LIMIT 1").get(toolRunId);
    return row ? this.get(row.id) : null;
  }

  getByResource(resourceType, resourceId) {
    if (!resourceType || !resourceId) return null;
    const row = this.db.prepare("SELECT id FROM approval_requests WHERE resource_type=? AND resource_id=? ORDER BY created_at DESC LIMIT 1")
      .get(resourceType, resourceId);
    return row ? this.get(row.id) : null;
  }

  resolve(request) {
    let current = typeof request === "string" ? this.get(request) : request;
    const visited = new Set();
    while (current?.metadata?.delegateApprovalId && !visited.has(current.id)) {
      visited.add(current.id);
      current = this.get(current.metadata.delegateApprovalId);
    }
    return current || null;
  }

  decide(id, decision, { executed = false, result = {}, error = "" } = {}) {
    const request = this.get(id);
    if (!request) throw approvalError("Approval request not found.", "APPROVAL_NOT_FOUND", 404);
    if (request.status !== "pending") throw approvalError("Approval request is no longer pending.", "APPROVAL_ALREADY_DECIDED");
    if (request.expiresAt && Date.parse(request.expiresAt) < Date.now()) {
      this.db.prepare("UPDATE approval_requests SET status='expired',decided_at=? WHERE id=?").run(now(), id);
      throw approvalError("Approval request expired.", "APPROVAL_EXPIRED");
    }
    if (!new Set(["approved", "rejected"]).has(decision)) throw approvalError("Decision must be approved or rejected.", "APPROVAL_DECISION_INVALID", 400);
    const stamp = now();
    this.db.prepare(`
      UPDATE approval_requests SET status=?,decided_at=?,executed_at=?,result_json=?,error=? WHERE id=?
    `).run(decision, stamp, executed ? stamp : null, JSON.stringify(result || {}), String(error || "").slice(0, 2000), id);
    this.database.audit(`approval.${decision}`, `${decision} ${request.kind} approval request`, {
      entityType: "approval-request", entityId: id, metadata: { resourceType: request.resourceType }
    });
    return this.get(id);
  }

  updateEvidence(id, { summary, before, after, metadata } = {}) {
    const request = this.get(id);
    if (!request || request.status !== "pending") return request;
    this.db.prepare(`UPDATE approval_requests SET summary=?,before_json=?,after_json=?,metadata_json=? WHERE id=?`).run(
      String(summary ?? request.summary).slice(0, 1000), JSON.stringify(before ?? request.before),
      JSON.stringify(after ?? request.after), JSON.stringify(metadata ?? request.metadata), id
    );
    return this.get(id);
  }

  markExecuted(id, result = {}) {
    const request = this.get(id);
    if (!request || request.status !== "approved") throw approvalError("Approval request is not approved.", "APPROVAL_NOT_APPROVED");
    this.db.prepare("UPDATE approval_requests SET executed_at=?,result_json=?,error='' WHERE id=?")
      .run(now(), JSON.stringify(result || {}), id);
    return this.get(id);
  }

  fail(id, error) {
    const request = this.get(id);
    if (!request || !["pending", "approved"].includes(request.status)) return request;
    this.db.prepare("UPDATE approval_requests SET status='failed',decided_at=?,error=? WHERE id=?")
      .run(now(), String(error?.message || error || "Approval execution failed.").slice(0, 2000), id);
    return this.get(id);
  }

  list({ status = "pending", limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = status
      ? this.db.prepare("SELECT id FROM approval_requests WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, bounded)
      : this.db.prepare("SELECT id FROM approval_requests ORDER BY created_at DESC LIMIT ?").all(bounded);
    return rows.map((row) => this.get(row.id));
  }
}
