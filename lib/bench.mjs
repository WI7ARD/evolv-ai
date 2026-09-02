// The bench: one board at a time, and everything that happens to it.
//
// The circuit service simulates. It holds a design, solves it, and has no idea
// whether anyone ever checked it, exported it or built it — deliberately, since
// that is what keeps it memory-only and its tools in the automatic risk tier.
// The bench is the other half: it owns which board is open, writes it down, and
// records each stage as it happens.
//
// Recording is a side effect of doing, never a separate step. Nobody remembers
// to press "save the fact that I exported this", and a history that depends on
// being remembered is a history with holes in exactly the places that matter.
// So the routes that run, check and export a circuit tell the bench afterwards,
// and if no board is open it is a no-op.

import {
  describeBoard, normaliseMeasurement, stampStage,
  BOARD_NAME_LIMIT, BOARD_INTENT_LIMIT, boardError, BOARD_STAGES
} from "./boards.mjs";

const RECORDED = new Set(BOARD_STAGES.filter((stage) => stage.kind === "recorded").map((stage) => stage.id));

export class BenchService {
  #database;
  #circuit;
  #openBoardId = null;

  constructor({ database, circuitService }) {
    this.#database = database;
    this.#circuit = circuitService;
  }

  get openBoardId() { return this.#openBoardId; }

  // What the design looks like right now. Read from the simulator every time
  // rather than cached, so a stage is always stamped against the board actually
  // in front of it.
  #snapshot() { return this.#circuit.snapshot(); }

  // Listing does not claim staleness.
  //
  // Telling a board apart from a stale one needs its design, and loading every
  // snapshot to draw a list would read the whole library to render a menu. So
  // the list says what each board reached and when, and the question "is that
  // still true" is answered when you open it — which is also the only moment it
  // can be acted on.
  list({ limit = 50, projectId = null } = {}) {
    return this.#database.listBoards({ limit, projectId }).map((row) => {
      let stages = {};
      try { stages = JSON.parse(row.stagesJson || "{}"); } catch { stages = {}; }
      const reached = BOARD_STAGES.filter((stage) => RECORDED.has(stage.id) && stages[stage.id]).at(-1);
      const { stagesJson, ...board } = row;
      return {
        ...board,
        open: board.id === this.#openBoardId,
        reached: reached ? { id: reached.id, label: reached.label, at: stages[reached.id].at } : null
      };
    });
  }

  // Reading a board.
  //
  // The open board is read against the design on the bench, not the one last
  // written to disk. They are the same board — moving a resistor does not
  // create a second one — and judging its history against the saved copy would
  // report a netlist as current while the circuit it described has changed
  // under it. Staleness and "you have not saved yet" are the same fact, and
  // this is the reading that makes them say so.
  get(id) {
    const board = this.#database.getBoard(id);
    if (!board) return null;
    const live = board.id === this.#openBoardId ? { ...board, snapshot: this.#snapshot() } : board;
    return { ...describeBoard(live), open: board.id === this.#openBoardId };
  }

  // The board currently on the bench, if any. Answering null rather than
  // throwing: working without a board is allowed, and always has been — a
  // scratch circuit is how most of them start.
  current() {
    return this.#openBoardId ? this.get(this.#openBoardId) : null;
  }

  // Save what is on the bench as a board, and open it.
  //
  // Saving over the open board by default. Every other reading of "save"
  // produces a second copy on every press, which is how you end up with
  // "Blinker", "Blinker 2" and "Blinker final" and no idea which one was
  // exported.
  save({ name = "", intent = null, projectId = null, boardId = null, asNew = false } = {}) {
    const target = asNew ? null : (boardId || this.#openBoardId);
    const existing = target ? this.#database.getBoard(target) : null;
    const title = String(name || existing?.name || "").trim().slice(0, BOARD_NAME_LIMIT);
    if (!title) throw boardError("A board needs a name.", "BOARD_NAME_REQUIRED");
    const snapshot = this.#snapshot();
    const saved = this.#database.saveBoard({
      id: existing?.id || "",
      name: title,
      // A null intent means "leave it alone", an empty string means "clear it".
      // Collapsing the two would wipe the stated purpose every time somebody
      // saved after moving a resistor.
      intent: intent === null ? (existing?.intent || "") : String(intent).slice(0, BOARD_INTENT_LIMIT),
      snapshot,
      stages: existing?.stages || {},
      partCount: (snapshot.components || []).length,
      projectId: projectId === null ? (existing?.projectId || null) : projectId
    });
    this.#openBoardId = saved.id;
    return this.get(saved.id);
  }

  // Put a saved board back on the bench. The design is restored into the
  // simulator, which is what makes "open" mean the same thing to a person and
  // to a model: both then see one circuit, and it is this one.
  open(id) {
    const board = this.#database.getBoard(id);
    if (!board) throw boardError("There is no board with that id.", "BOARD_NOT_FOUND", 404);
    this.#circuit.restore(board.snapshot);
    this.#openBoardId = board.id;
    return this.get(board.id);
  }

  close() {
    const closed = this.#openBoardId;
    this.#openBoardId = null;
    return closed;
  }

  remove(id) {
    const removed = this.#database.deleteBoard(id);
    if (removed && this.#openBoardId === id) this.#openBoardId = null;
    return removed;
  }

  describe(id, { name = null, intent = null, projectId = undefined } = {}) {
    const board = this.#database.getBoard(id);
    if (!board) throw boardError("There is no board with that id.", "BOARD_NOT_FOUND", 404);
    this.#database.saveBoard({
      id: board.id,
      name: name === null ? board.name : String(name).trim().slice(0, BOARD_NAME_LIMIT),
      intent: intent === null ? board.intent : String(intent).slice(0, BOARD_INTENT_LIMIT),
      snapshot: board.snapshot,
      stages: board.stages,
      partCount: board.partCount,
      projectId: projectId === undefined ? board.projectId : projectId
    });
    return this.get(board.id);
  }

  // Write down that something happened, stamped with the design it happened to.
  //
  // Silent when no board is open, because the alternative — refusing to run a
  // circuit until it has been named — would make the sandbox worse to use in
  // order to make its bookkeeping tidier.
  record(stage, detail = {}) {
    if (!this.#openBoardId || !RECORDED.has(stage)) return null;
    const stamped = stampStage(stage, detail, this.#snapshot());
    return this.#database.recordBoardStage(this.#openBoardId, stage, stamped);
  }

  // The three stages that happen by doing them.
  //
  // Running, checking and exporting all go through here rather than through the
  // simulator directly, so there is exactly one place that records each — the
  // same rule the simulator applies to apply(). A person clicking Run and a
  // model calling circuit_run reach this method, and a board's history cannot
  // depend on which of them did the work.
  run(options = {}) {
    const result = this.#circuit.apply("run", options);
    this.recordRun(result);
    return result;
  }

  check(options = {}) {
    const result = this.#circuit.apply("check", options);
    this.recordCheck(result);
    return result;
  }

  // The board's name is the design's name. Without this the netlist for a board
  // called "Bike telemetry" arrived as Evolv-circuit.net, and the one thing an
  // exported file has to carry is which project it belongs to.
  exportDesign(options = {}) {
    const named = options.name ? options : { ...options, name: this.#openName() || "" };
    const result = this.#circuit.apply("export", named);
    this.recordExport(result);
    return result;
  }

  #openName() {
    return this.#openBoardId ? (this.#database?.getBoard(this.#openBoardId)?.name || "") : "";
  }

  recordRun(result) {
    if (!result?.ran) return null;
    return this.record("simulate", {
      seconds: result.time,
      supplyAmps: supplyCurrent(this.#snapshot(), result.currents),
      findings: (result.findings || []).slice(0, 20)
    });
  }

  recordCheck(result) {
    if (!result?.ran) return null;
    return this.record("verify", {
      passed: result.passed, failed: result.failed, summary: result.summary,
      seconds: result.seconds,
      // Only the fields a later comparison reads. Storing whole check results
      // would put a copy of every trace-derived detail in the board record and
      // grow it without bound.
      results: (result.results || []).map(({ subject, measure, condition, value, pass, measured, at, detail, statement }) =>
        ({ subject, measure, condition, value, pass, measured, at, detail, statement }))
    });
  }

  recordExport(result) {
    return this.record("export", {
      format: result?.format || "netlist",
      filename: result?.filename || "",
      problems: (result?.problems || []).slice(0, 20)
    });
  }

  markBuilt({ note = "" } = {}) {
    if (!this.#openBoardId) throw boardError("Open a board before recording that it was built.", "BOARD_NONE_OPEN");
    this.record("build", { note: String(note || "").slice(0, 200) });
    return this.current();
  }

  // A reading off a real board.
  measure(input = {}, { boardId = null } = {}) {
    const target = boardId || this.#openBoardId;
    if (!target) throw boardError("Open a board before recording a measurement of it.", "BOARD_NONE_OPEN");
    const measurement = normaliseMeasurement(input);
    const stored = this.#database.addBoardMeasurement(target, measurement);
    if (!stored) throw boardError("There is no board with that id.", "BOARD_NOT_FOUND", 404);
    return this.get(target);
  }

  unmeasure(measurementId, { boardId = null } = {}) {
    const target = boardId || this.#openBoardId;
    const removed = this.#database.deleteBoardMeasurement(measurementId);
    return removed && target ? this.get(target) : removed;
  }

  // What the cloud cost while this board was on the bench. Attributed to the
  // open board and nothing else: a turn spent on something unrelated is not
  // this board's cost, and pretending otherwise would make the only number
  // anyone checks against their card statement wrong.
  spend(micros) {
    if (!this.#openBoardId) return false;
    return this.#database.addBoardSpend(this.#openBoardId, micros);
  }

  // Through get(), so the sentence describes the board on the bench rather than
  // the copy last written to disk. Two readings of one board that disagreed
  // would be worse than either of them alone.
  summary() {
    return this.current()?.summary || "No board is open.";
  }
}

// What the board draws, for the simulate headline. Read from the parts that
// supply it rather than summed over everything, because a sum over every part
// double-counts: the current out of the supply is the same current through the
// resistor it feeds.
function supplyCurrent(snapshot, currents = {}) {
  const supplies = (snapshot.components || []).filter((component) =>
    component.kind === "supply" || component.kind === "battery");
  if (!supplies.length) return null;
  const total = supplies.reduce((sum, supply) => sum + Math.abs(Number(currents[supply.id]) || 0), 0);
  return Number.isFinite(total) ? total : null;
}
