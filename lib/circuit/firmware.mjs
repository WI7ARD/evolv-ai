// Firmware, read rather than evaluated.
//
// This is the first thing in Evolv that runs code the AI wrote, and that is why
// it is an interpreter and not an evaluator. There is no `eval`, no `new
// Function`, no `node:vm` anywhere in this codebase, which is a deliberate
// stance for a process holding filesystem handles and API keys. A tokenizer, a
// parser and a tree-walk keep that stance exactly: firmware cannot reach a
// file, a socket, or a host object, not because those are blocked but because
// the language has no way to name them.
//
// It is also resumable, which is the other half of the design. A real
// microcontroller executes a few hundred instructions between one microsecond
// and the next, and the simulation has to interleave with that. Every statement
// is a `yield`, so the driver can run exactly the cycles a timestep is worth and
// stop mid-loop, in the middle of a function, holding its place perfectly.

export class FirmwareError extends Error {
  constructor(message, line = 0, code = "FIRMWARE_INVALID") {
    super(line ? `${message} (line ${line})` : message);
    this.code = code;
    this.line = line;
    this.status = 400;
    this.expose = true;
  }
}

const KEYWORDS = new Set(["var", "let", "if", "else", "while", "for", "function", "return", "true", "false", "break", "continue"]);

// Two-character operators first, or `<=` tokenizes as `<` then `=`.
const OPERATORS = [
  "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=",
  "=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "{", "}", "[", "]", ",", ";"
];

export function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const text = String(source || "");

  while (index < text.length) {
    const character = text[index];
    if (character === "\n") { line += 1; index += 1; continue; }
    if (/\s/.test(character)) { index += 1; continue; }
    // Comments, both kinds. Firmware is read by people too.
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[index + 1] || ""))) {
      let end = index;
      while (end < text.length && /[0-9._]/.test(text[end])) end += 1;
      tokens.push({ type: "number", value: Number(text.slice(index, end).replace(/_/g, "")), line });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      const word = text.slice(index, end);
      tokens.push({ type: KEYWORDS.has(word) ? word : "name", value: word, line });
      index = end;
      continue;
    }
    if (character === '"' || character === "'") {
      let end = index + 1;
      let value = "";
      while (end < text.length && text[end] !== character) {
        if (text[end] === "\\") { value += text[end + 1] ?? ""; end += 2; continue; }
        value += text[end];
        end += 1;
      }
      if (end >= text.length) throw new FirmwareError("A text value was never closed", line);
      tokens.push({ type: "string", value, line });
      index = end + 1;
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (!operator) throw new FirmwareError(`Evolv does not understand the character ${JSON.stringify(character)}`, line);
    tokens.push({ type: operator, value: operator, line });
    index += operator.length;
  }
  tokens.push({ type: "end", value: "", line });
  return tokens;
}

