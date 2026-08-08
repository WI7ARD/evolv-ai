// How a single chat round's tool calls are grouped for execution.
//
// A model that asks for four crates should not wait for four sequential round
// trips. Grouping lives here rather than inline in the chat loop so it can be
// exercised on its own — importing server.mjs starts a server, which is not
// something a unit test should have to do to check a list is split correctly.

// How many tool calls a single round may have in flight at once.
export const TOOL_BATCH_SIZE = 4;

// Splits one round's tool calls into groups that may run concurrently, without
// reordering them — the transcript has to read in the order the model asked.
//
// Only the automatic tiers batch. An approval-gated tool suspends the entire
// run the moment it returns, so starting a sibling alongside it would leave
// that sibling's result arriving after the run had already ended and its
// message never written. Those get a group to themselves.
//
// A registry that cannot answer is treated as gated. Refusing to parallelize is
// the safe guess, and a name nobody recognises is about to fail anyway.
export function batchToolCalls(calls, toolRegistry, size = TOOL_BATCH_SIZE) {
  const batches = [];
  for (const call of calls) {
    const automatic = Boolean(toolRegistry?.isAutomatic?.(call.function?.name));
    const open = batches[batches.length - 1];
    if (automatic && open?.automatic && open.calls.length < size) open.calls.push(call);
    else batches.push({ automatic, calls: [call] });
  }
  return batches.map((batch) => batch.calls);
}
