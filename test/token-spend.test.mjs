import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { readUsage, estimateMicros, rateFor, formatSpend, formatTokens, PRICES_UPDATED } from "../lib/token-spend.mjs";

// What a turn cost used to be two fictions: tokens estimated as characters
// divided by four, and "one cost unit" per cloud request regardless of size —
// so a two-line question and a forty-tool agent run were charged the same, and
// a monthly limit built on that capped nothing anyone cared about. The real
// counts were already arriving from the provider and being dropped.

test("the provider's own counts are read, from either provider's shape", () => {
  // OpenAI's Responses API.
  const openai = readUsage({
    input_tokens: 12_000,
    input_tokens_details: { cached_tokens: 9_000 },
    output_tokens: 800,
    output_tokens_details: { reasoning_tokens: 300 }
  });
  assert.deepEqual(openai, {
    inputTokens: 12_000, cachedInputTokens: 9_000, outputTokens: 800, reasoningTokens: 300, totalTokens: 12_800
  });

  // Ollama's own names for the same two numbers.
  const ollama = readUsage({ prompt_eval_count: 500, eval_count: 120 });
  assert.equal(ollama.inputTokens, 500);
  assert.equal(ollama.outputTokens, 120);
  assert.equal(ollama.cachedInputTokens, 0);

  // Nothing reported is nothing recorded, not a guess.
  assert.deepEqual(readUsage({}), {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0
  });
  // A provider claiming more cached input than input would otherwise produce a
  // negative fresh-input figure and a nonsense cost.
  assert.equal(readUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 900 } }).cachedInputTokens, 100);
});

test("cost is priced per model, and cached input is cheaper", () => {
  const tokens = readUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  const fresh = estimateMicros("openai", "gpt-5", tokens);
  assert.equal(fresh, 1_250_000, "a million fresh input tokens on gpt-5 is $1.25");

  const cached = estimateMicros("openai", "gpt-5",
    readUsage({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 1_000_000 } }));
  assert.ok(cached < fresh / 5, `cached input has to be much cheaper: ${cached} vs ${fresh}`);

  // Output costs more than input, which is why a chatty model is expensive.
  assert.ok(estimateMicros("openai", "gpt-5", readUsage({ output_tokens: 1_000_000 })) > fresh);

  // Longest prefix wins, or every mini model would be billed as its big sibling.
  assert.ok(rateFor("openai", "gpt-5-mini").input < rateFor("openai", "gpt-5").input);
  assert.ok(rateFor("openai", "gpt-4o-mini").input < rateFor("openai", "gpt-4o").input);

  // Local models cost nothing, and that is a fact rather than an estimate.
  assert.equal(estimateMicros("ollama", "llama3.2:3b", readUsage({ prompt_eval_count: 9e6, eval_count: 9e6 })), 0);

  // A model nobody has a rate for costs an unknown amount, which is not zero.
  // Reporting zero would quietly under-report a month.
  assert.equal(estimateMicros("openai", "some-model-shipped-tomorrow", tokens), null);
  assert.match(PRICES_UPDATED, /^\d{4}-\d{2}-\d{2}$/, "the rates have to carry the date they were taken");
});

test("figures are written so a working meter does not look broken", () => {
  // A tenth of a cent rounded to "$0.00" reads as "nothing was counted".
  assert.equal(formatSpend(300), "$0.0003");
  assert.equal(formatSpend(45_000), "$0.045");
  assert.equal(formatSpend(2_500_000), "$2.50");
  assert.equal(formatSpend(0), "$0.00");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(2_400_000), "2.40M");
  assert.equal(formatTokens(42), "42");
});

test("spend is stored, summed by month and by model, and never invented", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-spend-"));
  const database = createDatabase({ dataDir: root, dbPath: path.join(root, "p.db"), defaultPrompt: "test" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  const conversation = database.createConversation({ title: "costly" });
  const record = (model, usage, conversationId = conversation.id) => {
    const tokens = readUsage(usage);
    return database.recordTokenUsage({
      conversationId, providerId: model.startsWith("gpt") ? "openai" : "ollama", modelId: model,
      ...tokens, estimatedMicros: estimateMicros(model.startsWith("gpt") ? "openai" : "ollama", model, tokens)
    });
  };

  record("gpt-5", { input_tokens: 100_000, output_tokens: 10_000 });
  record("gpt-5-mini", { input_tokens: 50_000, output_tokens: 5_000 });
  record("llama3.2:3b", { prompt_eval_count: 900_000, eval_count: 40_000 });

  const month = database.tokenSpend({ month: new Date().toISOString().slice(0, 7) });
  assert.equal(month.turns, 3);
  assert.equal(month.inputTokens, 1_050_000);
  assert.equal(month.outputTokens, 55_000);
  // gpt-5: 100k in ($0.125) + 10k out ($0.10) = $0.225. mini: 50k in ($0.0125)
  // + 5k out ($0.01) = $0.0225. Local is free. So about $0.2475.
  assert.ok(Math.abs(month.estimatedMicros - 247_500) < 1_000, `got ${month.estimatedMicros}`);
  assert.equal(month.unpriced, 0);

  const byModel = database.tokenSpendByModel(new Date().toISOString().slice(0, 7));
  assert.equal(byModel[0].modelId, "gpt-5", "biggest spend first, which is the question being asked");
  assert.equal(byModel.length, 3);
  // Free and not-priced-here are different claims and each row has to say
  // which it is. A local model contributes a real zero; a cloud model with no
  // rate contributes an unknown, and the row carries the count that proves it.
  const local = byModel.find((row) => row.providerId === "ollama");
  assert.equal(local.estimatedMicros, 0);
  assert.equal(local.unpriced, 0, "local is free, which is a fact rather than a gap");

  // A turn the provider said nothing about is a gap in the record, not a row of
  // zeroes that would make the month look busier than it was.
  assert.equal(database.recordTokenUsage({ conversationId: conversation.id, providerId: "openai", modelId: "gpt-5" }), null);
  assert.equal(database.tokenSpend({}).turns, 3);

  // A model with no rate contributes its tokens and no money, and is counted so
  // the interface can say the estimate is incomplete rather than under-report.
  record("gpt-未来", { input_tokens: 1_000, output_tokens: 100 });
  const after = database.tokenSpend({});
  assert.equal(after.turns, 4);
  assert.equal(after.unpriced, 1);
  assert.equal(database.tokenSpendByModel(new Date().toISOString().slice(0, 7))
    .find((row) => row.modelId === "gpt-未来").unpriced, 1, "and the row says so, so the page can too");
  assert.ok(Math.abs(after.estimatedMicros - 247_500) < 1_000, "an unpriced turn adds no money");

  // And one conversation can be asked about on its own.
  assert.equal(database.tokenSpend({ conversationId: conversation.id }).turns, 4);
  assert.equal(database.tokenSpend({ conversationId: "some-other" }).turns, 0);
});

test("the page says the money is an estimate wherever it shows it", async () => {
  // The one claim that must not be overstated. Evolv cannot see what an account
  // is actually billed: rates change, they vary by tier, and discounts and free
  // allowances are invisible from here.
  const { readFile } = await import("node:fs/promises");
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(markup, /id="spend-breakdown"/);
  assert.match(markup, /estimate from published list prices/i);
  assert.match(markup, /cannot see what your account is actually billed/i);
  assert.match(script, /\/api\/spend/);
  // The rates carry the date they were taken, so a stale table is visible
  // rather than silently wrong.
  assert.match(script, /pricesUpdated/);
});
