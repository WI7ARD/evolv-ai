// Solving a circuit: what voltage is at every node, what current through every part.
//
// This is Modified Nodal Analysis. Kirchhoff's current law says the currents
// leaving any node sum to zero, which gives one equation per node; the unknowns
// are the node voltages. That alone cannot express a voltage source — a source
// fixes a voltage and lets its current be whatever it needs to be — so each one
// adds its own current as an extra unknown and its own equation saying what
// voltage it holds. Hence "modified".
//
// Written here rather than vendored. There is no small trustworthy SPICE for
// Node, and this sandbox caps a circuit at a size where a dense matrix is
// nothing: 200 nodes is a 200×200 solve, microseconds, and every line of it is
// testable. A vendored engine would be neither.
//
// Ground is node 0 and is not an unknown. Every circuit needs one, because
// voltage is a difference and without a reference the equations have infinitely
// many solutions — which is exactly the singular matrix reported below.

// Physical constants, at 300K. kT/q.
export const THERMAL_VOLTAGE = 0.025852;

// How far Newton is allowed to move a junction voltage in one step.
//
// Without this the exponential runs away: a first guess of 0V on a diode gives a
// derivative near zero, Newton overshoots to something like 40V, exp(40/0.026)
// overflows to Infinity, and the whole matrix becomes NaN. Real SPICE calls this
// voltage limiting and every implementation needs it.
const MAX_JUNCTION_STEP = 0.5;

const MAX_NEWTON_ITERATIONS = 100;
// Absolute volts and relative, both — a 10µV error matters on a thermocouple and
// is noise on a 12V rail, so neither test alone is right.
const VOLTAGE_ABSOLUTE_TOLERANCE = 1e-9;
const VOLTAGE_RELATIVE_TOLERANCE = 1e-6;

export function solverError(message, code = "CIRCUIT_UNSOLVABLE") {
  return Object.assign(new Error(message), { code, status: 409, expose: true });
}

// A square system, built by stamping and solved in place.
//
// "Stamping" is the standard word: each component adds its own contribution to
// the matrix without knowing anything about the others, which is what makes the
// component models independent and separately testable.
export class MnaSystem {
  constructor(size) {
    this.size = size;
    this.matrix = Array.from({ length: size }, () => new Float64Array(size));
    this.rhs = new Float64Array(size);
  }

  // Conductance between two nodes. -1 means ground, which is not an unknown and
  // so is simply left out of the matrix rather than given a row of its own.
  stampConductance(a, b, g) {
    if (!Number.isFinite(g)) throw solverError("A component produced a conductance that is not a number.");
    if (a >= 0) this.matrix[a][a] += g;
    if (b >= 0) this.matrix[b][b] += g;
    if (a >= 0 && b >= 0) {
      this.matrix[a][b] -= g;
      this.matrix[b][a] -= g;
    }
  }

  // A current forced from node a to node b.
  stampCurrent(a, b, current) {
    if (!Number.isFinite(current)) throw solverError("A component produced a current that is not a number.");
    if (a >= 0) this.rhs[a] -= current;
    if (b >= 0) this.rhs[b] += current;
  }

  // A voltage source: `branch` is the row and column of its own current unknown.
  stampVoltageSource(a, b, branch, volts) {
    if (a >= 0) {
      this.matrix[a][branch] += 1;
      this.matrix[branch][a] += 1;
    }
    if (b >= 0) {
      this.matrix[b][branch] -= 1;
      this.matrix[branch][b] -= 1;
    }
    this.rhs[branch] += volts;
  }

  // A voltage source whose value is a multiple of the difference between two
  // other nodes: V(out) − gain·(V(plus) − V(minus)) = 0.
  //
  // This is how an op-amp has to be stamped, and the reason is worth stating.
  // Treating it as an ordinary source recomputed each Newton iteration does not
  // converge: a gain of a hundred thousand means a microvolt of movement at the
  // input throws the output by ten volts, which throws the feedback, which
  // throws the input further. Putting the relationship into the matrix instead
  // lets one solve find the point where the gain and the feedback agree — which
  // is what the circuit itself does, instantly and without iterating.
  stampControlledSource(out, reference, branch, plus, minus, gain) {
    if (out >= 0) {
      this.matrix[out][branch] += 1;
      this.matrix[branch][out] += 1;
    }
    if (reference >= 0) {
      this.matrix[reference][branch] -= 1;
      this.matrix[branch][reference] -= 1;
    }
    if (plus >= 0) this.matrix[branch][plus] -= gain;
    if (minus >= 0) this.matrix[branch][minus] += gain;
  }

