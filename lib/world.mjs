import crypto from "node:crypto";

// The Evolv world: a spatial reading of what a simulation actually contains.
//
// This module deliberately holds no state of its own. Every object, position,
// relationship and sprite mood is derived from a sandbox session that really
// exists, so the world cannot show work that did not happen. A renderer that
// invented its own state — an agent walking toward a file nobody edited, a
// progress animation with no run behind it — would be a lie told in a product
// whose entire claim is that it does not lie about what it did. Keeping the
// derivation here, and keeping it pure, is what makes that structural rather
// than a matter of discipline.
//
// Layout is deterministic: the same session always produces the same map, so
// objects do not wander between frames and a screenshot means something.

export const WORLD_VERSION = 1;

export const ZONES = Object.freeze({
  library: { id: "library", label: "Project", x: 0, y: 0, width: 34, height: 100 },
  workbench: { id: "workbench", label: "Workbench", x: 34, y: 0, width: 40, height: 100 },
  testbench: { id: "testbench", label: "Checks", x: 74, y: 0, width: 26, height: 100 }
});

export const OBJECT_TYPES = Object.freeze([
  "project", "file", "check", "agent"
]);

// A skill is a declarative capability: what it is for, which tools it needs,
// and when it is available. Skills never execute anything themselves — they
// describe what the agent may attempt, and the tool layer remains the only
// thing that acts.
export const SKILLS = Object.freeze([
  { id: "navigate", label: "Navigate", summary: "Read the layout of a simulation and choose what to work on.", tools: [], requires: [] },
  { id: "organize", label: "Organize", summary: "Group and order the files a change touches.", tools: [], requires: ["sandbox"] },
  { id: "coding", label: "Coding", summary: "Write a complete file inside the simulation.", tools: ["sandbox_write_file"], requires: ["sandbox"] },
  { id: "testing", label: "Testing", summary: "Run syntax checks and approved package scripts inside the simulation.", tools: ["sandbox_validate"], requires: ["sandbox"] },
  { id: "debugging", label: "Debugging", summary: "Read failing check output and revise the simulated files.", tools: ["sandbox_validate", "sandbox_write_file"], requires: ["failed-check"] },
  { id: "research", label: "Research", summary: "Consult project text, memory, and the vault for evidence.", tools: ["search_workspace_text", "search_memory", "search_obsidian"], requires: [] },
  { id: "planning", label: "Planning", summary: "Propose an ordered plan whose steps are individually reviewable.", tools: [], requires: [] },
  { id: "promoting", label: "Promoting", summary: "Ask the user to apply a validated simulation to the real project.", tools: ["propose_sandbox_promotion"], requires: ["validated"] }
]);

// Stable pseudo-random placement. Hashing the object id means a file always
// lands in the same spot for the same session, across reloads and machines.
function placement(seed, zone, index, total) {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const jitterX = (digest[0] / 255) * 0.4 - 0.2;
  const jitterY = (digest[1] / 255) * 0.3 - 0.15;
  const rows = Math.max(1, Math.ceil(total / 2));
  const column = total > 1 && index >= rows ? 1 : 0;
  const row = total > 1 ? index % rows : 0;
  const columns = total > rows ? 2 : 1;
  return {
    x: Number((zone.x + zone.width * ((column + 0.5 + jitterX) / columns)).toFixed(2)),
    y: Number((zone.y + zone.height * ((row + 0.5 + jitterY) / rows)).toFixed(2))
  };
}

function distance(a, b) {
  return Number(Math.hypot(a.x - b.x, a.y - b.y).toFixed(2));
}

// Sprite mood is a pure function of real session state. There is no "busy"
// animation that runs on a timer: if the sprite looks like it is working, a
// check really is running.
export function spriteState(session) {
  if (!session) return { state: "idle", label: "Waiting for something to do" };
  switch (session.state) {
    case "validating": return { state: "testing", label: "Running checks inside the simulation" };
    case "validated": return { state: "celebrating", label: "Checks passed — ready to propose" };
    case "failed": return { state: "error", label: "Checks failed; the project is untouched" };
    case "promoted": return { state: "celebrating", label: "Applied to the project" };
    case "discarded": return { state: "idle", label: "Simulation discarded" };
    case "open":
      return (session.edits || []).length
        ? { state: "coding", label: "Editing inside the simulation" }
        : { state: "planning", label: "Deciding what to change" };
    default: return { state: "idle", label: "Idle" };
  }
}

