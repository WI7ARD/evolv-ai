// Whether a local model can actually run on this computer.
//
// Evolv lists every model Ollama has pulled, and a model that is larger than
// the machine's memory is listed exactly like one that runs fine. Picking it
// fails at generation time, several seconds into a reply, with an error from
// Ollama about memory that names no fix. The size is known before any of that,
// so the warning belongs in the dropdown.

// Weights are not the whole cost: the KV cache, the context window and the
// runtime all live alongside them. A fifth over the file size is a rough figure
// but a much better one than zero, which is what assuming the file size alone
// amounts to.
const OVERHEAD = 1.2;

// Below this share of memory a model is comfortable. Above it, it will load but
// leave the machine swapping — slow enough that people assume Evolv is broken.
const TIGHT_SHARE = 0.75;

function gigabytes(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function assessModelFit(sizeBytes, totalMemoryBytes) {
  const size = Number(sizeBytes) || 0;
  const total = Number(totalMemoryBytes) || 0;
  // Cloud models have no size, and a machine that will not report its memory is
  // not grounds for a guess. Saying nothing is correct here.
  if (size <= 0 || total <= 0) return { level: "unknown", note: "" };

  const required = size * OVERHEAD;
  if (required > total) {
    return {
      level: "over",
      // Named in the units the download was measured in, so the two numbers can
      // be compared without arithmetic.
      note: `Needs about ${gigabytes(required)}, and this computer has ${gigabytes(total)} of memory. It may fail to load or run very slowly.`
    };
  }
  if (required > total * TIGHT_SHARE) {
    return {
      level: "tight",
      note: `Uses most of this computer's ${gigabytes(total)} of memory. Expect it to be slow with long conversations.`
    };
  }
  return { level: "ok", note: "" };
}

// A model is identified by provider and name together: two providers can offer
// the same name, and a favourite is a choice about one of them.
export function modelKey(provider, name) {
  return `${String(provider || "").trim()}:${String(name || "").trim()}`;
}

export function isFavorite(favorites, provider, name) {
  return (Array.isArray(favorites) ? favorites : []).includes(modelKey(provider, name));
}

// Toggling returns a new list rather than mutating, and keeps it bounded — a
// favourites list longer than the model list has stopped being a shortlist.
export function toggleFavorite(favorites, provider, name, favorite) {
  const key = modelKey(provider, name);
  const current = (Array.isArray(favorites) ? favorites : []).filter((item) => typeof item === "string" && item !== key);
  return favorite ? [...current, key].slice(-50) : current;
}