  // Gaussian elimination with partial pivoting.
  //
  // Partial pivoting is not optional here. A ladder of equal resistors produces
  // rows whose leading entries cancel, and without choosing the largest pivot
  // the elimination divides by something near zero and returns numbers that look
  // plausible and are wrong. Wrong-and-plausible is the failure mode this whole
  // module exists to avoid.
  solve() {
    const { size, matrix, rhs } = this;
    const order = new Int32Array(size);
    for (let index = 0; index < size; index += 1) order[index] = index;

    for (let column = 0; column < size; column += 1) {
      let pivotRow = column;
      let best = Math.abs(matrix[column][column]);
      for (let row = column + 1; row < size; row += 1) {
        const candidate = Math.abs(matrix[row][column]);
        if (candidate > best) { best = candidate; pivotRow = row; }
      }
      // A pivot of zero means a row of the system carries no information: a node
      // joined to nothing, or a loop of ideal sources with no reference. There is
      // no answer to return and inventing one would be the worst outcome.
      if (best < 1e-14) {
        throw solverError(
          "This circuit has no single answer. Usually that means a node is connected to nothing, or a voltage source is shorted to itself.",
          "CIRCUIT_SINGULAR"
        );
      }
      if (pivotRow !== column) {
        const swap = matrix[pivotRow]; matrix[pivotRow] = matrix[column]; matrix[column] = swap;
        const held = rhs[pivotRow]; rhs[pivotRow] = rhs[column]; rhs[column] = held;
      }
      const pivot = matrix[column][column];
      for (let row = column + 1; row < size; row += 1) {
        const factor = matrix[row][column] / pivot;
        if (factor === 0) continue;
        for (let index = column; index < size; index += 1) matrix[row][index] -= factor * matrix[column][index];
        rhs[row] -= factor * rhs[column];
      }
    }

    const solution = new Float64Array(size);
    for (let row = size - 1; row >= 0; row -= 1) {
      let sum = rhs[row];
      for (let index = row + 1; index < size; index += 1) sum -= matrix[row][index] * solution[index];
      solution[row] = sum / matrix[row][row];
    }
    for (const value of solution) {
      if (!Number.isFinite(value)) throw solverError("The circuit produced a value that is not a number.");
    }
    return solution;
  }
}

// Newton's method, applied to a diode junction.
//
// Returned as a conductance and a current because that is all the matrix can
// accept: a nonlinear part is replaced, at each iteration, by the straight line
// tangent to its curve at the current guess. Iterate and the guess converges on
// where the line and the curve agree.
//
// `previous` must be the limited voltage from the *last iteration*, not the
// guess being passed in. Handing it the same value disables limiting entirely
// and the solve runs away — which is why callers should use the `diode` helper
// on the solve context below rather than calling this directly. It stays
// exported because it is worth being able to test the curve on its own.
export function diodeCompanion(voltage, { saturationCurrent = 1e-14, emission = 1, previous = 0 } = {}) {
  const scale = emission * THERMAL_VOLTAGE;
  // Limiting is applied against the previous iteration's value, not against
  // zero, so a diode genuinely sitting at 0.7V is not dragged back every step.
  let limited = voltage;
  if (voltage > previous + MAX_JUNCTION_STEP) limited = previous + MAX_JUNCTION_STEP;
  else if (voltage < previous - MAX_JUNCTION_STEP) limited = previous - MAX_JUNCTION_STEP;
  // Well below zero the exponential is negligible and the part is a very large
  // resistor. Computing it anyway costs an underflow and a division by zero.
  const clamped = limited !== voltage;
  if (limited < -5 * scale) {
    return { conductance: 1e-12, current: -saturationCurrent, voltage: limited, clamped };
  }
  const exponential = Math.exp(limited / scale);
  const current = saturationCurrent * (exponential - 1);
  // A floor on conductance keeps the matrix non-singular when every diode in the
  // circuit is off, which would otherwise leave their nodes floating.
  const conductance = Math.max(saturationCurrent * exponential / scale, 1e-12);
  return { conductance, current, voltage: limited, clamped };
}