// The perception an agent (or a renderer) receives: objects it can see, how
// they relate, what it is carrying, and what it may do next.
export function perceive(session) {
  if (!session?.id) throw Object.assign(new Error("A sandbox session is required."), { status: 400, code: "WORLD_SESSION_REQUIRED" });
  const edits = session.edits || [];
  const validations = session.validations || [];
  const scriptChecks = validations.filter((item) => String(item.kind).startsWith("script:"));

  const project = {
    id: "project", type: "project", label: session.objective || "Project",
    zone: "library", position: placement(`project:${session.id}`, ZONES.library, 0, 1),
    state: session.state, detail: `${session.fileCount} file(s) mirrored${session.truncated ? ", truncated" : ""}`
  };

  const files = edits.map((edit, index) => {
    const failing = validations.some((item) => item.kind === `syntax:${edit.relativePath}` && !item.passed);
    const passing = validations.some((item) => item.kind === `syntax:${edit.relativePath}` && item.passed);
    return {
      id: `file:${edit.relativePath}`, type: "file", label: edit.relativePath,
      zone: "workbench", position: placement(`${session.id}:${edit.relativePath}`, ZONES.workbench, index, edits.length),
      state: failing ? "failing" : passing ? "checked" : "staged",
      operation: edit.operation, bytes: edit.bytes, detail: edit.summary || ""
    };
  });

  const checks = scriptChecks.map((check, index) => ({
    id: `check:${check.kind}`, type: "check", label: String(check.kind).replace(/^script:/, ""),
    zone: "testbench", position: placement(`${session.id}:${check.kind}`, ZONES.testbench, index, scriptChecks.length),
    state: check.passed ? "passed" : "failed", detail: check.summary || ""
  }));

  const sprite = spriteState(session);
  // The agent stands where the work is: at the newest staged file if there is
  // one, otherwise in the project zone.
  const focus = files.at(-1) || project;
  const agent = {
    id: "agent", type: "agent", label: "Evolv",
    zone: focus.zone, position: { x: Number((focus.position.x - 4).toFixed(2)), y: Number((focus.position.y + 4).toFixed(2)) },
    state: sprite.state, detail: sprite.label
  };

  const objects = [project, ...files, ...checks, agent];
  const relationships = [
    ...files.map((file) => ({ from: file.id, to: project.id, kind: "belongs-to", distance: distance(file.position, project.position) })),
    ...checks.map((check) => ({ from: check.id, to: project.id, kind: "verifies", distance: distance(check.position, project.position) })),
    { from: agent.id, to: focus.id, kind: "attending", distance: distance(agent.position, focus.position) }
  ];

  const failingCheck = validations.some((item) => !item.passed);
  const available = new Set();
  if (["open", "failed"].includes(session.state)) { available.add("coding"); available.add("testing"); available.add("organize"); }
  if (session.state === "failed" || failingCheck) available.add("debugging");
  if (session.state === "validated") available.add("promoting");
  available.add("navigate"); available.add("research"); available.add("planning");

  return {
    worldVersion: WORLD_VERSION,
    sessionId: session.id,
    state: session.state,
    // Restating the guarantee where a renderer will read it.
    projectUntouched: session.state !== "promoted",
    zones: Object.values(ZONES),
    objects,
    relationships,
    // What the agent is carrying: the changes it has staged but not applied.
    inventory: edits.map((edit) => ({ path: edit.relativePath, operation: edit.operation, bytes: edit.bytes })),
    sprite,
    skills: SKILLS.map((skill) => ({ ...skill, available: available.has(skill.id) })),
    summary: `${edits.length} staged change(s), ${validations.filter((item) => item.passed).length}/${validations.length} check(s) passing`
  };
}
