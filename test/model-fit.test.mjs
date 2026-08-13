import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessModelFit, isFavorite, modelKey, toggleFavorite } from "../lib/model-fit.mjs";

const GB = 1e9;

test("a model larger than the machine's memory is called out before it is run", () => {
  const verdict = assessModelFit(40 * GB, 16 * GB);
  assert.equal(verdict.level, "over");
  // Both numbers, in the same units, so no arithmetic is needed to see why.
  assert.match(verdict.note, /48\.0 GB/);
  assert.match(verdict.note, /16\.0 GB/);
});

test("a model that fills most of memory is distinguished from one that does not fit", () => {
  // 11 GB needs ~13.2 GB against a 12 GB comfortable ceiling: it will load and
  // then swap, which reads as Evolv being broken rather than the model being
  // too big.
  assert.equal(assessModelFit(11 * GB, 16 * GB).level, "tight");
  assert.equal(assessModelFit(4 * GB, 16 * GB).level, "ok");
  assert.equal(assessModelFit(4 * GB, 16 * GB).note, "", "a model that fits needs no commentary");
});

test("an unknown size or unknown memory produces no verdict at all", () => {
  // Cloud models have no size. A guess here would put a warning on a model that
  // does not run on this machine in the first place.
  for (const [size, total] of [[0, 16 * GB], [4 * GB, 0], [null, null], ["", 16 * GB]]) {
    const verdict = assessModelFit(size, total);
    assert.equal(verdict.level, "unknown");
    assert.equal(verdict.note, "");
  }
});

test("favourites are scoped to the provider that offers the model", () => {
  // Two providers can offer the same model name; starring one is not starring
  // the other.
  let favorites = toggleFavorite([], "ollama", "gpt-oss:20b", true);
  assert.equal(isFavorite(favorites, "ollama", "gpt-oss:20b"), true);
  assert.equal(isFavorite(favorites, "openrouter", "gpt-oss:20b"), false);

  favorites = toggleFavorite(favorites, "ollama", "gpt-oss:20b", false);
  assert.deepEqual(favorites, []);
});

test("favouriting twice does not list a model twice, and the list stays a shortlist", () => {
  let favorites = toggleFavorite([], "ollama", "evolv:latest", true);
  favorites = toggleFavorite(favorites, "ollama", "evolv:latest", true);
  assert.deepEqual(favorites, [modelKey("ollama", "evolv:latest")]);

  for (let index = 0; index < 60; index += 1) {
    favorites = toggleFavorite(favorites, "ollama", `model-${index}`, true);
  }
  assert.equal(favorites.length, 50, "a list longer than the model list is not a shortlist");
  assert.equal(isFavorite(favorites, "ollama", "model-59"), true, "the most recent survive");
});

test("a corrupted favourites setting cannot break the list", () => {
  // Read back from settings, so it is whatever is on disk rather than what was
  // written.
  assert.equal(isFavorite(null, "ollama", "evolv:latest"), false);
  assert.equal(isFavorite("not-a-list", "ollama", "evolv:latest"), false);
  assert.deepEqual(toggleFavorite([null, 7, "ollama:keep"], "ollama", "new", true), ["ollama:keep", "ollama:new"]);
});

test("the dropdown groups favourites and shows the memory warning", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="favorite-model"/);
  assert.match(html, /aria-pressed="false"/, "a toggle has to say which way it is set");
  assert.match(app, /addModelGroup\("Favourites"/);
  assert.match(app, /addModelGroup\("All models"/);
  assert.match(app, /too big for this computer/);
  assert.match(app, /tight fit/);
  // Warned when the model is chosen, not after a reply has already failed.
  assert.match(app, /function warnAboutFit/);
});
