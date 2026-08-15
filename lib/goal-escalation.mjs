// When an ordinary message is really a piece of work.
//
// The goal runner used to be reachable only through /agent and a form that
// asked for seven things before it would do anything: an objective, success
// criteria one per line, a project, a pack, a provider, a model and a budget.
// Everything the form asked for is either already known or can be worked out,
// so it asked the person to supply it anyway — which is why almost nobody ever
// used the part of Evolv that does the most.
//
// So chat decides instead. This is the decision, kept as a pure function so it
// can be argued with in a test rather than only observed in the app.
//
// It is deliberately reluctant. A wrong escalation turns a ten-second answer
// into a two-minute plan-and-verify cycle, and the person never asked for that;
// a missed escalation is just the behaviour Evolv had yesterday. So the bar is
// several signals at once, and anything conversational is left alone.

// Work that plainly spans a corpus rather than a sentence.
const SURVEY = /\b(?:every|all|each|any)\b[^.?!]{0,40}\b(?:file|files|place|places|usage|usages|reference|references|caller|callers|occurrence|occurrences|module|modules|test|tests|route|routes|function|functions|note|notes)\b/i;
const INVESTIGATE = /\b(?:audit|trace|investigate|cross-?check|verify|reconcile|inventory|enumerate|map out|work out where|find out (?:why|whether|if|where)|figure out (?:why|whether|if|where))\b/i;
const MULTI_PART = /\b(?:and then|then also|after that|followed by|as well as)\b/i;
const ACROSS = /\b(?:across|throughout|codebase|code base|repository|repo|whole project|entire project|whole vault|entire vault)\b/i;

// Things that look like work but are answered from what the model already
// knows, so sending them round the plan-and-verify loop wastes a minute and
// produces a worse answer than one turn would.
const CONVERSATIONAL = /^(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|sure|nvm|never ?mind)\b/i;
const EXPLAIN = /^\s*(?:what|who|when|why|how)\s+(?:is|are|was|were|does|do|did|should|would|can)\b/i;
const WRITE_FOR_ME = /^\s*(?:write|draft|compose|rewrite|translate|summari[sz]e|explain|describe|brainstorm|suggest|give me|tell me|make up|come up with)\b/i;

export const GOAL_MINIMUM_CHARACTERS = 40;

// The report a run produces is the answer, so a run has to be able to say
// something a single turn could not. Two substantive steps is the floor.
export const GOAL_MINIMUM_STEPS = 2;

export function shouldRunAsGoal({
  text = "",
  toolsEnabled = false,
  hasProjectFolder = false,
  hasVault = false,
  mode = "standard",
  images = []
} = {}) {
  const message = String(text).trim();
  const reasons = [];
  const refuse = (reason) => ({ escalate: false, reasons: [reason] });

  // Nothing to work over. A goal with no corpus is a chat turn with extra
  // ceremony: every research step would come back empty and the verification
  // gate would fail a goal that was never runnable.
  if (!toolsEnabled) return refuse("tools are switched off");
  if (!hasProjectFolder && !hasVault) return refuse("no project folder or vault is connected");
  // An attached image is a question about that image. Nothing in a plan can
  // look at it, because steps carry text evidence between them.
  if (images.length) return refuse("the message carries images");
  if (mode === "creative") return refuse("Muse mode is for thinking aloud, not for verified work");
  if (message.length < GOAL_MINIMUM_CHARACTERS) return refuse("too short to be a piece of work");
  if (CONVERSATIONAL.test(message)) return refuse("conversational opener");
  if (WRITE_FOR_ME.test(message)) return refuse("asks for writing, not for findings");
  // "Why does X happen" is answered from knowledge. "Find out why X happens"
  // is work — and says so, which is why INVESTIGATE is checked first.
  if (EXPLAIN.test(message) && !INVESTIGATE.test(message)) return refuse("asks for an explanation, not an investigation");

  if (SURVEY.test(message)) reasons.push("asks about every instance of something rather than one");
  if (INVESTIGATE.test(message)) reasons.push("asks for something to be established rather than recalled");
  if (MULTI_PART.test(message)) reasons.push("asks for more than one thing in order");
  if (ACROSS.test(message)) reasons.push("names a corpus rather than a subject");

  // Two independent signals. One is how you get a goal run out of "what tests
  // are there" — a question, briefly phrased, that a single turn answers well.
  if (reasons.length < 2) {
    return { escalate: false, reasons: reasons.length ? [`only one sign of multi-step work: ${reasons[0]}`] : ["reads as an ordinary question"] };
  }
  return { escalate: true, reasons };
}

// A plan Evolv may start without asking.
//
// The plan-approval screen existed because a plan could propose changes. One
// that only reads has nothing to approve — it can look at the project the same
// way answering a question in chat already does, and stopping to ask made the
// common case feel like paperwork. Anything that proposes a change still stops,
// twice over: here, and again at the tool's own approval gate.
export function planOnlyReads(plan, { readOnlyTools = [] } = {}) {
  const allowed = new Set(readOnlyTools);
  const steps = plan?.steps || [];
  if (!steps.length) return false;
  return steps.every((step) => {
    if (step.type !== "tool") return true;
    return allowed.has(step.tool);
  });
}

// What the plan is worth doing as a run at all. A "plan" that reads one file
// and reports is a chat turn that took four model calls to produce.
export function planEarnsARun(plan) {
  const steps = plan?.steps || [];
  const substantive = steps.filter((step) => !["verification", "report"].includes(step.type));
  return substantive.length >= GOAL_MINIMUM_STEPS;
}

export const CRITERIA_SYSTEM_PROMPT = "You turn a request into checkable success criteria for a bounded goal runner. "
  + "Return JSON only: {\"objective\":string,\"successCriteria\":[string]}. "
  + "The objective restates the request in one sentence. Give between one and four criteria. "
  + "Each criterion must be checkable against evidence the run collects — name what must be found, listed, or shown. "
  + "Never write a criterion about the answer's tone, length or usefulness, and never invent a requirement the request did not make.";