// A recursive-descent parser producing a plain-object AST. Nothing here can
// produce a node the interpreter does not know how to walk, which is what keeps
// the language closed.
export function parse(source) {
  const tokens = tokenize(source);
  let position = 0;

  const peek = (offset = 0) => tokens[Math.min(position + offset, tokens.length - 1)];
  const next = () => tokens[position++];
  const at = (type) => peek().type === type;
  const eat = (type) => (at(type) ? next() : null);
  const expect = (type) => {
    if (!at(type)) throw new FirmwareError(`Expected ${type} but found ${JSON.stringify(peek().value)}`, peek().line);
    return next();
  };

  function parseProgram() {
    const body = [];
    while (!at("end")) body.push(parseStatement());
    return { type: "Program", body };
  }

  function parseBlock() {
    expect("{");
    const body = [];
    while (!at("}") && !at("end")) body.push(parseStatement());
    expect("}");
    return { type: "Block", body };
  }

  function parseStatement() {
    const token = peek();
    if (at("function")) {
      next();
      const name = expect("name").value;
      expect("(");
      const parameters = [];
      while (!at(")")) {
        parameters.push(expect("name").value);
        if (!eat(",")) break;
      }
      expect(")");
      return { type: "FunctionDeclaration", name, parameters, body: parseBlock(), line: token.line };
    }
    if (at("var") || at("let")) {
      next();
      const name = expect("name").value;
      const value = eat("=") ? parseExpression() : { type: "Literal", value: 0 };
      eat(";");
      return { type: "VariableDeclaration", name, value, line: token.line };
    }
    if (at("if")) {
      next();
      expect("(");
      const test = parseExpression();
      expect(")");
      const consequent = at("{") ? parseBlock() : parseStatement();
      const alternate = eat("else") ? (at("{") ? parseBlock() : parseStatement()) : null;
      return { type: "If", test, consequent, alternate, line: token.line };
    }
    if (at("while")) {
      next();
      expect("(");
      const test = parseExpression();
      expect(")");
      return { type: "While", test, body: at("{") ? parseBlock() : parseStatement(), line: token.line };
    }
    if (at("for")) {
      next();
      expect("(");
      const init = at(";") ? null : parseStatement();
      if (!init) eat(";");
      const test = at(";") ? { type: "Literal", value: 1 } : parseExpression();
      expect(";");
      const update = at(")") ? null : parseExpression();
      expect(")");
      return { type: "For", init, test, update, body: at("{") ? parseBlock() : parseStatement(), line: token.line };
    }
    if (at("return")) {
      next();
      const value = at(";") || at("}") ? { type: "Literal", value: 0 } : parseExpression();
      eat(";");
      return { type: "Return", value, line: token.line };
    }
    if (at("break")) { next(); eat(";"); return { type: "Break", line: token.line }; }
    if (at("continue")) { next(); eat(";"); return { type: "Continue", line: token.line }; }
    if (at("{")) return parseBlock();
    const expression = parseExpression();
    eat(";");
    return { type: "ExpressionStatement", expression, line: token.line };
  }

  // Precedence climbing, lowest binding first.
  const BINARY_LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];

  function parseExpression() {
    return parseAssignment();
  }

  function parseAssignment() {
    const left = parseBinary(0);
    const compound = ["=", "+=", "-=", "*=", "/="].find((operator) => at(operator));
    if (!compound) return left;
    if (left.type !== "Identifier") throw new FirmwareError("Only a variable can be assigned to", peek().line);
    next();
    const right = parseAssignment();
    return {
      type: "Assignment",
      name: left.name,
      value: compound === "="
        ? right
        : { type: "Binary", operator: compound[0], left, right }
    };
  }

  function parseBinary(level) {
    if (level >= BINARY_LEVELS.length) return parseUnary();
    let left = parseBinary(level + 1);
    while (BINARY_LEVELS[level].some((operator) => at(operator))) {
      const operator = next().type;
      const right = parseBinary(level + 1);
      left = { type: "Binary", operator, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (at("!") || at("-")) {
      const operator = next().type;
      return { type: "Unary", operator, argument: parseUnary() };
    }
    if (at("++") || at("--")) {
      const operator = next().type;
      const argument = parseUnary();
      if (argument.type !== "Identifier") throw new FirmwareError("Only a variable can be stepped", peek().line);
      return { type: "Assignment", name: argument.name, value: { type: "Binary", operator: operator[0], left: argument, right: { type: "Literal", value: 1 } } };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (at("(")) {
        next();
        const args = [];
        while (!at(")")) {
          args.push(parseExpression());
          if (!eat(",")) break;
        }
        expect(")");
        if (node.type !== "Identifier") throw new FirmwareError("Only a name can be called", peek().line);
        node = { type: "Call", name: node.name, args, line: peek().line };
        continue;
      }
      if (at("++") || at("--")) {
        const operator = next().type;
        if (node.type !== "Identifier") throw new FirmwareError("Only a variable can be stepped", peek().line);
        // Post-step: the value read is the old one, so it is returned and the
        // variable updated behind it.
        node = { type: "PostStep", name: node.name, operator: operator[0] };
        continue;
      }
      return node;
    }
  }

  function parsePrimary() {
    const token = peek();
    if (at("number")) { next(); return { type: "Literal", value: token.value }; }
    if (at("string")) { next(); return { type: "Literal", value: token.value }; }
    if (at("true")) { next(); return { type: "Literal", value: 1 }; }
    if (at("false")) { next(); return { type: "Literal", value: 0 }; }
    if (at("name")) { next(); return { type: "Identifier", name: token.value, line: token.line }; }
    if (at("(")) { next(); const inner = parseExpression(); expect(")"); return inner; }
    throw new FirmwareError(`Evolv does not understand ${JSON.stringify(token.value || token.type)} here`, token.line);
  }

  const program = parseProgram();
  const functions = new Map();
  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration") functions.set(statement.name, statement);
  }
  return { program, functions };
}