// Has the solution stopped moving?
function converged(current, previous) {
  if (!previous) return false;
  for (let index = 0; index < current.length; index += 1) {
    const difference = Math.abs(current[index] - previous[index]);
    const allowed = VOLTAGE_ABSOLUTE_TOLERANCE + VOLTAGE_RELATIVE_TOLERANCE * Math.abs(current[index]);
    if (difference > allowed) return false;
  }
  return true;
}

// Solve a circuit that may contain nonlinear parts.
//
// `build(system, solution, iteration)` stamps every component. It is called once
// per iteration and is handed the previous solution so nonlinear parts can
// linearise around it; on the first call the solution is all zeros, which is the
// conventional cold start.
//
// Linear circuits converge on the second iteration by construction — the second
// solve produces the same numbers as the first — so nothing special is needed to
// detect them.
export function solveNonlinear(size, build) {
  if (size <= 0) {
    throw solverError("This circuit has nothing in it to solve.", "CIRCUIT_EMPTY");
  }
  // Per-junction memory, kept here rather than by the caller.
  //
  // Newton needs each junction's voltage from the previous iteration to limit
  // how far this one may move. Asking every component model to carry that
  // itself is how the limiting silently stops working: pass in the current
  // guess as the previous value and nothing is ever limited, the exponential
  // runs away, and the circuit reports that it will not settle. The first
  // version of this file made exactly that mistake.
  const junctions = new Map();
  // Set whenever a junction's step had to be limited this iteration.
  //
  // Convergence cannot be judged on node voltages alone. An LED starting from
  // zero takes several limited half-volt steps before it conducts at all, and
  // through every one of them the node voltages do not move — the part is still
  // effectively open. Testing only the solution declares victory on the second
  // iteration and returns "5.000V, 0.00mA" for a circuit whose LED is plainly
  // lit. That is the confidently-wrong answer this whole module exists to
  // avoid, and it survived the first round of tests because a plain silicon
  // diode reaches its knee inside two steps and never shows it.
  let walking = false;

  const context = {
    // Stamp a diode between two nodes, remembering its own state.
    //
    // This also owns the companion-current arithmetic — `current - g·v`, the
    // offset that makes the tangent line pass through the operating point.
    // Written out at each call site it is one sign away from a circuit that
    // converges on the wrong answer, which no test of the curve itself would
    // catch.
    diode(key, anode, cathode, options = {}) {
      const across = (anode >= 0 ? this.solution[anode] : 0) - (cathode >= 0 ? this.solution[cathode] : 0);
      const previousVoltage = junctions.has(key) ? junctions.get(key) : 0;
      const { conductance, current, voltage, clamped } = diodeCompanion(across, { ...options, previous: previousVoltage });
      if (clamped) walking = true;
      junctions.set(key, voltage);
      system.stampConductance(anode, cathode, conductance);
      system.stampCurrent(anode, cathode, current - (conductance * voltage));
      return { conductance, current, voltage };
    },
    solution: new Float64Array(size),
    iteration: 0
  };

  let system = null;
  let previous = null;
  let solution = new Float64Array(size);
  for (let iteration = 0; iteration < MAX_NEWTON_ITERATIONS; iteration += 1) {
    system = new MnaSystem(size);
    context.solution = solution;
    context.iteration = iteration;
    walking = false;
    build(system, solution, context);
    previous = solution;
    solution = system.solve();
    if (!walking && converged(solution, previous)) return { solution, iterations: iteration + 1 };
  }
  // Reported, never rounded off and returned. A circuit that will not converge
  // usually has a real fault in it — a latch-up, a source fighting a source —
  // and the last iterate is not an answer, it is where the search gave up.
  throw solverError(
    `The circuit would not settle after ${MAX_NEWTON_ITERATIONS} attempts. This usually means two sources are fighting, or a part is wired in a way that has no stable state.`,
    "CIRCUIT_NO_CONVERGENCE"
  );
}
