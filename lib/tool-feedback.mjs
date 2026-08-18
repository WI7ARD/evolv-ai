// A failed tool call is information, not the end of the turn.
//
// Evolv already hands the model a failed tool's `{error, code}` and lets it
// continue, which is the right shape and half the job. The other half is that
// the model has to be able to tell three things apart, and a bare error message
// does not distinguish them:
//
//   - fix the arguments and try again      (a path outside the project)
//   - try something else                   (the tool is switched off)
//   - stop asking                          (this tool does not exist)
//
// Without that, the common failure is a model repeating an identical call until
// the round limit, which costs the person twelve rounds to arrive at an answer
// the first failure already implied.

// What a code means for what the model should do next. Anything unlisted is
// treated as retriable-with-changes, which is the safe default: it invites one
// more informed attempt rather than either giving up early or looping.
const GUIDANCE = {
  UNKNOWN_TOOL: { recoverable: false, advice: "This tool does not exist. Use one of the tools listed for you, or answer without it." },
  TOOL_DISABLED: { recoverable: false, advice: "This tool is switched off in settings. Do not call it again — use another tool or say what you would need." },
  VAULT_CLOUD_DISABLED: { recoverable: false, advice: "The current provider is not allowed to read vault notes. Do not retry; continue without them and say so." },
  PROJECT_REQUIRED: { recoverable: false, advice: "No project folder is connected, so there are no files to read. Say that rather than trying another path." },
  INVALID_ARGUMENT: { recoverable: true, advice: "The arguments were rejected. Read the message, correct them, and call the tool once more." },
  PATH_REJECTED: { recoverable: true, advice: "That path is outside the connected project folder. Use a path inside the project, or list the folder first." },
  NOT_FOUND: { recoverable: true, advice: "Nothing exists at that location. Search or list before reading, rather than guessing another path." },
  TIMEOUT: { recoverable: true, advice: "The tool ran too long. Narrow the request — a smaller range, a more specific query — before trying again." },
  RATE_LIMITED: { recoverable: true, advice: "The provider is rate limiting. Continue with what you already have rather than calling again immediately." }
};

const DEFAULT_GUIDANCE = { recoverable: true, advice: "Read the error, change the arguments, and try once more. If it fails the same way, continue without this tool and say what is missing." };

export function toolFailureGuidance(code) {
  return GUIDANCE[String(code || "").toUpperCase()] || DEFAULT_GUIDANCE;
}

function parseOutput(output) {
  if (output && typeof output === "object") return output;
  try {
    const parsed = JSON.parse(String(output ?? ""));
    return parsed && typeof parsed === "object" ? parsed : { error: String(output ?? "") };
  } catch {
    return { error: String(output ?? "").slice(0, 2000) };
  }
}

// A signature for "the model asked for exactly this, again". Names and
// arguments only: two calls that differ in id are still the same request.
export function callSignature(call) {
  const name = call?.function?.name || call?.name || "";
  const args = call?.function?.arguments ?? call?.arguments ?? {};
  const stable = typeof args === "string" ? args : JSON.stringify(sortKeys(args));
  return `${name}:${stable}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

// The text the model is given in place of a bare error.
//
// The error itself comes first and unaltered — it is the fact, and a model that
// reads nothing else should still see what went wrong. The advice follows,
// clearly separated, so it reads as Evolv speaking rather than as part of the
// tool's own output.
export function describeToolFailure(call, output, { repeated = 0 } = {}) {
  const parsed = parseOutput(output);
  const code = parsed.code || "";
  const { recoverable, advice } = toolFailureGuidance(code);
  const lines = [JSON.stringify({ error: parsed.error || "The tool failed.", ...(code ? { code } : {}) })];

  // A second identical failure means the advice above was not taken. Saying so
  // plainly is more useful than repeating it.
  if (repeated >= 2) {
    lines.push(`[This is attempt ${repeated} at the identical call, and it has failed the same way each time. Do not send it again. Continue with what you have and state what you could not obtain.]`);
  } else if (recoverable) {
    lines.push(`[${advice}]`);
  } else {
    lines.push(`[${advice} This will not succeed on retry.]`);
  }
  return lines.join("\n");
}

// Tracks identical failing calls within one turn, so the message above can
// escalate rather than repeat. Per-conversation and in memory: the point is to
// stop a loop inside a single answer, and a loop that spans restarts is a
// different problem.
export function createFailureLedger() {
  const seen = new Map();
  return {
    record(call) {
      const key = callSignature(call);
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      return count;
    },
    count(call) {
      return seen.get(callSignature(call)) || 0;
    },
    clear() {
      seen.clear();
    }
  };
}
