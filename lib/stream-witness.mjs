// What a provider stream actually contained, so an adapter that understood
// none of it can say so.
//
// Both cloud adapters read a stream with a long if/else chain over event names
// and no final else. That is fine while the names match and catastrophic when
// they stop: an unrecognised event is discarded, so a whole turn arrives with
// no text, no tool call, and no error at all. The person sees an empty reply,
// or a tool call that simply never happens, and there is nothing anywhere that
// says why.
//
// This is not hypothetical. The Gemini Interactions API replaced its `outputs`
// array with a `steps` array and removed the old schema on 8 June 2026. Evolv
// pinned no revision, so the day that landed, every Gemini turn went quiet and
// every tool call stopped — with the code, the tests, and the logs all still
// reporting success.
//
// The witness makes that failure loud and, more importantly, diagnosable: the
// error names the event types the provider actually sent, which is the one
// piece of information needed to fix it.

export function createStreamWitness(providerName) {
  const seen = new Map();
  let understood = 0;
  let events = 0;

  return {
    // Every event the stream produced, recognised or not.
    saw(type) {
      events += 1;
      const key = String(type || "").trim() || "(no type field)";
      seen.set(key, (seen.get(key) || 0) + 1);
    },
    // Called whenever the adapter turned an event into something the caller can
    // use: a text delta, a tool call, a reasoning delta, a finish.
    understood() {
      understood += 1;
    },
    // A summary for logs and for the error below.
    summary() {
      return [...seen.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([type, count]) => (count > 1 ? `${type} ×${count}` : type))
        .join(", ");
    },
    // Throws when the stream said something and the adapter understood none of
    // it. Silence with no events at all is left alone: that is an empty
    // response, which is a different problem with its own handling, and a
    // provider is allowed to answer nothing.
    assertUnderstood() {
      if (understood > 0 || events === 0) return;
      throw Object.assign(
        new Error(`${providerName} sent ${events} stream event${events === 1 ? "" : "s"} and Evolv understood none of them, so this turn produced nothing. The provider's API has most likely changed shape. Events seen: ${this.summary()}.`),
        { code: "PROVIDER_STREAM_UNRECOGNIZED", status: 502, expose: true }
      );
    }
  };
}
