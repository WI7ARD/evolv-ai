// Which failures are the model's fault.
//
// Evolv's model list is built from what a provider says it offers, and a
// provider will happily list a model that cannot answer: pulled but deleted
// from disk, too large to load, or offered by a key that is not entitled to it.
// The list looks identical either way, so the same broken choice is made again
// tomorrow. Recording the failure is what lets the list say so.
//
// The distinction that matters is blame. Ollama being shut down fails every
// model at once, and marking them all broken would empty the dropdown of
// warnings' worth — the next launch would show a wall of red for a problem that
// was fixed by starting Ollama.

const PATTERNS = [
  // Retirement is the one failure that is known never to recover: the model is
  // gone and the provider is telling you so. Everything else here might work on
  // the next attempt, which is why only this one is marked permanent.
  { blame: "model", permanent: true,
    test: /no longer available|not available to new (users|customers)|has been (retired|deprecated|discontinued|removed|shut down)|is deprecated|model_deprecated/i,
    reason: "retired by the provider — choose a newer model" },

  // The model is the problem. These are worth remembering against it.
  { blame: "model", test: /model .*not found|no such model|pull the model|not found, try pulling/i,
    reason: "not installed — pull it again" },
  { blame: "model", test: /requires more system memory|out of memory|insufficient memory|cannot allocate/i,
    reason: "needs more memory than this computer has" },
  { blame: "model", test: /does not support tools|tools are not supported|tool use is not supported/i,
    reason: "does not support tools" },
  { blame: "model", test: /does not support (images|vision)|image input is not supported/i,
    reason: "does not support images" },
  { blame: "model", test: /context length|too many tokens|maximum context/i,
    reason: "the conversation is longer than this model's context" },
  { blame: "model", test: /model_not_found|does not exist or you do not have access/i,
    reason: "unavailable to this account" },

  // The environment is the problem. Every model fails the same way, so none of
  // them learns anything from it.
  { blame: "environment", test: /fetch failed|ECONNREFUSED|socket hang up|network|ENOTFOUND|timed out|timeout/i,
    reason: "the provider could not be reached" },
  { blame: "environment", test: /unauthori[sz]ed|invalid api key|401|403|authentication/i,
    reason: "the provider rejected the key" },
  { blame: "environment", test: /rate limit|429|quota|overloaded|capacity/i,
    reason: "the provider is rate limiting or over capacity" },

  // Not a failure. The person stopped it.
  { blame: "none", test: /aborted|interrupted|cancelled|canceled/i, reason: "" }
];

export function classifyModelFailure(message) {
  const text = String(message || "");
  const match = PATTERNS.find((pattern) => pattern.test.test(text));
  // An unrecognised error is not pinned on the model. A first sighting of an
  // unfamiliar message is a poor reason to start warning people away from a
  // model that may well work.
  if (!match) return { blame: "unknown", reason: "", permanent: false };
  return { blame: match.blame, reason: match.reason, permanent: match.permanent === true };
}

// How many consecutive failures before the list says anything. One failure is
// as likely to be a bad moment as a bad model; two in a row, with no success
// in between, is a pattern.
export const FAILURES_BEFORE_WARNING = 2;

// The rule lives here so the dropdown and Auto routing cannot disagree about
// which models are broken. A retired model is not given a second chance to
// prove it: the provider already said it is gone, and asking again spends a
// real request to be told the same thing.
export function isFailing(health) {
  return Boolean(health) && health.failures >= FAILURES_BEFORE_WARNING;
}

export function healthLabel(health) {
  if (!isFailing(health)) return "";
  return `⚠ last attempts failed: ${health.reason}`;
}