// What a statement costs, in clock cycles.
//
// Not measured against any real chip — these are plausible figures that make
// the arithmetic teach the right lesson: a pin write is cheap, an ADC
// conversion is enormously expensive, and a loop of arithmetic takes real time.
// Someone who discovers their loop cannot keep up has learnt something true,
// even if the exact number came from here rather than from a datasheet.
const CYCLE_COSTS = {
  statement: 1,
  binary: 1,
  call: 3,
  digitalWrite: 2,
  digitalRead: 2,
  pinMode: 2,
  analogWrite: 4,
  // A real successive-approximation ADC takes around 100µs, which at 16MHz is
  // well over a thousand cycles. This is the number that makes a beginner's
  // "read six sensors every loop" visibly slow, which is the point.
  analogRead: 1_600,
  millis: 2,
  micros: 2,
  print: 20
};

class ReturnSignal { constructor(value) { this.value = value; } }
const BREAK = Symbol("break");
const CONTINUE = Symbol("continue");

// A running program.
//
// `step()` runs until it has spent its cycle budget or the firmware is waiting
// for time to pass, then returns. Everything about where it had got to lives in
// the generator, so there is no state machine to keep in sync.
export class Firmware {
  constructor(source, host) {
    const { program, functions } = parse(source);
    this.program = program;
    this.functions = functions;
    this.host = host;
    this.globals = new Map();
    this.output = [];
    this.cycles = 0;
    this.iterations = 0;
    this.finished = false;
    this.error = null;
    this.runner = this.#run();
    this.pending = 0;
  }

  // Advance by at most `budget` cycles. Returns the cycles actually spent.
  step(budget) {
    if (this.finished || this.error) return 0;
    let spent = 0;
    // Carried over from the last call: a statement that cost more than the
    // budget left is paid off across timesteps rather than being free.
    if (this.pending > 0) {
      const paid = Math.min(this.pending, budget);
      this.pending -= paid;
      return paid;
    }
    while (spent < budget) {
      let result;
      try {
        result = this.runner.next();
      } catch (error) {
        this.error = error instanceof FirmwareError ? error : new FirmwareError(error.message, 0, "FIRMWARE_FAILED");
        return spent;
      }
      if (result.done) { this.finished = true; return spent; }
      const yielded = result.value || {};
      if (yielded.waiting) return spent;
      const cost = yielded.cycles || 1;
      spent += cost;
      if (spent > budget) {
        this.pending = spent - budget;
        return budget;
      }
    }
    return spent;
  }

  // The loop body has come round again. Used to notice a program stuck in setup.
  get completedIterations() { return this.iterations; }

