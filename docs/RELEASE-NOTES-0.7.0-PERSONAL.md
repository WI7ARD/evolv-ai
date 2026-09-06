# Evolv Personal 0.7.0

This release is almost entirely about what happens when something goes wrong.
Nothing in it is a new feature you will go looking for; it is the set of
failures that used to end a conversation, and what Evolv does instead now.

## Tool calls survive the second round

Evolv talks to OpenAI through the Responses API and to Gemini through the
Interactions API. Both hand back their own representation of a tool call, and
both expect it back unchanged on the next request. Evolv used to rebuild those
calls from the pieces it recognised — a name, some arguments, an id — and
whatever it did not recognise was quietly dropped.

Gemini noticed:

    Function call is missing a thought_signature in functionCall parts.

A signature cannot be reconstructed. It is the model's own, and rebuilding a
call without it does not produce a weaker call, it produces an invalid one — so
the request fails, and the conversation is stuck for good. Evolv now stores the
provider's own step verbatim and replays it byte for byte. The same applies to
reasoning steps and to the response item ids OpenAI tracks across a turn.

**Conversations you already had cannot be repaired**, because the signature was
never recorded. Those exchanges are now handed back to the model as context —
it is told what it called and what came back — rather than being replayed as a
call the provider will refuse. The conversation keeps working; the model keeps
what it learned; nothing has to be redone.

The same applies to a conversation that changed provider halfway. A call made on
OpenAI has no Gemini signature and never will, and it is no longer sent as one.

## Providers that are having a bad minute, and providers that are down

These are different problems and they want opposite responses.

- **A dropped connection, a 429, a 502** — tried again, with a delay that grows
  and is jittered, so several conversations that failed together do not retry in
  lockstep and cause the next outage. If the provider sends `Retry-After`, that
  wins over Evolv's arithmetic.
- **A rejected API key, an unknown model, a request the provider will not
  accept** — not retried. The same request earns the same answer, and three
  attempts only delays the message telling you how to fix it.
- **A provider that has failed its last five requests** — refused immediately,
  with the reason and how long until it is tried again. Waiting out another
  timeout to be told what Evolv already knew is not worth your time.

A rejected key deliberately does *not* count towards that. It is a real fault
and a permanent one, and tripping the breaker over it would bury the one message
that says how to fix it.

Evolv still never substitutes a different provider on its own. An answer from a
model you did not choose, with nothing to indicate it happened, is worse than an
error.

## A failed tool is something the model can act on

A tool that fails hands back its error unchanged — that is the fact — followed
by Evolv's reading of it. The point is that "fix the arguments and try again",
"try something else", and "stop asking" are three different situations, and a
bare error message does not tell them apart. The common failure was a model
re-sending an identical call until it hit the round limit, spending twelve
rounds to reach an answer the first failure had already implied.

If the same call fails the same way twice, Evolv says so plainly instead of
repeating advice that was already ignored.

## A tool that had an effect does not have it twice

Evolv used to remember which tool calls it had already run in a map that lived
inside one request and died with it. Three ordinary things end a request early:
you close the window, the machine sleeps, or an approval-gated tool suspends the
run and waits for you. All three are resumed, the provider issues fresh ids for
the same work, and everything ran again.

For a file read that was only slow. For an approval-gated tool it put a second
identical proposal in front of the person who had just approved the first.

Calls whose second run costs something — sandbox writes, anything that asks for
approval — are now recognised across a resumed turn and answered from what they
produced the first time, with the model told plainly that nothing happened
twice.

Reads are deliberately not treated this way. A file listing describes something
that changes, and replaying a stored one into a later turn would be confidently
wrong in a way that simply reading the file again never is.

## A full disk no longer looks like an Evolv bug

Evolv writes everything you do to a local database, so the ordinary ways a
computer goes wrong arrive as database errors. What you used to see was:

    Unexpected server error. Reference: 4f9c1a3e-…

Your disk was full and Evolv was telling you it had a bug, with a reference
number for a log you will never read. Each of these now says what happened and
what to do:

| What went wrong | What you are told |
|---|---|
| No space left | Free some space and try again. Nothing already saved was lost. |
| Data folder read-only | Check the permissions on the folder, then restart. |
| Database in use | Another copy of Evolv is running. Close it and try again. |
| Database damaged | Where the daily backups are, and which file to restore over. |
| Disk I/O error | Check the drive is still connected, if it is external. |

A database error that means Evolv asked for something wrong is deliberately
*not* included. That is a bug, it will happen again every time, and "try
restarting" would be bad advice that also keeps it out of the logs where someone
might fix it.

A disk that fills during a turn is also no longer recorded against whichever
model happened to be selected, so a perfectly good model does not carry a
warning around after you free the space.

## Under the hood

- Five provider modules rewritten around a single event vocabulary, so the chat
  loop, the goal runner, and every adapter describe a turn the same way.
- A failure matrix covering every provider against every way a request can fail,
  checking three things each time: was it retried, did it count against the
  provider, and what were you told.
- Chaos tests that break a real database rather than a mock of one — filling it,
  overwriting a page in the middle, scribbling non-JSON into a metadata column,
  cutting a conversation across a tool exchange. Twice now SQLite has done the
  opposite of what reading the code suggested, which is the reason these are not
  written against a fake.

516 automated tests, up from 487.

## Upgrading

Nothing to do. Existing conversations, projects, and settings are unchanged, and
the database schema did not move. Conversations containing tool calls made
before this release will keep working — see the first section for exactly how
they are handled.