  *#run() {
    const setup = this.functions.get("setup");
    const loop = this.functions.get("loop");
    if (!setup && !loop) {
      throw new FirmwareError("Firmware needs a setup() or a loop() function, the way a sketch does", 0, "FIRMWARE_NO_ENTRY");
    }
    if (setup) yield* this.#callFunction(setup, [], new Map());
    if (!loop) return;
    for (;;) {
      yield* this.#callFunction(loop, [], new Map());
      this.iterations += 1;
      // A loop() that returns instantly would otherwise spin the interpreter
      // without the simulation advancing at all.
      yield { cycles: CYCLE_COSTS.call };
    }
  }

  *#callFunction(declaration, args, _parent) {
    const scope = new Map();
    declaration.parameters.forEach((name, index) => scope.set(name, args[index] ?? 0));
    try {
      yield* this.#execute(declaration.body, scope);
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    }
    return 0;
  }

  #lookup(scope, name) {
    if (scope.has(name)) return scope.get(name);
    if (this.globals.has(name)) return this.globals.get(name);
    return undefined;
  }

  #assign(scope, name, value) {
    if (scope.has(name)) scope.set(name, value);
    else if (this.globals.has(name)) this.globals.set(name, value);
    else scope.set(name, value);
  }

  *#execute(node, scope) {
    switch (node.type) {
      case "Block":
        for (const statement of node.body) yield* this.#execute(statement, scope);
        return;
      case "FunctionDeclaration":
        return;
      case "VariableDeclaration": {
        const value = yield* this.#evaluate(node.value, scope);
        scope.set(node.name, value);
        yield { cycles: CYCLE_COSTS.statement };
        return;
      }
      case "ExpressionStatement":
        yield* this.#evaluate(node.expression, scope);
        yield { cycles: CYCLE_COSTS.statement };
        return;
      case "If": {
        const test = yield* this.#evaluate(node.test, scope);
        yield { cycles: CYCLE_COSTS.statement };
        if (truthy(test)) yield* this.#execute(node.consequent, scope);
        else if (node.alternate) yield* this.#execute(node.alternate, scope);
        return;
      }
      case "While":
        for (;;) {
          const test = yield* this.#evaluate(node.test, scope);
          yield { cycles: CYCLE_COSTS.statement };
          if (!truthy(test)) return;
          const signal = yield* this.#loopBody(node.body, scope);
          if (signal === BREAK) return;
        }
      case "For": {
        if (node.init) yield* this.#execute(node.init, scope);
        for (;;) {
          const test = yield* this.#evaluate(node.test, scope);
          yield { cycles: CYCLE_COSTS.statement };
          if (!truthy(test)) return;
          const signal = yield* this.#loopBody(node.body, scope);
          if (signal === BREAK) return;
          if (node.update) yield* this.#evaluate(node.update, scope);
        }
      }
      case "Return":
        throw new ReturnSignal(yield* this.#evaluate(node.value, scope));
      case "Break":
        throw BREAK;
      case "Continue":
        throw CONTINUE;
      default:
        yield* this.#evaluate(node, scope);
    }
  }

  *#loopBody(body, scope) {
    try {
      yield* this.#execute(body, scope);
    } catch (signal) {
      if (signal === BREAK) return BREAK;
      if (signal === CONTINUE) return CONTINUE;
      throw signal;
    }
    return null;
  }

  *#evaluate(node, scope) {
    switch (node.type) {
      case "Literal":
        return node.value;
      case "Identifier": {
        const value = this.#lookup(scope, node.name);
        if (value === undefined) throw new FirmwareError(`${node.name} has not been given a value`, node.line, "FIRMWARE_UNKNOWN_NAME");
        return value;
      }
      case "Assignment": {
        const value = yield* this.#evaluate(node.value, scope);
        this.#assign(scope, node.name, value);
        return value;
      }
      case "PostStep": {
        const before = this.#lookup(scope, node.name) ?? 0;
        this.#assign(scope, node.name, node.operator === "+" ? before + 1 : before - 1);
        return before;
      }
      case "Unary": {
        const value = yield* this.#evaluate(node.argument, scope);
        return node.operator === "!" ? (truthy(value) ? 0 : 1) : -value;
      }
      case "Binary": {
        // Short-circuit, so `x != 0 && 100 / x > 2` behaves.
        if (node.operator === "&&") {
          const left = yield* this.#evaluate(node.left, scope);
          if (!truthy(left)) return 0;
          return truthy(yield* this.#evaluate(node.right, scope)) ? 1 : 0;
        }
        if (node.operator === "||") {
          const left = yield* this.#evaluate(node.left, scope);
          if (truthy(left)) return 1;
          return truthy(yield* this.#evaluate(node.right, scope)) ? 1 : 0;
        }
        const left = yield* this.#evaluate(node.left, scope);
        const right = yield* this.#evaluate(node.right, scope);
        yield { cycles: CYCLE_COSTS.binary };
        return applyBinary(node.operator, left, right, node.line);
      }
      case "Call":
        return yield* this.#call(node, scope);
      default:
        throw new FirmwareError(`Evolv cannot run a ${node.type}`, node.line);
    }
  }

  *#call(node, scope) {
    const args = [];
    for (const argument of node.args) args.push(yield* this.#evaluate(argument, scope));

    const declared = this.functions.get(node.name);
    if (declared) {
      yield { cycles: CYCLE_COSTS.call };
      return yield* this.#callFunction(declared, args, scope);
    }

    const host = this.host;
    switch (node.name) {
      case "pinMode":
        yield { cycles: CYCLE_COSTS.pinMode };
        host.pinMode(args[0], args[1]);
        return 0;
      case "digitalWrite":
        yield { cycles: CYCLE_COSTS.digitalWrite };
        host.digitalWrite(args[0], args[1]);
        return 0;
      case "digitalRead":
        yield { cycles: CYCLE_COSTS.digitalRead };
        return host.digitalRead(args[0]);
      case "analogWrite":
        yield { cycles: CYCLE_COSTS.analogWrite };
        host.analogWrite(args[0], args[1]);
        return 0;
      case "analogRead":
        yield { cycles: CYCLE_COSTS.analogRead };
        return host.analogRead(args[0]);
      case "millis":
        yield { cycles: CYCLE_COSTS.millis };
        return host.millis();
      case "micros":
        yield { cycles: CYCLE_COSTS.micros };
        return host.micros();
      case "delay":
      case "delayMicroseconds": {
        const span = Number(args[0]) || 0;
        const until = host.micros() + (node.name === "delay" ? span * 1000 : span);
        // Waiting costs no cycles because it costs no work — the chip is simply
        // not making progress. Each timestep the driver asks once, is told the
        // firmware is still waiting, and moves on.
        while (host.micros() < until) yield { waiting: true };
        return 0;
      }
      case "print":
      case "println": {
        yield { cycles: CYCLE_COSTS.print };
        const line = args.map((value) => (typeof value === "string" ? value : formatNumber(value))).join(" ");
        // Bounded: a program printing every loop for a simulated minute would
        // otherwise fill memory with output nobody is going to read.
        if (this.output.length < 500) this.output.push({ at: host.micros() / 1e6, line });
        return 0;
      }
      case "map": {
        yield { cycles: CYCLE_COSTS.binary };
        const [value, fromLow, fromHigh, toLow, toHigh] = args;
        if (fromHigh === fromLow) return toLow;
        return toLow + (((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow));
      }
      case "constrain":
        return Math.min(args[2], Math.max(args[1], args[0]));
      case "abs":
        return Math.abs(args[0]);
      case "min":
        return Math.min(...args);
      case "max":
        return Math.max(...args);
      default:
        // The whole security argument in one line: a name the interpreter does
        // not know is a firmware error, not a lookup in some outer scope. There
        // is no outer scope to reach.
        throw new FirmwareError(`There is no function called ${node.name}`, node.line, "FIRMWARE_UNKNOWN_CALL");
    }
  }
}

function truthy(value) {
  return value !== 0 && value !== false && value !== "" && value !== undefined && value !== null;
}

function applyBinary(operator, left, right, line) {
  switch (operator) {
    case "+": return typeof left === "string" || typeof right === "string" ? `${left}${right}` : left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/":
      // A real chip returns nonsense rather than raising, but nonsense that
      // propagates silently is worse in a teaching sandbox than being told.
      if (right === 0) throw new FirmwareError("Divided by zero", line, "FIRMWARE_DIVIDE_BY_ZERO");
      return left / right;
    case "%": return right === 0 ? 0 : left % right;
    case "==": return left === right ? 1 : 0;
    case "!=": return left !== right ? 1 : 0;
    case "<": return left < right ? 1 : 0;
    case ">": return left > right ? 1 : 0;
    case "<=": return left <= right ? 1 : 0;
    case ">=": return left >= right ? 1 : 0;
    default: throw new FirmwareError(`Unknown operator ${operator}`, line);
  }
}

function formatNumber(value) {
  if (typeof value !== "number") return String(value);
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

export { CYCLE_COSTS };
