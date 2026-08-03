import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizePublisher, verifyPackSignature, verifySignedEnvelope } from "./marketplace-signing.mjs";
import { fetchSignedCatalog, validateCatalogUrl } from "./marketplace-catalog.mjs";
import { readPackSourceDirectory, watchPackSource } from "./pack-dev.mjs";

export const MARKETPLACE_SCHEMA_VERSION = 1;
export const EVOLV_VERSION = "0.4.0";
export const CATEGORIES = Object.freeze([
  "development", "engineering", "embedded-systems", "linux", "productivity",
  "business", "design", "gaming", "automotive", "education"
]);

export const PERMISSIONS = Object.freeze({
  "filesystem.read.project": ["Project files", "Read files in the active project selected by you.", "medium", false],
  "filesystem.write.project": ["Edit project files", "Propose changes to active project files.", "high", false],
  "filesystem.read.user-selected": ["Selected files", "Read files you explicitly select.", "medium", false],
  "filesystem.write.user-selected": ["Edit selected files", "Propose edits to files you explicitly select.", "high", false],
  "filesystem.read.evolv-data": ["Evolv data", "Read non-secret Evolv profile data.", "high", false],
  "terminal.read-output": ["Terminal output", "Analyze terminal output supplied by you.", "medium", false],
  "terminal.execute.approved": ["Approved commands", "Request a command that runs only after approval.", "high", false],
  "terminal.execute.unrestricted": ["Unrestricted terminal", "Run commands without individual approval.", "critical", false],
  "network.local": ["Local network", "Connect to loopback or explicitly approved local services.", "medium", false],
  "network.internet": ["Internet", "Connect to external services.", "high", false],
  "network.api-provider": ["AI provider network", "Use the selected configured AI provider.", "medium", true],
  "models.local": ["Local models", "Use models running locally through Ollama.", "low", true],
  "models.cloud": ["Cloud models", "Send pack prompts to a cloud model you select.", "high", true],
  "models.send-files": ["Send files to models", "Include explicitly selected files or images in model requests.", "high", false],
  "evolv.projects.read": ["Project context", "Read Evolv project context.", "low", true],
  "evolv.projects.write": ["Project metadata", "Update Evolv project metadata.", "medium", false],
  "evolv.settings.read": ["Settings", "Read non-secret Evolv settings.", "low", true],
  "evolv.notifications": ["Notifications", "Show local Evolv notifications.", "low", true],
  "evolv.clipboard": ["Clipboard", "Read or write the clipboard after a direct action.", "medium", false],
  "serial.read": ["Serial input", "Read an explicitly selected serial device.", "high", false],
  "serial.write": ["Serial output", "Write to an explicitly selected serial device.", "high", false],
  "camera.access": ["Camera", "Use camera input after browser permission.", "high", true],
  "microphone.access": ["Microphone", "Use microphone input after browser permission.", "high", true]
});

const RUNTIME_SUPPORTED = new Set([
  "models.local", "models.cloud", "models.send-files", "network.api-provider",
  "evolv.projects.read", "evolv.projects.write", "evolv.settings.read", "evolv.notifications",
  "camera.access", "microphone.access", "filesystem.read.project", "filesystem.write.project",
  "terminal.read-output", "terminal.execute.approved", "network.internet"
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const PACK_ID = /^evolv\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ITEM_ID = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const RELEASE_CHANNELS = new Set(["stable", "beta", "nightly"]);

function timestamp() {
  return new Date().toISOString();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function compareSemver(a, b) {
  const left = String(a).match(SEMVER);
  const right = String(b).match(SEMVER);
  if (!left || !right) throw new Error("Invalid semantic version.");
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  return left[4].localeCompare(right[4]);
}

export function semverSatisfies(version, range = "*") {
  if (!SEMVER.test(String(version))) throw new Error("Invalid semantic version.");
  const expression = String(range || "*").trim();
  if (["*", "latest"].includes(expression)) return true;
  return expression.split(/\s*\|\|\s*/).some((branch) => {
    const tokens = branch.split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.every((token) => {
      const wildcard = token.match(/^(\d+|x|\*)\.(\d+|x|\*)\.(\d+|x|\*)$/i);
      if (wildcard) {
        const actual = version.match(SEMVER);
        return [1, 2, 3].every((index) => ["x", "*"].includes(wildcard[index].toLowerCase())
          || Number(wildcard[index]) === Number(actual[index]));
      }
      const shorthand = token.match(/^([~^])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
      if (shorthand) {
        const base = shorthand[2];
        if (compareSemver(version, base) < 0) return false;
        const match = base.match(SEMVER);
        const major = Number(match[1]);
        const minor = Number(match[2]);
        const patch = Number(match[3]);
        const upper = shorthand[1] === "~"
          ? `${major}.${minor + 1}.0`
          : major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
        return compareSemver(version, upper) < 0;
      }
      const comparison = token.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
      if (!comparison) throw Object.assign(new Error(`Unsupported version range: ${range}`), { status: 400 });
      const result = compareSemver(version, comparison[2]);
      return comparison[1] === ">=" ? result >= 0 : comparison[1] === "<=" ? result <= 0
        : comparison[1] === ">" ? result > 0 : comparison[1] === "<" ? result < 0 : result === 0;
    });
  });
}

export function safePackPath(value) {
  const candidate = String(value || "").replace(/\\/g, "/");
  if (!candidate || candidate.length > 240 || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)
    || candidate.split("/").some((part) => !part || part === "." || part === "..")
    || candidate.split("/").some((part) => part.startsWith("."))) {
    throw Object.assign(new Error("Installation was blocked because the package contains an unsafe file path."), { status: 400 });
  }
  return candidate;
}

function normalizeStringList(value, limit = 30, itemLimit = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit);
}

function validateConfigSchema(schema) {
  if (!plainObject(schema) || schema.type !== "object" || !plainObject(schema.properties || {})) {
    throw Object.assign(new Error("Pack configuration schema must be a JSON object schema."), { status: 400 });
  }
  const properties = {};
  for (const [key, definition] of Object.entries(schema.properties).slice(0, 40)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key) || !plainObject(definition)) throw Object.assign(new Error("Pack configuration contains an invalid field."), { status: 400 });
    if (!["string", "number", "boolean", "array"].includes(definition.type)) throw Object.assign(new Error(`Unsupported configuration type for ${key}.`), { status: 400 });
    if (definition.type === "array" && definition.items?.type !== "string") throw Object.assign(new Error(`Only string arrays are supported for ${key}.`), { status: 400 });
    properties[key] = {
      type: definition.type,
      title: String(definition.title || key).slice(0, 100),
      description: String(definition.description || "").slice(0, 500),
      ...(definition.default !== undefined ? { default: definition.default } : {}),
      ...(Array.isArray(definition.enum) ? { enum: normalizeStringList(definition.enum, 50, 200) } : {}),
      ...(definition.format ? { format: String(definition.format).slice(0, 30) } : {}),
      ...(Number.isFinite(definition.minimum) ? { minimum: Number(definition.minimum) } : {}),
      ...(Number.isFinite(definition.maximum) ? { maximum: Number(definition.maximum) } : {})
    };
    if (properties[key].format && !["secret", "file", "folder", "model"].includes(properties[key].format)) {
      throw Object.assign(new Error(`Unsupported configuration format for ${key}.`), { status: 400 });
    }
    if (properties[key].format === "secret" && properties[key].default) {
      throw Object.assign(new Error(`Secret configuration ${key} cannot define a default value.`), { status: 400 });
    }
  }
  return { type: "object", properties };
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error("Pack permissions must be an array."), { status: 400 });
  const seen = new Set();
  return value.map((entry) => {
    const item = typeof entry === "string" ? { id: entry, required: true, reason: "" } : entry;
    if (!plainObject(item) || !PERMISSIONS[item.id] || seen.has(item.id)) {
      throw Object.assign(new Error(`Unknown or duplicate pack permission: ${item?.id || "missing"}.`), { status: 400 });
    }
    seen.add(item.id);
    return {
      id: item.id,
      required: item.required !== false,
      reason: String(item.reason || "Required for the declared pack capability.").slice(0, 500)
    };
  }).slice(0, 30);
}

function normalizeDefinitionList(value, kind) {
  if (!Array.isArray(value) || !value.length) throw Object.assign(new Error(`A pack needs at least one ${kind}.`), { status: 400 });
  const ids = new Set();
  return value.slice(0, 30).map((entry) => {
    if (!plainObject(entry) || !ITEM_ID.test(entry.id) || ids.has(entry.id)) throw Object.assign(new Error(`Invalid or duplicate ${kind} ID.`), { status: 400 });
    ids.add(entry.id);
    const normalized = {
      id: entry.id,
      name: String(entry.name || "").trim().slice(0, 120),
      description: String(entry.description || "").trim().slice(0, 1000)
    };
    if (!normalized.name || !normalized.description) throw Object.assign(new Error(`${kind} name and description are required.`), { status: 400 });
    if (kind === "agent") {
      normalized.systemPrompt = String(entry.systemPrompt || "").trim().slice(0, 20_000);
      normalized.recommendedModels = normalizeStringList(entry.recommendedModels, 20, 120);
      normalized.tools = normalizeStringList(entry.tools, 20, 80);
      normalized.temperature = Math.max(0, Math.min(2, Number(entry.temperature) || 0.3));
      if (!normalized.systemPrompt) throw Object.assign(new Error("Agent systemPrompt is required."), { status: 400 });
    } else if (kind === "command") {
      normalized.agentId = String(entry.agentId || "").slice(0, 64);
      normalized.promptTemplate = String(entry.promptTemplate || "").trim().slice(0, 20_000);
      normalized.requiresApproval = entry.requiresApproval === true;
      if (!normalized.promptTemplate) throw Object.assign(new Error("Command promptTemplate is required."), { status: 400 });
    } else {
      normalized.steps = normalizeStringList(entry.steps, 12, 1000);
      if (!normalized.steps.length) throw Object.assign(new Error("Workflow steps are required."), { status: 400 });
    }
    return normalized;
  });
}

function normalizePackRelations(value, kind, ownId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error(`Pack ${kind} must be an array.`), { status: 400 });
  const seen = new Set();
  return value.slice(0, 30).map((entry) => {
    const relation = typeof entry === "string" ? { id: entry } : entry;
    if (!plainObject(relation) || !PACK_ID.test(String(relation.id || "")) || relation.id === ownId || seen.has(relation.id)) {
      throw Object.assign(new Error(`Pack ${kind} contains an invalid, duplicate, or self-referencing ID.`), { status: 400 });
    }
    seen.add(relation.id);
    const range = String(relation.range || "*").trim().slice(0, 100);
    semverSatisfies("0.0.0", range);
    return {
      id: relation.id,
      range,
      ...(kind === "dependencies" ? { optional: relation.optional === true } : {
        reason: String(relation.reason || "These packs cannot be enabled together.").slice(0, 500)
      })
    };
  });
}

export function validateManifest(raw, { evolvVersion = EVOLV_VERSION, platform = process.platform } = {}) {
  if (!plainObject(raw)) throw Object.assign(new Error("Pack manifest must be an object."), { status: 400 });
  const requiredStrings = ["id", "name", "version", "description", "fullDescription", "category", "minEvolvVersion", "license"];
  for (const key of requiredStrings) if (!String(raw[key] || "").trim()) throw Object.assign(new Error(`Pack manifest is missing ${key}.`), { status: 400 });
  if (raw.schemaVersion !== MARKETPLACE_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported pack schema version."), { status: 400 });
  if (!PACK_ID.test(raw.id)) throw Object.assign(new Error("Pack ID must use the evolv.name format."), { status: 400 });
  if (!SEMVER.test(raw.version) || !SEMVER.test(raw.minEvolvVersion)) throw Object.assign(new Error("Pack versions must use semantic versioning."), { status: 400 });
  if (!CATEGORIES.includes(raw.category)) throw Object.assign(new Error("Pack category is not recognized."), { status: 400 });
  if (!plainObject(raw.author) || !String(raw.author.name || "").trim()) throw Object.assign(new Error("Pack author is required."), { status: 400 });
  if (compareSemver(evolvVersion, raw.minEvolvVersion) < 0) {
    throw Object.assign(new Error(`This pack requires Evolv ${raw.minEvolvVersion} or newer.`), { status: 409 });
  }
  const platforms = normalizeStringList(raw.platforms, 5, 20);
  const normalizedPlatform = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  if (!platforms.includes(normalizedPlatform)) throw Object.assign(new Error(`This pack does not support ${normalizedPlatform}.`), { status: 409 });
  const manifest = {
    schemaVersion: MARKETPLACE_SCHEMA_VERSION,
    id: raw.id,
    name: String(raw.name).slice(0, 120),
    version: raw.version,
    author: { name: String(raw.author.name).slice(0, 120), url: String(raw.author.url || "").slice(0, 500) },
    description: String(raw.description).slice(0, 300),
    fullDescription: String(raw.fullDescription).slice(0, 5000),
    category: raw.category,
    license: String(raw.license).slice(0, 200),
    tags: normalizeStringList(raw.tags, 30, 50),
    icon: String(raw.icon || "◇").slice(0, 8),
    screenshots: normalizeStringList(raw.screenshots, 6, 200),
    minEvolvVersion: raw.minEvolvVersion,
    platforms,
    models: {
      local: normalizeStringList(raw.models?.local, 30, 120),
      cloud: normalizeStringList(raw.models?.cloud, 30, 120)
    },
    permissions: normalizePermissions(raw.permissions),
    installedSize: Math.max(1, Math.min(100_000_000, Number(raw.installedSize) || 1)),
    changelog: normalizeStringList(raw.changelog, 20, 1000),
    configSchema: validateConfigSchema(raw.configSchema || { type: "object", properties: {} }),
    agents: normalizeDefinitionList(raw.agents, "agent"),
    commands: normalizeDefinitionList(raw.commands, "command"),
    workflows: normalizeDefinitionList(raw.workflows, "workflow"),
    examples: normalizeStringList(raw.examples, 20, 500),
    features: normalizeStringList(raw.features, 20, 300),
    documentation: String(raw.documentation || "").slice(0, 30_000),
    knowledge: normalizeStringList(raw.knowledge, 30, 5000),
    dependencies: normalizePackRelations(raw.dependencies, "dependencies", raw.id),
    conflicts: normalizePackRelations(raw.conflicts, "conflicts", raw.id),
    releaseChannel: RELEASE_CHANNELS.has(raw.releaseChannel) ? raw.releaseChannel : "stable",
    // Verification is derived from a cryptographic signature or the bundled
    // provider boundary. A manifest can never award this badge to itself.
    verified: false,
    featured: raw.featured === true,
    price: Math.max(0, Number(raw.price) || 0),
    rating: Math.max(0, Math.min(5, Number(raw.rating) || 0)),
    reviewCount: Math.max(0, Math.trunc(Number(raw.reviewCount) || 0)),
    publishedAt: String(raw.publishedAt || timestamp()).slice(0, 40),
    updatedAt: String(raw.updatedAt || timestamp()).slice(0, 40)
  };
  const agentIds = new Set(manifest.agents.map((item) => item.id));
  for (const command of manifest.commands) {
    if (command.agentId && !agentIds.has(command.agentId)) throw Object.assign(new Error(`Command ${command.id} references a missing agent.`), { status: 400 });
  }
  return manifest;
}

export function validatePackPackage(raw, options = {}) {
  if (!plainObject(raw) || raw.packageVersion !== 1 || !plainObject(raw.manifest)) {
    throw Object.assign(new Error("This is not a valid .evolvpack package."), { status: 400 });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(raw));
  if (serializedBytes > MAX_PACKAGE_BYTES) throw Object.assign(new Error("The .evolvpack file is too large."), { status: 413 });
  const files = {};
  for (const [name, content] of Object.entries(raw.files || {})) {
    const safeName = safePackPath(name);
    if (safeName.toLowerCase() === "manifest.json") throw Object.assign(new Error("manifest.json must not be duplicated inside package files."), { status: 400 });
    if (typeof content !== "string") throw Object.assign(new Error(`Pack file ${safeName} must contain text.`), { status: 400 });
    files[safeName] = content.slice(0, 500_000);
  }
  const packPackage = {
    packageVersion: 1,
    manifest: validateManifest(raw.manifest, options),
    files,
    ...(raw.publisher !== undefined ? { publisher: normalizePublisher(raw.publisher) } : {}),
    ...(raw.signature !== undefined ? { signature: {
      algorithm: String(raw.signature?.algorithm || ""),
      keyId: String(raw.signature?.keyId || "").toLowerCase(),
      value: String(raw.signature?.value || "")
    } } : {})
  };
  const verification = options.bundledTrust
    ? {
        state: "bundled",
        valid: true,
        trusted: true,
        keyId: "builtin:evolv-labs",
        publisher: { id: "evolv-labs", name: "Evolv Labs" }
      }
    : verifyPackSignature(packPackage, { trustedKeyIds: options.trustedKeyIds || [] });
  packPackage.verification = verification;
  packPackage.manifest.verified = verification.trusted;
  packPackage.manifest.publisherVerification = {
    state: verification.state,
    valid: verification.valid,
    trusted: verification.trusted,
    keyId: verification.keyId,
    publisher: verification.publisher
  };
  return packPackage;
}

export function permissionDiff(previous = [], next = []) {
  const old = new Set(previous.map((item) => typeof item === "string" ? item : item.id));
  const current = new Set(next.map((item) => typeof item === "string" ? item : item.id));
  return {
    added: [...current].filter((item) => !old.has(item)),
    removed: [...old].filter((item) => !current.has(item))
  };
}

export function validateConfiguration(schema, value) {
  if (!plainObject(value)) throw Object.assign(new Error("Configuration must be an object."), { status: 400 });
  const result = {};
  const errors = {};
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    let candidate = value[key] ?? definition.default;
    if (candidate === undefined) continue;
    if (definition.type === "string") {
      if (typeof candidate !== "string" || (definition.enum && !definition.enum.includes(candidate))) errors[key] = "Choose a valid value.";
      else result[key] = candidate.slice(0, 5000);
    } else if (definition.type === "number") {
      candidate = Number(candidate);
      if (!Number.isFinite(candidate) || candidate < (definition.minimum ?? -Infinity) || candidate > (definition.maximum ?? Infinity)) errors[key] = "Enter a valid number.";
      else result[key] = candidate;
    } else if (definition.type === "boolean") {
      if (typeof candidate !== "boolean") errors[key] = "Choose on or off.";
      else result[key] = candidate;
    } else if (definition.type === "array") {
      if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) errors[key] = "Enter a list of text values.";
      else result[key] = candidate.slice(0, 50).map((item) => item.slice(0, 500));
    }
  }
  if (Object.keys(errors).length) throw Object.assign(new Error("Configuration is invalid. Check the highlighted fields."), { status: 400, details: errors });
  return result;
}

function defaultsFor(schema) {
  return Object.fromEntries(Object.entries(schema.properties || {})
    .filter(([, definition]) => definition.default !== undefined)
    .map(([key, definition]) => [key, clone(definition.default)]));
}

function pack(definition) {
  const agentId = `${definition.slug}-agent`;
  const permissions = [
    { id: "models.local", required: true, reason: "Run the specialist agent with a local model." },
    { id: "evolv.projects.read", required: true, reason: "Use project context explicitly supplied in Evolv." },
    ...(definition.permissions || [])
  ];
  const manifest = {
    schemaVersion: 1,
    id: `evolv.${definition.slug}`,
    name: definition.name,
    version: definition.version || "1.0.0",
    author: { name: "Evolv Labs", url: "https://evolv.local" },
    description: definition.description,
    fullDescription: definition.fullDescription,
    category: definition.category,
    tags: definition.tags,
    icon: definition.icon,
    screenshots: [`/assets/marketplace/${definition.slug}.jpg`],
    minEvolvVersion: "0.4.0",
    license: "Evolv Community Pack License",
    platforms: ["windows", "linux", "macos"],
    models: { local: ["qwen", "llama", "phi", "mistral"], cloud: ["openai", "anthropic", "gemini"] },
    permissions,
    installedSize: 32_000 + definition.fullDescription.length * 10,
    changelog: definition.changelog || ["1.0.0 — Initial specialist agent, commands, workflow, and documentation."],
    configSchema: { type: "object", properties: definition.config },
    agents: [{
      id: agentId,
      name: definition.name,
      description: definition.description,
      systemPrompt: definition.prompt,
      recommendedModels: ["qwen2.5:7b", "llama3.2:3b"],
      tools: [],
      temperature: definition.temperature ?? 0.25
    }],
    commands: definition.commands.map(([id, name, description, promptTemplate, requiresApproval = false]) => ({
      id, name, description, agentId, promptTemplate, requiresApproval
    })),
    workflows: [{
      id: `${definition.slug}-workflow`,
      name: `${definition.name} guided session`,
      description: `A repeatable, evidence-first ${definition.name.toLowerCase()} workflow.`,
      steps: definition.workflow
    }],
    examples: definition.examples,
    features: definition.features,
    documentation: `# ${definition.name}\n\n${definition.fullDescription}\n\n## Method\n\n${definition.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n## Safety\n\n${definition.safety}`,
    knowledge: definition.knowledge,
    verified: true,
    featured: definition.featured === true,
    price: definition.price || 0,
    rating: definition.rating,
    reviewCount: definition.reviewCount,
    publishedAt: definition.publishedAt,
    updatedAt: definition.updatedAt
  };
  return { packageVersion: 1, manifest, files: {
    "README.md": manifest.documentation,
    "CHANGELOG.md": manifest.changelog.join("\n"),
    "knowledge/reference.md": definition.knowledge.join("\n\n"),
    "templates/session.md": definition.workflow.map((step) => `- [ ] ${step}`).join("\n")
  }};
}

const PACK_DEFINITIONS = [
  {
    slug: "arduino-debugger", name: "Arduino Debugger", icon: "⌁", category: "embedded-systems", featured: true,
    description: "Diagnose sketches, compiler output, serial logs, wiring, sensors, timing, and interrupts.",
    fullDescription: "An evidence-first Arduino debugging partner that separates confirmed defects from hypotheses and starts with the smallest safe test.",
    tags: ["arduino", "embedded", "serial", "wiring", "debugging"], rating: 4.8, reviewCount: 184, publishedAt: "2026-03-10", updatedAt: "2026-07-22",
    permissions: [{ id: "serial.read", required: false, reason: "Optionally analyze serial data from a device you select." }, { id: "filesystem.read.project", required: false, reason: "Optionally inspect an Arduino project you select." }],
    config: { defaultBoard: { type: "string", title: "Default board", default: "arduino:nano", description: "Board used when a request does not name one." }, includeWiringChecklist: { type: "boolean", title: "Include wiring checklist", default: true } },
    prompt: "You are an embedded-systems debugger. Diagnose Arduino code, compiler output, board selection, wiring and serial logs. Separate confirmed issues, likely causes, and untested hypotheses. Never suggest wiring changes while powered. Recommend the smallest safe test first and call out voltage or current hazards.",
    commands: [
      ["diagnose-sketch", "Diagnose Arduino sketch", "Review code, board, wiring and logs.", "Diagnose this Arduino project. Context: {{input}}. Separate confirmed problems from hypotheses and recommend the smallest safe test first."],
      ["explain-compiler-error", "Explain compiler error", "Translate compiler output into a focused repair.", "Explain this Arduino compiler output, identify the originating line or dependency, and propose the smallest correction: {{input}}"],
      ["inspect-serial-log", "Inspect serial log", "Find patterns in bounded serial output.", "Inspect this serial log for timing, resets, sensor errors, and malformed data: {{input}}"],
      ["wiring-checklist", "Generate wiring checklist", "Create a power-off verification checklist.", "Create a safe power-off wiring checklist for: {{input}}"]
    ],
    workflow: ["Confirm board, power and expected behavior.", "Reproduce with the smallest sketch.", "Compare compiler and serial evidence.", "Test one hypothesis at a time.", "Record the verified fix."],
    examples: ["Diagnose an I2C sensor returning -1", "Explain an avrdude upload failure", "Find a blocking delay in a motor loop", "Check interrupt safety", "Build a Nano wiring checklist"],
    features: ["Sketch review", "Compiler diagnosis", "Serial pattern analysis", "Pin-conflict checks", "Safe wiring checklist"],
    knowledge: ["Never change wiring while a circuit is powered.", "Board core, selected port, voltage level and common ground are first-line checks."],
    safety: "Disconnect power before wiring changes and verify component voltage/current limits."
  },
  {
    slug: "linux-repair", name: "Linux Repair Agent", icon: "⌘", category: "linux",
    description: "Diagnose Linux Mint, APT, disks, services, permissions, drivers, logs, and Ollama.",
    fullDescription: "A conservative Linux Mint repair specialist that explains evidence and produces reversible plans before any command is considered.",
    tags: ["linux-mint", "apt", "systemd", "ollama", "drivers"], rating: 4.9, reviewCount: 263, publishedAt: "2026-02-04", updatedAt: "2026-07-25",
    permissions: [{ id: "terminal.read-output", required: false, reason: "Analyze terminal output pasted or explicitly provided by you." }, { id: "filesystem.read.user-selected", required: false, reason: "Read a log file you explicitly select." }],
    config: { distribution: { type: "string", title: "Distribution", default: "Linux Mint 22" }, commandStyle: { type: "string", title: "Command style", enum: ["explain-first", "commands-with-confirmation"], default: "explain-first" } },
    prompt: "You are a cautious Linux Mint repair engineer. Explain what the evidence means, protect user data, prefer read-only diagnostics, and present a reversible plan before commands. Never invent command results. Flag destructive, privilege-changing, bootloader, disk, or driver operations clearly.",
    commands: [
      ["diagnose-system", "Diagnose system issue", "Turn symptoms into an ordered diagnostic plan.", "Diagnose this Linux Mint issue. Explain likely layers and begin with read-only checks: {{input}}"],
      ["explain-output", "Explain terminal output", "Explain bounded command output line by line.", "Explain this terminal output, distinguish warnings from blockers, and do not assume commands were run: {{input}}"],
      ["safe-repair-plan", "Create safe repair plan", "Build a reversible repair sequence.", "Create a staged, reversible Linux repair plan with backup and rollback checkpoints: {{input}}"],
      ["audit-disk", "Audit disk usage", "Plan a non-destructive disk-usage investigation.", "Create a read-only disk usage audit for this situation: {{input}}"]
    ],
    workflow: ["Protect data and capture symptoms.", "Collect read-only system facts.", "Identify the failing layer.", "Propose the smallest reversible change.", "Verify and document rollback."],
    examples: ["Repair broken APT dependencies", "Explain a failed systemd service", "Find safe disk cleanup targets", "Troubleshoot NVIDIA after update", "Diagnose Ollama startup"],
    features: ["Mint-focused triage", "APT diagnosis", "Service and log analysis", "Driver planning", "Ollama troubleshooting"],
    knowledge: ["Back up irreplaceable data before storage, boot, or package surgery.", "Prefer read-only evidence before changing packages or permissions."],
    safety: "Commands are explanatory plans only; destructive actions require separate human review."
  },
  {
    slug: "repository-auditor", name: "Repository Auditor", icon: "◇", category: "development", featured: true,
    description: "Audit architecture, security, dead code, tests, documentation, dependencies, and builds.",
    fullDescription: "A structured repository reviewer that ranks concrete findings by impact, cites evidence, and avoids speculative churn.",
    tags: ["repository", "security", "architecture", "testing", "dependencies"], rating: 4.8, reviewCount: 211, publishedAt: "2026-03-15", updatedAt: "2026-07-27",
    permissions: [{ id: "filesystem.read.project", required: false, reason: "Inspect files in a project you explicitly place in scope." }],
    config: { severityFloor: { type: "string", title: "Minimum severity", enum: ["low", "medium", "high"], default: "medium" }, includeDeadCode: { type: "boolean", title: "Review dead code", default: true } },
    prompt: "You are a senior repository auditor. Report only actionable findings supported by specific evidence. Rank by severity and confidence. Review architecture, security boundaries, tests, dependencies, docs and build reliability. Do not modify files. Separate defects from optional polish.",
    commands: [
      ["audit-repository", "Audit repository", "Run a structured repository review.", "Audit this repository context and return ranked evidence-backed findings: {{input}}"],
      ["find-risks", "Find architectural risks", "Identify coupling and fragile boundaries.", "Identify architectural risks, ownership gaps, unsafe trust boundaries, and likely failure modes in: {{input}}"],
      ["missing-docs", "Detect missing documentation", "Find documentation gaps that block use or maintenance.", "Review documentation completeness for setup, operation, security, recovery and contribution: {{input}}"],
      ["dependency-health", "Review dependency health", "Assess dependency purpose, risk and maintenance.", "Review this dependency information for unnecessary, vulnerable, stale, or poorly bounded packages: {{input}}"]
    ],
    workflow: ["Map entry points and trust boundaries.", "Inspect high-risk paths.", "Compare behavior with tests and docs.", "Rank findings by impact and evidence.", "Recommend the smallest verification step."],
    examples: ["Review an Electron security boundary", "Find missing recovery docs", "Audit API authorization", "Check dependency purpose", "Prioritize flaky tests"],
    features: ["Evidence-backed findings", "Severity ranking", "Security review", "Test-gap analysis", "Documentation audit"],
    knowledge: ["A useful audit finding names the behavior, evidence, impact and verification.", "Avoid reporting style preferences as correctness defects."],
    safety: "Never execute repository code or change files as part of an audit."
  },
  {
    slug: "ui-critic", name: "UI Critic", icon: "▦", category: "design", featured: true,
    description: "Review screenshots for hierarchy, spacing, typography, accessibility, responsiveness, and desktop UX.",
    fullDescription: "A precise desktop-interface critic that converts screenshots and product goals into prioritized, testable polish work.",
    tags: ["ui", "ux", "accessibility", "screenshot", "desktop"], rating: 4.7, reviewCount: 156, publishedAt: "2026-04-02", updatedAt: "2026-07-24",
    permissions: [{ id: "models.send-files", required: false, reason: "Send an explicitly attached screenshot to the selected model." }],
    config: { target: { type: "string", title: "Primary target", enum: ["desktop", "responsive-desktop", "web"], default: "desktop" }, accessibilityLevel: { type: "string", title: "Accessibility target", enum: ["WCAG AA", "WCAG AAA"], default: "WCAG AA" } },
    prompt: "You are a senior desktop UI critic. Inspect hierarchy, spacing, typography, contrast, focus, density, responsiveness, state clarity and consistency. Cite visible evidence, distinguish definite issues from inferred risks, and return a prioritized polish plan with measurable acceptance criteria.",
    commands: [
      ["review-screenshot", "Review screenshot", "Perform a structured visual review.", "Review the attached screenshot and this context. Rank the five highest-impact improvements: {{input}}"],
      ["spacing-review", "Identify spacing issues", "Find rhythm, alignment and density problems.", "Review spacing, alignment, grouping and density in: {{input}}"],
      ["accessibility-check", "Check accessibility", "Check contrast, labels, focus and non-color state.", "Perform a WCAG-oriented accessibility review of: {{input}}"],
      ["polish-plan", "Generate polish plan", "Turn findings into an ordered implementation pass.", "Create an ordered UI polish plan with acceptance criteria for: {{input}}"]
    ],
    workflow: ["Identify the primary task and viewport.", "Inspect hierarchy and state.", "Check spacing and typography.", "Check keyboard and accessibility.", "Prioritize fixes with acceptance criteria."],
    examples: ["Review a settings screenshot", "Improve sidebar density", "Check a dialog for keyboard use", "Find contrast failures", "Plan a responsive desktop pass"],
    features: ["Screenshot critique", "Accessibility review", "Spacing analysis", "Desktop UX heuristics", "Acceptance criteria"],
    knowledge: ["Critical state must not depend only on color.", "Desktop density should remain readable at the minimum supported window."],
    safety: "Do not claim interactions were tested from a static screenshot."
  },
  {
    slug: "local-ai-setup", name: "Local AI Setup Assistant", icon: "AI", category: "engineering", featured: true,
    description: "Plan Ollama setup, model selection, quantization, storage, context, performance, and troubleshooting.",
    fullDescription: "A hardware-aware local AI guide that favors measured fit over model hype and calls out storage, memory, privacy, and performance tradeoffs.",
    tags: ["ollama", "local-ai", "models", "quantization", "performance"], rating: 4.9, reviewCount: 301, publishedAt: "2026-01-18", updatedAt: "2026-07-29",
    permissions: [{ id: "network.local", required: false, reason: "Optionally inspect the local Ollama service." }, { id: "evolv.settings.read", required: false, reason: "Use non-secret configured model preferences." }],
    config: { memoryGb: { type: "number", title: "System memory (GB)", default: 16, minimum: 4, maximum: 1024 }, priority: { type: "string", title: "Priority", enum: ["speed", "quality", "balanced"], default: "balanced" } },
    prompt: "You are a local AI deployment engineer. Recommend Ollama models based on real RAM/VRAM, storage, task, context, speed and privacy constraints. Label estimates, avoid invented benchmarks, and propose a small test prompt before a large download.",
    commands: [
      ["choose-model", "Choose local model", "Match hardware and task to a model tier.", "Recommend a short list of Ollama models for this hardware and workload, with memory estimates labeled as estimates: {{input}}"],
      ["estimate-performance", "Estimate performance", "Estimate fit and bottlenecks without fake precision.", "Estimate local inference fit, likely bottlenecks, storage and context tradeoffs for: {{input}}"],
      ["troubleshoot-ollama", "Troubleshoot Ollama", "Diagnose local service and model failures.", "Create an evidence-first Ollama troubleshooting plan for: {{input}}"],
      ["prompt-test", "Create model test", "Create a repeatable quality and speed comparison.", "Design a small repeatable prompt test for comparing these local models: {{input}}"]
    ],
    workflow: ["Capture hardware and workload.", "Set privacy and latency goals.", "Choose two realistic model tiers.", "Run a small repeatable test.", "Record quality, speed and memory."],
    examples: ["Pick a coding model for 16 GB RAM", "Compare Q4 and Q8", "Fix an Ollama connection error", "Plan model disk storage", "Test long-context quality"],
    features: ["Hardware-aware selection", "Quantization guidance", "Context planning", "Ollama diagnostics", "Prompt benchmarks"],
    knowledge: ["Model memory use depends on weights, context cache, backend and concurrency.", "Validate on the actual machine before committing to a large model."],
    safety: "Never present estimated tokens per second or memory as a measured result."
  },
  {
    slug: "motorcycle-maintenance", name: "Motorcycle Maintenance Assistant", icon: "⚙", category: "automotive",
    description: "Organize maintenance, inspections, service intervals, troubleshooting, safety, and parts records.",
    fullDescription: "A record-centered motorcycle maintenance assistant that prioritizes the service manual, safe inspection, and qualified repair for critical systems.",
    tags: ["motorcycle", "maintenance", "inspection", "parts", "safety"], rating: 4.6, reviewCount: 88, publishedAt: "2026-05-03", updatedAt: "2026-07-11",
    config: { units: { type: "string", title: "Units", enum: ["miles", "kilometers"], default: "miles" }, remindSafetyChecks: { type: "boolean", title: "Include pre-ride checks", default: true } },
    prompt: "You are a conservative motorcycle maintenance record assistant. Use the exact model/year service manual as authority for torque, fluids and intervals. Give power-off inspection steps, identify stop-riding conditions, and refer brakes, tires, steering, fuel leaks and structural faults to a qualified technician. Never advise bypassing safety systems.",
    commands: [
      ["maintenance-plan", "Build maintenance plan", "Create a manual-driven service schedule.", "Create a maintenance plan for this motorcycle and mileage. Mark values that require the exact service manual: {{input}}"],
      ["inspection-checklist", "Create inspection checklist", "Generate a safety-first inspection.", "Create a power-off inspection and pre-ride checklist for: {{input}}"],
      ["troubleshoot-symptom", "Troubleshoot symptom", "Separate safe checks from shop work.", "Triage this motorcycle symptom. Identify stop-riding conditions and safe checks only: {{input}}"],
      ["parts-record", "Create parts record", "Structure a parts and service entry.", "Turn this information into a parts and maintenance record with source and date fields: {{input}}"]
    ],
    workflow: ["Identify exact year/model and manual.", "Check stop-riding hazards.", "Record symptoms and service history.", "Perform safe visual checks.", "Escalate critical systems appropriately."],
    examples: ["Plan 12,000-mile service", "Create a chain inspection", "Triage a fuel smell", "Track tire replacement", "Record oil and filter"],
    features: ["Service records", "Inspection checklists", "Safety triage", "Parts tracking", "Manual reminders"],
    knowledge: ["The exact service manual controls torque and fluid specifications.", "Brakes, tires, steering and fuel leaks are safety-critical."],
    safety: "No reckless riding advice, safety-system bypasses, or invented specifications."
  },
  {
    slug: "small-business-knowledge", name: "Small Business Knowledge Assistant", icon: "§", category: "business",
    description: "Turn procedures, policies, checklists, and documents into attributable staff answers.",
    fullDescription: "A source-conscious internal knowledge assistant for small teams, designed to expose uncertainty and keep policy owners in control.",
    tags: ["business", "knowledge-base", "procedures", "policies", "staff"], rating: 4.7, reviewCount: 121, publishedAt: "2026-04-20", updatedAt: "2026-07-20",
    permissions: [{ id: "filesystem.read.user-selected", required: false, reason: "Read business documents you explicitly select." }],
    config: { organizationName: { type: "string", title: "Organization name", default: "My Business" }, requireCitations: { type: "boolean", title: "Require source references", default: true } },
    prompt: "You are an internal small-business knowledge assistant. Answer from supplied sources, cite document title and section, distinguish policy from suggestion, say when evidence is missing or stale, and identify the policy owner who should confirm consequential changes.",
    commands: [
      ["answer-staff-question", "Answer staff question", "Answer with source attribution and uncertainty.", "Answer this staff question using only supplied business knowledge. Cite sources and list missing evidence: {{input}}"],
      ["write-procedure", "Draft procedure", "Create a reviewable operating procedure.", "Draft a clear procedure with owner, prerequisites, steps, exceptions, evidence, review date and approval status: {{input}}"],
      ["build-checklist", "Build checklist", "Convert a process into an operational checklist.", "Convert this process into a concise checklist with stop conditions and escalation owner: {{input}}"],
      ["knowledge-gap", "Find knowledge gaps", "Identify missing, conflicting or stale guidance.", "Audit this internal knowledge for gaps, conflicts, stale dates and missing owners: {{input}}"]
    ],
    workflow: ["Identify question and audience.", "Retrieve approved sources.", "Compare dates and conflicts.", "Answer with attribution.", "Route gaps to an owner."],
    examples: ["Answer an opening procedure question", "Draft customer refund SOP", "Create onboarding checklist", "Find conflicting policies", "Prepare policy review list"],
    features: ["Source attribution", "Procedure drafting", "Checklist creation", "Gap analysis", "Policy ownership"],
    knowledge: ["Operational answers should name their source and last-reviewed date.", "Unapproved drafts must not be represented as active policy."],
    safety: "Do not invent company policy, legal obligations, or approvals."
  },
  {
    slug: "game-development", name: "Game Development Assistant", icon: "◆", category: "gaming",
    description: "Plan and debug Godot, Unity, gameplay, levels, saves, performance, and production scope.",
    fullDescription: "A practical game-development partner focused on playable slices, reproducible bugs, maintainable systems, and realistic production scope.",
    tags: ["godot", "unity", "gameplay", "level-design", "performance"], rating: 4.8, reviewCount: 177, publishedAt: "2026-03-28", updatedAt: "2026-07-26",
    permissions: [{ id: "filesystem.read.project", required: false, reason: "Inspect game project files you explicitly place in scope." }],
    config: { engine: { type: "string", title: "Default engine", enum: ["Godot 4", "Unity", "Engine-agnostic"], default: "Godot 4" }, prototypeBias: { type: "boolean", title: "Prefer playable prototypes", default: true } },
    prompt: "You are a senior game developer and technical designer. Prefer small playable slices, explicit state machines, deterministic reproduction, profiler evidence, versioned saves and scope control. Distinguish design preference from technical defect and give engine/version-specific advice only when known.",
    commands: [
      ["debug-system", "Debug gameplay system", "Build a minimal reproduction and ranked hypotheses.", "Debug this gameplay system. Define expected state, reproduction, evidence, likely causes, and smallest test: {{input}}"],
      ["plan-feature", "Plan feature slice", "Reduce a feature to a playable vertical slice.", "Plan the smallest playable vertical slice for this feature, including systems, assets, tests and cut line: {{input}}"],
      ["review-save", "Review save system", "Check versioning, atomicity and recovery.", "Review this save system for schema versioning, atomic writes, corruption recovery and compatibility: {{input}}"],
      ["performance-plan", "Create performance plan", "Design a profiler-led optimization pass.", "Create a profiler-first performance investigation for: {{input}}"]
    ],
    workflow: ["Define player-visible behavior.", "Build a minimal reproduction or slice.", "Instrument before optimizing.", "Implement one bounded system.", "Playtest, record and control scope."],
    examples: ["Debug Godot state transitions", "Plan an inventory slice", "Review Unity save data", "Profile frame spikes", "Scope a solo-dev level"],
    features: ["Godot and Unity guidance", "Gameplay debugging", "Vertical-slice planning", "Save-system review", "Profiler-led optimization"],
    knowledge: ["Profile before optimizing.", "Version save schemas and write atomically.", "A vertical slice proves the full production loop."],
    safety: "Do not claim engine APIs or performance measurements without version-specific evidence."
  }
];

const BUNDLED_PACKAGES = PACK_DEFINITIONS.map(pack);
const FIRST_PARTY_PACK_IDS = new Set(BUNDLED_PACKAGES.map((item) => item.manifest.id));
// This personal developer pack ships with Evolv so it is installable without
// importing a file. It intentionally remains labelled unsigned/personal rather
// than inheriting the first-party Evolv Labs trust badge.
const AUTONOMOUS_ENGINEER_PACKAGE = JSON.parse(fs.readFileSync(new URL("../packs/evolv-autonomous-engineer.evolvpack", import.meta.url), "utf8"));
BUNDLED_PACKAGES.push(AUTONOMOUS_ENGINEER_PACKAGE);
const ARDUINO_V1 = clone(BUNDLED_PACKAGES[0]);
ARDUINO_V1.manifest.version = "1.0.0";
ARDUINO_V1.manifest.updatedAt = "2026-06-01";
ARDUINO_V1.manifest.changelog = ["1.0.0 — Initial Arduino diagnostics."];
BUNDLED_PACKAGES[0].manifest.version = "1.1.0";
BUNDLED_PACKAGES[0].manifest.changelog = [
  "1.1.0 — Added interrupt/timing guidance and wiring checklist command.",
  "1.0.0 — Initial Arduino diagnostics."
];

export class MarketplaceProvider {
  listPacks() { throw new Error("Marketplace provider listPacks() is not implemented."); }
  getPack() { throw new Error("Marketplace provider getPack() is not implemented."); }
  getAvailableVersion() { throw new Error("Marketplace provider getAvailableVersion() is not implemented."); }
  versions() { return []; }
}

export class BundledMarketplaceProvider extends MarketplaceProvider {
  constructor() {
    super();
    this.packages = new Map(BUNDLED_PACKAGES.map((item) => [item.manifest.id, [item, ...(item.manifest.id === "evolv.arduino-debugger" ? [ARDUINO_V1] : [])]]));
  }
  listPacks() {
    return [...this.packages.values()].map((versions) => {
      const manifest = clone(versions[0].manifest);
      const trusted = FIRST_PARTY_PACK_IDS.has(manifest.id);
      return {
        ...manifest,
        verified: trusted,
        publisherVerification: trusted ? {
          state: "bundled", valid: true, trusted: true, keyId: "builtin:evolv-labs",
          publisher: { id: "evolv-labs", name: "Evolv Labs" }
        } : { state: "unsigned", valid: false, trusted: false, keyId: "", publisher: null }
      };
    });
  }
  isTrusted(id) { return FIRST_PARTY_PACK_IDS.has(id); }
  getPack(id, version = "") {
    const versions = this.packages.get(id) || [];
    const item = version ? versions.find((candidate) => candidate.manifest.version === version) : versions[0];
    return item ? clone(item) : null;
  }
  getAvailableVersion(id) {
    return this.packages.get(id)?.[0]?.manifest.version || null;
  }
  versions(id) {
    return (this.packages.get(id) || []).map((item) => item.manifest.version);
  }
}

function rowToInstalled(row) {
  if (!row) return null;
  const manifest = JSON.parse(row.manifest_json);
  manifest.dependencies ||= [];
  manifest.conflicts ||= [];
  return {
    id: row.id,
    version: row.version,
    enabled: Boolean(row.enabled),
    source: row.source,
    releaseChannel: RELEASE_CHANNELS.has(row.release_channel) ? row.release_channel : "stable",
    grantedPermissions: JSON.parse(row.granted_permissions_json || "[]"),
    config: JSON.parse(row.config_json || "{}"),
    status: row.status,
    error: row.error || "",
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || null,
    manifest,
    packageMetadata: JSON.parse(row.package_metadata_json || "{}")
  };
}

export class MarketplaceService {
  constructor({ database, profileDir, secretStore = null, host = null, platform = process.platform, version = EVOLV_VERSION, provider = new BundledMarketplaceProvider() }) {
    this.database = database;
    this.db = database.raw;
    this.profileDir = path.resolve(profileDir);
    this.packsDir = path.join(this.profileDir, "marketplace-packs");
    this.platform = platform;
    this.version = version;
    this.provider = provider;
    this.secretStore = secretStore;
    this.host = host;
    this.devWatchers = new Map();
    fs.mkdirSync(this.packsDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS marketplace_installed (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        granted_permissions_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        error TEXT NOT NULL DEFAULT '',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS marketplace_logs (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_marketplace_logs_pack ON marketplace_logs(pack_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS marketplace_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_secrets (
        pack_id TEXT NOT NULL REFERENCES marketplace_installed(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(pack_id, field_name)
      );
      CREATE TABLE IF NOT EXISTS marketplace_publishers (
        key_id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL,
        publisher_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_remote_catalog (
        id INTEGER PRIMARY KEY CHECK(id=1),
        url TEXT NOT NULL,
        etag TEXT NOT NULL DEFAULT '',
        catalog_json TEXT,
        publisher_key_id TEXT NOT NULL DEFAULT '',
        generated_at TEXT,
        expires_at TEXT,
        fetched_at TEXT,
        last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS marketplace_review_backend (
        id INTEGER PRIMARY KEY CHECK(id=1),
        url TEXT NOT NULL,
        publisher_key_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_review_cache (
        pack_id TEXT PRIMARY KEY,
        reviews_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '{}',
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marketplace_review_outbox (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        remote_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const installedColumns = new Set(this.db.prepare("PRAGMA table_info(marketplace_installed)").all().map((column) => column.name));
    if (!installedColumns.has("package_metadata_json")) {
      this.db.exec("ALTER TABLE marketplace_installed ADD COLUMN package_metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!installedColumns.has("release_channel")) {
      this.db.exec("ALTER TABLE marketplace_installed ADD COLUMN release_channel TEXT NOT NULL DEFAULT 'stable'");
    }
  }

  #log(packId, eventType, summary, metadata = {}) {
    this.db.prepare("INSERT INTO marketplace_logs(id,pack_id,event_type,summary,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(crypto.randomUUID(), packId, eventType, summary.slice(0, 1000), JSON.stringify(metadata), timestamp());
    this.database.audit(`marketplace.${eventType}`, summary, { entityType: "marketplace-pack", entityId: packId, metadata });
  }

  #installedRow(id) {
    return this.db.prepare("SELECT * FROM marketplace_installed WHERE id=?").get(id);
  }

  #packageFromInput({ id, version, package: localPackage }) {
    if (localPackage) return {
      ...validatePackPackage(localPackage, {
        evolvVersion: this.version,
        platform: this.platform,
        trustedKeyIds: this.#trustedKeyIds()
      }),
      source: "local"
    };
    const requestedId = String(id || "");
    const requestedVersion = String(version || "");
    const remote = this.#remotePackages().find((item) => item.manifest.id === requestedId
      && (!requestedVersion || item.manifest.version === requestedVersion));
    const bundled = this.provider.getPack(requestedId, requestedVersion);
    const selected = remote && (!bundled || compareSemver(remote.manifest.version, bundled.manifest.version) > 0)
      ? remote
      : bundled;
    if (!selected) throw Object.assign(new Error("Marketplace pack or version not found."), { status: 404 });
    return {
      ...validatePackPackage(selected, {
        evolvVersion: this.version,
        platform: this.platform,
        ...(selected === bundled && this.provider.isTrusted?.(requestedId) ? { bundledTrust: true } : { trustedKeyIds: this.#trustedKeyIds() })
      }),
      source: selected === bundled ? "bundled" : "remote"
    };
  }

  #trustedKeyIds() {
    return this.db.prepare("SELECT key_id FROM marketplace_publishers WHERE trusted=1").all().map((row) => row.key_id);
  }

  #rememberPublisher(packPackage, trusted) {
    if (!packPackage.publisher || !packPackage.verification?.valid) {
      throw Object.assign(new Error("Only a package with a valid Ed25519 signature can establish a publisher identity."), { status: 400 });
    }
    const publisher = normalizePublisher(packPackage.publisher);
    this.db.prepare(`INSERT INTO marketplace_publishers(key_id,publisher_id,publisher_name,public_key,trusted,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(key_id) DO UPDATE SET publisher_id=excluded.publisher_id,publisher_name=excluded.publisher_name,
      public_key=excluded.public_key,trusted=excluded.trusted,updated_at=excluded.updated_at`)
      .run(publisher.keyId, publisher.id, publisher.name, publisher.publicKey, trusted ? 1 : 0, timestamp(), timestamp());
    return publisher;
  }

  publishers() {
    return this.db.prepare(`SELECT key_id AS keyId,publisher_id AS id,publisher_name AS name,trusted,
      created_at AS createdAt,updated_at AS updatedAt FROM marketplace_publishers ORDER BY publisher_name,key_id`).all()
      .map((item) => ({ ...item, trusted: Boolean(item.trusted) }));
  }

  setPublisherTrust(keyId, trusted) {
    const existing = this.db.prepare("SELECT * FROM marketplace_publishers WHERE key_id=?").get(String(keyId || ""));
    if (!existing) throw Object.assign(new Error("Publisher identity not found."), { status: 404 });
    this.db.prepare("UPDATE marketplace_publishers SET trusted=?,updated_at=? WHERE key_id=?").run(trusted ? 1 : 0, timestamp(), existing.key_id);
    this.#log("publisher", trusted ? "publisher-trusted" : "publisher-revoked",
      `${trusted ? "Trusted" : "Revoked trust for"} ${existing.publisher_name}`, { keyId: existing.key_id });
    return this.publishers().find((item) => item.keyId === existing.key_id);
  }

  remoteCatalogStatus() {
    const row = this.db.prepare("SELECT * FROM marketplace_remote_catalog WHERE id=1").get();
    return row ? {
      configured: true,
      url: row.url,
      publisherKeyId: row.publisher_key_id,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
      fetchedAt: row.fetched_at,
      lastError: row.last_error,
      cached: Boolean(row.catalog_json)
    } : {
      configured: false, url: "", publisherKeyId: "", generatedAt: null,
      expiresAt: null, fetchedAt: null, lastError: "", cached: false
    };
  }

  configureRemoteCatalog(url) {
    const validated = validateCatalogUrl(url);
    this.db.prepare(`INSERT INTO marketplace_remote_catalog(id,url,etag,catalog_json,publisher_key_id,last_error)
      VALUES (1,?,'',NULL,'','')
      ON CONFLICT(id) DO UPDATE SET url=excluded.url,etag='',catalog_json=NULL,publisher_key_id='',last_error=''`).run(validated);
    return this.remoteCatalogStatus();
  }

  disconnectRemoteCatalog() {
    this.db.prepare("DELETE FROM marketplace_remote_catalog WHERE id=1").run();
    return this.remoteCatalogStatus();
  }

  reviewBackendStatus() {
    const row = this.db.prepare("SELECT * FROM marketplace_review_backend WHERE id=1").get();
    return row ? { configured: true, url: row.url, publisherKeyId: row.publisher_key_id, updatedAt: row.updated_at }
      : { configured: false, url: "", publisherKeyId: "", updatedAt: null };
  }

  configureReviewBackend(url, publisherKeyId) {
    const validated = validateCatalogUrl(url);
    const keyId = String(publisherKeyId || "");
    const publisher = this.db.prepare("SELECT key_id FROM marketplace_publishers WHERE key_id=? AND trusted=1").get(keyId);
    if (!publisher) throw Object.assign(new Error("Choose a trusted publisher key for review response verification."), { status: 403 });
    const normalizedUrl = validated.endsWith("/") ? validated : `${validated}/`;
    this.db.prepare(`INSERT INTO marketplace_review_backend(id,url,publisher_key_id,updated_at) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url,publisher_key_id=excluded.publisher_key_id,updated_at=excluded.updated_at`)
      .run(normalizedUrl, keyId, timestamp());
    return this.reviewBackendStatus();
  }

  disconnectReviewBackend() {
    this.db.prepare("DELETE FROM marketplace_review_backend WHERE id=1").run();
    return this.reviewBackendStatus();
  }

  reviewState(packId) {
    const cache = this.db.prepare("SELECT * FROM marketplace_review_cache WHERE pack_id=?").get(packId);
    const outbox = this.db.prepare(`SELECT id,pack_id AS packId,rating,title,body,status,attempts,next_attempt_at AS nextAttemptAt,
      last_error AS lastError,remote_id AS remoteId,created_at AS createdAt,updated_at AS updatedAt
      FROM marketplace_review_outbox WHERE pack_id=? ORDER BY created_at DESC LIMIT 100`).all(packId);
    return {
      backend: this.reviewBackendStatus(),
      trustedReviews: cache ? JSON.parse(cache.reviews_json) : [],
      verification: cache ? JSON.parse(cache.verification_json) : null,
      fetchedAt: cache?.fetched_at || null,
      outbox
    };
  }

  async #reviewRequest(route, { method = "GET", body, fetchImpl = fetch } = {}) {
    const backend = this.reviewBackendStatus();
    if (!backend.configured) throw Object.assign(new Error("No trusted review backend is configured."), { status: 409 });
    const url = new URL(String(route).replace(/^\/+/, ""), backend.url);
    if (url.origin !== new URL(backend.url).origin) throw Object.assign(new Error("Review backend route escaped its configured origin."), { status: 400 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw Object.assign(new Error(`Review backend returned HTTP ${response.status}.`), { status: 502 });
      if (!String(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
        throw Object.assign(new Error("Review backend response must be application/json."), { status: 502 });
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > 1_000_000) throw Object.assign(new Error("Review backend response is too large."), { status: 413 });
      let raw;
      try { raw = JSON.parse(text); } catch { throw Object.assign(new Error("Review backend returned malformed JSON."), { status: 502 }); }
      const verified = verifySignedEnvelope(raw, { trustedKeyIds: [backend.publisherKeyId] });
      if (verified.verification.keyId !== backend.publisherKeyId) throw Object.assign(new Error("Review backend used an unexpected signing key."), { status: 403 });
      return verified;
    } catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error("Review backend request timed out."), { status: 504 });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async syncReviews(packId, { fetchImpl = fetch } = {}) {
    const catalogPack = this.catalog().find((item) => item.id === packId);
    if (!catalogPack) throw Object.assign(new Error("Marketplace pack not found."), { status: 404 });
    const verified = await this.#reviewRequest(`packs/${encodeURIComponent(packId)}/reviews`, { fetchImpl });
    const payload = verified.payload;
    if (!plainObject(payload) || payload.packId !== packId || !Array.isArray(payload.reviews)) {
      throw Object.assign(new Error("Signed review payload has an invalid shape."), { status: 502 });
    }
    const reviews = payload.reviews.slice(0, 200).map((review) => ({
      id: String(review.id || "").slice(0, 100),
      rating: Math.max(1, Math.min(5, Math.trunc(Number(review.rating) || 0))),
      title: String(review.title || "").slice(0, 160),
      body: String(review.body || "").slice(0, 4000),
      author: String(review.author || "Marketplace user").slice(0, 120),
      createdAt: String(review.createdAt || "").slice(0, 40)
    })).filter((review) => review.id && review.title && review.rating);
    this.db.prepare(`INSERT INTO marketplace_review_cache(pack_id,reviews_json,verification_json,fetched_at) VALUES (?,?,?,?)
      ON CONFLICT(pack_id) DO UPDATE SET reviews_json=excluded.reviews_json,verification_json=excluded.verification_json,fetched_at=excluded.fetched_at`)
      .run(packId, JSON.stringify(reviews), JSON.stringify(verified.verification), timestamp());
    return this.reviewState(packId);
  }

  async submitReview(packId, input, { fetchImpl = fetch } = {}) {
    if (!this.getInstalled(packId)) throw Object.assign(new Error("Install the pack before reviewing it."), { status: 409 });
    const rating = Math.trunc(Number(input.rating));
    const title = String(input.title || "").trim().slice(0, 160);
    const body = String(input.body || "").trim().slice(0, 4000);
    if (rating < 1 || rating > 5 || !title || body.length < 10) {
      throw Object.assign(new Error("Review needs a 1–5 rating, title, and at least 10 characters of detail."), { status: 400 });
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO marketplace_review_outbox(id,pack_id,rating,title,body,status,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',0,?,?)`).run(id, packId, rating, title, body, timestamp(), timestamp());
    try { await this.flushReviewOutbox({ fetchImpl, onlyId: id }); } catch {}
    return this.reviewState(packId).outbox.find((item) => item.id === id);
  }

  async flushReviewOutbox({ fetchImpl = fetch, onlyId = "" } = {}) {
    const now = timestamp();
    const rows = this.db.prepare(`SELECT * FROM marketplace_review_outbox
      WHERE status!='sent' AND (?='' OR id=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      ORDER BY created_at LIMIT 20`).all(onlyId, onlyId, now);
    const results = [];
    for (const row of rows) {
      try {
        const verified = await this.#reviewRequest("reviews", {
          method: "POST",
          body: {
            clientReviewId: row.id,
            packId: row.pack_id,
            rating: row.rating,
            title: row.title,
            body: row.body,
            createdAt: row.created_at
          },
          fetchImpl
        });
        if (!plainObject(verified.payload) || verified.payload.accepted !== true || !String(verified.payload.reviewId || "")) {
          throw new Error("Signed review acknowledgement is invalid.");
        }
        this.db.prepare(`UPDATE marketplace_review_outbox SET status='sent',attempts=attempts+1,last_error='',
          remote_id=?,next_attempt_at=NULL,updated_at=? WHERE id=?`)
          .run(String(verified.payload.reviewId).slice(0, 100), timestamp(), row.id);
        results.push({ id: row.id, status: "sent" });
      } catch (error) {
        const attempts = row.attempts + 1;
        const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
        const next = new Date(Date.now() + delayMinutes * 60_000).toISOString();
        this.db.prepare(`UPDATE marketplace_review_outbox SET status='pending',attempts=?,last_error=?,
          next_attempt_at=?,updated_at=? WHERE id=?`)
          .run(attempts, String(error.message || error).slice(0, 1000), next, timestamp(), row.id);
        results.push({ id: row.id, status: "pending", error: String(error.message || error) });
      }
    }
    return { processed: results.length, results };
  }

  async syncRemoteCatalog({ fetchImpl = fetch } = {}) {
    const row = this.db.prepare("SELECT * FROM marketplace_remote_catalog WHERE id=1").get();
    if (!row) throw Object.assign(new Error("Configure a remote catalog URL first."), { status: 409 });
    try {
      const result = await fetchSignedCatalog(row.url, {
        trustedKeyIds: this.#trustedKeyIds(),
        etag: row.etag,
        fetchImpl
      });
      if (result.notModified) {
        this.db.prepare("UPDATE marketplace_remote_catalog SET fetched_at=?,last_error='' WHERE id=1").run(timestamp());
        return this.remoteCatalogStatus();
      }
      const normalized = result.raw.packages.map((packPackage) => {
        const checked = validatePackPackage(packPackage, {
          evolvVersion: this.version,
          platform: this.platform,
          trustedKeyIds: this.#trustedKeyIds()
        });
        if (!checked.verification.valid) {
          throw Object.assign(new Error(`Remote pack ${checked.manifest.id} is unsigned.`), { status: 400 });
        }
        return packPackage;
      });
      const seen = new Set();
      for (const packPackage of normalized) {
        const key = `${packPackage.manifest.id}@${packPackage.manifest.version}`;
        if (seen.has(key)) throw Object.assign(new Error(`Remote catalog contains duplicate package ${key}.`), { status: 400 });
        seen.add(key);
      }
      this.db.prepare(`UPDATE marketplace_remote_catalog SET etag=?,catalog_json=?,publisher_key_id=?,
        generated_at=?,expires_at=?,fetched_at=?,last_error='' WHERE id=1`)
        .run(result.etag, JSON.stringify({ ...result.raw, packages: normalized }), result.catalog.publisher.keyId,
          result.catalog.generatedAt, result.catalog.expiresAt, timestamp());
      this.#log("catalog", "catalog-synced", `Synced ${normalized.length} signed marketplace packages`,
        { publisherKeyId: result.catalog.publisher.keyId, packageCount: normalized.length });
      return this.remoteCatalogStatus();
    } catch (error) {
      this.db.prepare("UPDATE marketplace_remote_catalog SET last_error=? WHERE id=1").run(String(error.message || error).slice(0, 1000));
      throw error;
    }
  }

  #remotePackages() {
    const row = this.db.prepare("SELECT catalog_json FROM marketplace_remote_catalog WHERE id=1").get();
    if (!row?.catalog_json) return [];
    try {
      const raw = JSON.parse(row.catalog_json);
      return raw.packages.map((packPackage) => validatePackPackage(packPackage, {
        evolvVersion: this.version,
        platform: this.platform,
        trustedKeyIds: this.#trustedKeyIds()
      }));
    } catch (error) {
      console.warn("Ignoring invalid cached Marketplace catalog:", error.message);
      return [];
    }
  }

  #availableVersion(id, channel = "stable") {
    const versions = [
      this.provider.getAvailableVersion(id),
      ...this.#remotePackages().filter((item) => item.manifest.id === id).map((item) => item.manifest.version)
    ].filter(Boolean).filter((version) => this.#channelAllowsVersion(channel, version));
    return versions.sort((a, b) => compareSemver(b, a))[0] || null;
  }

  #availableVersions(id, channel = "nightly") {
    return [...new Set([
      ...this.provider.versions(id),
      ...this.#remotePackages().filter((item) => item.manifest.id === id).map((item) => item.manifest.version)
    ])].filter((version) => this.#channelAllowsVersion(channel, version)).sort((a, b) => compareSemver(b, a));
  }

  #channelAllowsVersion(channel, version) {
    if (channel === "nightly") return true;
    const prerelease = String(version).match(SEMVER)?.[4] || "";
    if (!prerelease) return true;
    if (channel === "beta") return !/(?:^|[.-])(?:nightly|dev|canary)(?:[.-]|$)/i.test(prerelease);
    return false;
  }

  catalog({ query = "", category = "", filter = "", sort = "featured", os = "", model = "" } = {}) {
    const installedItems = this.installed();
    const installed = new Map(installedItems.map((item) => [item.id, item]));
    const merged = new Map(this.provider.listPacks().map((manifest) => [manifest.id, manifest]));
    for (const packPackage of this.#remotePackages()) {
      const channel = installed.get(packPackage.manifest.id)?.releaseChannel || "stable";
      if (!this.#channelAllowsVersion(channel, packPackage.manifest.version)) continue;
      const existing = merged.get(packPackage.manifest.id);
      if (!existing || compareSemver(packPackage.manifest.version, existing.version) > 0) {
        merged.set(packPackage.manifest.id, packPackage.manifest);
      }
    }
    const providerManifests = [...merged.values()];
    const providerIds = new Set(providerManifests.map((manifest) => manifest.id));
    const manifests = [
      ...providerManifests,
      ...installedItems.filter((item) => !providerIds.has(item.id)).map((item) => item.manifest)
    ];
    let packs = manifests.map((manifest) => {
      const record = installed.get(manifest.id);
      return {
        ...manifest,
        installed: Boolean(record),
        enabled: record?.enabled || false,
        installedVersion: record?.version || "",
        updateAvailable: Boolean(record && compareSemver(this.#availableVersion(manifest.id, record.releaseChannel) || record.version, record.version) > 0),
        availableVersion: record ? this.#availableVersion(manifest.id, record.releaseChannel) || record.version : manifest.version,
        permissionSummary: manifest.permissions.map((item) => item.id),
        localOnly: !manifest.permissions.some((item) => ["models.cloud", "network.internet"].includes(item.id)),
        free: manifest.price === 0,
        purchaseStatus: manifest.price === 0 ? "owned" : "not-purchased",
        versions: this.#availableVersions(manifest.id),
        releaseChannel: record?.releaseChannel || manifest.releaseChannel || "stable",
        source: record?.source || (this.provider.getPack(manifest.id, manifest.version) ? "bundled" : "remote")
      };
    });
    if (query.trim()) {
      const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
      packs = packs.map((item) => ({ ...item, searchScore: this.#searchScore(item, normalized) }))
        .filter((item) => item.searchScore > 0);
    }
    if (category) packs = packs.filter((item) => item.category === category);
    if (filter === "installed") packs = packs.filter((item) => item.installed);
    if (filter === "free") packs = packs.filter((item) => item.free);
    if (filter === "paid") packs = packs.filter((item) => !item.free);
    if (filter === "verified") packs = packs.filter((item) => item.verified);
    if (filter === "local") packs = packs.filter((item) => item.localOnly);
    if (filter === "cloud") packs = packs.filter((item) => !item.localOnly);
    if (os) packs = packs.filter((item) => item.platforms.includes(os));
    if (model) packs = packs.filter((item) => [...item.models.local, ...item.models.cloud].some((value) => value.toLowerCase().includes(model.toLowerCase())));
    const comparators = {
      featured: (a, b) => Number(b.featured) - Number(a.featured) || b.rating - a.rating,
      popular: (a, b) => b.reviewCount - a.reviewCount,
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      newest: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
      rated: (a, b) => b.rating - a.rating,
      alphabetical: (a, b) => a.name.localeCompare(b.name)
    };
    return packs.sort(query.trim()
      ? (a, b) => b.searchScore - a.searchScore || comparators[sort]?.(a, b) || 0
      : comparators[sort] || comparators.featured);
  }

  #searchScore(item, query) {
    const compact = (value) => String(value || "").toLowerCase().replace(/[\s_-]+/g, " ").trim();
    const name = compact(item.name);
    if (name === query) return 1000;
    let score = name.startsWith(query) ? 500 : name.includes(query) ? 300 : 0;
    const terms = query.split(" ");
    const fields = [
      [item.tags, 140], [[item.category], 100], [[item.author.name], 80],
      [[item.description, item.fullDescription], 40],
      [[...item.commands.map((entry) => entry.name), ...item.agents.map((entry) => entry.name)], 60],
      [[item.documentation], 15]
    ];
    for (const [values, weight] of fields) {
      const text = compact(values.join(" "));
      score += terms.filter((term) => text.includes(term)).length * weight;
    }
    const aliases = { repo: "repository", ui: "design accessibility screenshot", ai: "ollama model local", bike: "motorcycle", apt: "linux" };
    if (aliases[query] && compact(`${name} ${item.tags.join(" ")}`).includes(aliases[query].split(" ")[0])) score += 120;
    return score;
  }

  details(id) {
    const catalog = this.catalog().find((item) => item.id === id);
    if (!catalog) throw Object.assign(new Error("Marketplace pack not found."), { status: 404 });
    const installed = this.getInstalled(id);
    return {
      ...catalog,
      installedRecord: installed,
      permissions: catalog.permissions.map((item) => ({
        ...item,
        name: PERMISSIONS[item.id][0],
        description: PERMISSIONS[item.id][1],
        risk: PERMISSIONS[item.id][2],
        supported: RUNTIME_SUPPORTED.has(item.id)
      })),
      diagnostics: installed ? this.diagnostics(id) : null
    };
  }

  preview(input) {
    const packPackage = this.#packageFromInput(input);
    const previous = this.getInstalled(packPackage.manifest.id);
    const permissions = packPackage.manifest.permissions.map((item) => ({
      ...item, name: PERMISSIONS[item.id][0], description: PERMISSIONS[item.id][1],
      risk: PERMISSIONS[item.id][2], supported: RUNTIME_SUPPORTED.has(item.id)
    }));
    return {
      valid: true,
      manifest: packPackage.manifest,
      verification: packPackage.verification,
      relationships: this.#relationshipStatus(packPackage.manifest),
      permissions,
      previousVersion: previous?.version || "",
      grantedPermissions: previous?.grantedPermissions || [],
      permissionDiff: permissionDiff(previous?.manifest.permissions || [], permissions),
      action: previous ? "update" : "install"
    };
  }

  install(input) {
    let packPackage = this.#packageFromInput(input);
    if (input.trustPublisher === true && packPackage.verification?.state === "signed") {
      this.#rememberPublisher(packPackage, true);
      packPackage = this.#packageFromInput(input);
    } else if (packPackage.verification?.valid && packPackage.publisher) {
      this.#rememberPublisher(packPackage, packPackage.verification.trusted);
    }
    const { manifest } = packPackage;
    const previousRow = this.#installedRow(manifest.id);
    const previous = rowToInstalled(previousRow);
    const relationships = this.#relationshipStatus(manifest);
    const blockingDependency = relationships.dependencies.find((item) => !item.optional && (!item.installed || !item.satisfies || !item.enabled));
    if (blockingDependency) {
      throw Object.assign(new Error(`Install and enable ${blockingDependency.id} ${blockingDependency.range} before ${manifest.name}.`), { status: 409 });
    }
    const blockingConflict = relationships.conflicts.find((item) => item.installed && item.satisfies && item.enabled);
    if (blockingConflict) {
      throw Object.assign(new Error(`${manifest.name} conflicts with enabled pack ${blockingConflict.id}: ${blockingConflict.reason}`), { status: 409 });
    }
    for (const dependent of this.installed()) {
      if (dependent.id === manifest.id) continue;
      const relation = dependent.manifest.dependencies.find((item) => item.id === manifest.id && !item.optional);
      if (relation && !semverSatisfies(manifest.version, relation.range)) {
        throw Object.assign(new Error(`Version ${manifest.version} would break ${dependent.manifest.name}, which requires ${relation.range}.`), { status: 409 });
      }
    }
    if (previous && compareSemver(manifest.version, previous.version) <= 0 && input.reinstall !== true) {
      throw Object.assign(new Error(`${manifest.name} ${previous.version} is already installed.`), { status: 409 });
    }
    const requestedIds = manifest.permissions.map((item) => item.id);
    const approved = [...new Set(normalizeStringList(input.approvedPermissions, 40, 100))].filter((item) => requestedIds.includes(item));
    const missing = manifest.permissions.filter((item) => item.required && !approved.includes(item.id));
    if (missing.length) throw Object.assign(new Error(`Approve required permission: ${missing[0].id}.`), { status: 403 });
    const added = permissionDiff(previous?.manifest.permissions || [], manifest.permissions).added;
    if (previous && added.some((item) => !approved.includes(item))) {
      throw Object.assign(new Error(`The update requests ${added.length} additional permission${added.length === 1 ? "" : "s"}.`), { status: 403 });
    }
    const config = previous ? validateConfiguration(manifest.configSchema, { ...defaultsFor(manifest.configSchema), ...previous.config }) : defaultsFor(manifest.configSchema);
    for (const [key, definition] of Object.entries(manifest.configSchema.properties || {})) {
      if (definition.format === "secret") delete config[key];
    }
    const finalDirectory = path.join(this.packsDir, manifest.id);
    const stageDirectory = path.join(this.packsDir, `.stage-${crypto.randomUUID()}`);
    const backupDirectory = path.join(this.packsDir, `.backup-${crypto.randomUUID()}`);
    fs.mkdirSync(stageDirectory, { recursive: true });
    try {
      this.#writePackage(stageDirectory, packPackage);
      if (fs.existsSync(finalDirectory)) fs.renameSync(finalDirectory, backupDirectory);
      fs.renameSync(stageDirectory, finalDirectory);
      const createdAt = previous?.installedAt || timestamp();
      const enabled = previous ? previous.enabled : true;
      const status = enabled ? "healthy" : "disabled";
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO marketplace_installed(id,version,enabled,source,release_channel,granted_permissions_json,config_json,
          manifest_json,package_metadata_json,status,error,installed_at,updated_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,source=excluded.source,
          granted_permissions_json=excluded.granted_permissions_json,config_json=excluded.config_json,
          manifest_json=excluded.manifest_json,package_metadata_json=excluded.package_metadata_json,
          status=excluded.status,error='',updated_at=excluded.updated_at`)
          .run(manifest.id, manifest.version, enabled ? 1 : 0, packPackage.source || (input.package ? "local" : "bundled"),
            previous?.releaseChannel || "stable", JSON.stringify(approved),
            JSON.stringify(config), JSON.stringify(manifest), JSON.stringify({
              publisher: packPackage.publisher || null,
              signature: packPackage.signature || null,
              verification: packPackage.verification
            }), status, "", createdAt, timestamp(), previous?.lastUsedAt || null);
      })();
      if (fs.existsSync(backupDirectory)) fs.rmSync(backupDirectory, { recursive: true, force: true });
      try {
        this.#log(manifest.id, previous ? "updated" : "installed", `${previous ? "Updated" : "Installed"} ${manifest.name} ${manifest.version}`, { permissions: approved, previousVersion: previous?.version || null });
      } catch (error) {
        console.warn(`Marketplace audit log failed for ${manifest.id}:`, error.message);
      }
      return this.getInstalled(manifest.id);
    } catch (error) {
      try { if (fs.existsSync(stageDirectory)) fs.rmSync(stageDirectory, { recursive: true, force: true }); } catch {}
      try {
        if (fs.existsSync(backupDirectory)) {
          if (fs.existsSync(finalDirectory)) fs.rmSync(finalDirectory, { recursive: true, force: true });
          fs.renameSync(backupDirectory, finalDirectory);
        }
      } catch {}
      throw Object.assign(new Error(previous ? `The previous version was restored after the update failed. ${error.message}` : error.message), { status: error.status || 500 });
    }
  }

  #writePackage(directory, packPackage) {
    const writes = { "manifest.json": JSON.stringify(packPackage.manifest, null, 2), ...packPackage.files };
    for (const [relative, content] of Object.entries(writes)) {
      const safe = safePackPath(relative);
      const target = path.resolve(directory, ...safe.split("/"));
      if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Unsafe package path.");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    }
  }

  installed() {
    return this.db.prepare("SELECT * FROM marketplace_installed ORDER BY updated_at DESC").all().map(rowToInstalled)
      .map((item) => ({
        ...item,
        configuredSecrets: this.db.prepare("SELECT field_name FROM marketplace_secrets WHERE pack_id=? ORDER BY field_name").all(item.id).map((row) => row.field_name),
        updateAvailable: compareSemver(this.#availableVersion(item.id, item.releaseChannel) || item.version, item.version) > 0,
        availableVersion: this.#availableVersion(item.id, item.releaseChannel) || item.version
      }));
  }

  getInstalled(id) {
    const item = rowToInstalled(this.#installedRow(id));
    return item ? {
      ...item,
      configuredSecrets: this.db.prepare("SELECT field_name FROM marketplace_secrets WHERE pack_id=? ORDER BY field_name").all(id).map((row) => row.field_name),
      updateAvailable: compareSemver(this.#availableVersion(id, item.releaseChannel) || item.version, item.version) > 0,
      availableVersion: this.#availableVersion(id, item.releaseChannel) || item.version
    } : null;
  }

  setReleaseChannel(id, channel) {
    const normalized = String(channel || "").toLowerCase();
    if (!RELEASE_CHANNELS.has(normalized)) throw Object.assign(new Error("Choose Stable, Beta, or Nightly."), { status: 400 });
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    this.db.prepare("UPDATE marketplace_installed SET release_channel=?,updated_at=? WHERE id=?").run(normalized, timestamp(), id);
    this.#log(id, "release-channel-changed", `Changed ${current.manifest.name} to the ${normalized} channel`, { channel: normalized });
    return this.getInstalled(id);
  }

  updateNotices() {
    return this.installed().filter((item) => item.updateAvailable).map((item) => ({
      id: item.id,
      name: item.manifest.name,
      currentVersion: item.version,
      availableVersion: item.availableVersion,
      channel: item.releaseChannel,
      source: item.source
    }));
  }

  setEnabled(id, enabled) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    if (!enabled) {
      const dependent = this.installed().find((item) => item.enabled && item.id !== id
        && item.manifest.dependencies.some((relation) => relation.id === id && !relation.optional));
      if (dependent) throw Object.assign(new Error(`${current.manifest.name} is required by enabled pack ${dependent.manifest.name}.`), { status: 409 });
    } else {
      const relationships = this.#relationshipStatus(current.manifest);
      const missing = relationships.dependencies.find((item) => !item.optional && (!item.installed || !item.enabled || !item.satisfies));
      if (missing) throw Object.assign(new Error(`Enable compatible dependency ${missing.id} ${missing.range} first.`), { status: 409 });
      const conflict = relationships.conflicts.find((item) => item.installed && item.enabled && item.satisfies);
      if (conflict) throw Object.assign(new Error(`Disable conflicting pack ${conflict.id} first.`), { status: 409 });
    }
    this.db.prepare("UPDATE marketplace_installed SET enabled=?,status=?,updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, enabled ? "healthy" : "disabled", timestamp(), id);
    this.#log(id, enabled ? "enabled" : "disabled", `${enabled ? "Enabled" : "Disabled"} ${current.manifest.name}`);
    return this.getInstalled(id);
  }

  async saveConfig(id, value) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const config = validateConfiguration(current.manifest.configSchema, value);
    const secretEntries = Object.entries(current.manifest.configSchema.properties || {}).filter(([, definition]) => definition.format === "secret");
    const encrypted = [];
    for (const [key] of secretEntries) {
      const secret = String(config[key] || "");
      delete config[key];
      if (!secret) continue;
      if (!this.secretStore?.available) throw Object.assign(new Error("Secure operating-system storage is unavailable; this secret was not saved."), { status: 503 });
      encrypted.push([key, await this.secretStore.encrypt(secret)]);
    }
    this.db.transaction(() => {
      this.db.prepare("UPDATE marketplace_installed SET config_json=?,updated_at=? WHERE id=?").run(JSON.stringify(config), timestamp(), id);
      for (const [key, ciphertext] of encrypted) {
        this.db.prepare(`INSERT INTO marketplace_secrets(pack_id,field_name,encrypted_secret,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(pack_id,field_name) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,updated_at=excluded.updated_at`)
          .run(id, key, ciphertext, timestamp());
      }
    })();
    this.#log(id, "configured", `Updated ${current.manifest.name} configuration`, { fields: Object.keys(config), secretsUpdated: encrypted.map(([key]) => key) });
    return this.getInstalled(id);
  }

  async resetConfig(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    this.db.prepare("DELETE FROM marketplace_secrets WHERE pack_id=?").run(id);
    return this.saveConfig(id, defaultsFor(current.manifest.configSchema));
  }

  revokePermission(id, permission) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const declaration = current.manifest.permissions.find((item) => item.id === permission);
    if (!declaration) throw Object.assign(new Error("Pack permission not found."), { status: 404 });
    const granted = current.grantedPermissions.filter((item) => item !== permission);
    const enabled = declaration.required ? false : current.enabled;
    this.db.prepare("UPDATE marketplace_installed SET granted_permissions_json=?,enabled=?,status=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(granted), enabled ? 1 : 0, enabled ? "healthy" : "disabled", timestamp(), id);
    this.#log(id, "permission-revoked", `Revoked ${permission}`, { required: declaration.required, disabled: !enabled });
    return this.getInstalled(id);
  }

  uninstall(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const dependent = this.installed().find((item) => item.id !== id
      && item.manifest.dependencies.some((relation) => relation.id === id && !relation.optional));
    if (dependent) throw Object.assign(new Error(`${current.manifest.name} cannot be uninstalled because ${dependent.manifest.name} depends on it.`), { status: 409 });
    const directory = path.join(this.packsDir, id);
    const trash = path.join(this.packsDir, `.uninstall-${crypto.randomUUID()}`);
    if (fs.existsSync(directory)) fs.renameSync(directory, trash);
    try {
      this.db.prepare("DELETE FROM marketplace_installed WHERE id=?").run(id);
      this.#log(id, "uninstalled", `Uninstalled ${current.manifest.name}`, { version: current.version });
      if (fs.existsSync(trash)) fs.rmSync(trash, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      if (fs.existsSync(trash)) fs.renameSync(trash, directory);
      throw error;
    }
  }

  runtime() {
    return this.installed().filter((item) => item.enabled && item.status === "healthy").flatMap((item) => [
      ...item.manifest.agents.map((agent) => ({ ...agent, type: "agent", packId: item.id, packName: item.manifest.name, id: `${item.id}:${agent.id}` })),
      ...item.manifest.commands.map((command) => ({ ...command, type: "command", packId: item.id, packName: item.manifest.name, id: `${item.id}:${command.id}` })),
      ...item.manifest.workflows.map((workflow) => ({ ...workflow, type: "workflow", packId: item.id, packName: item.manifest.name, id: `${item.id}:${workflow.id}` }))
    ]);
  }

  #relationshipStatus(manifest) {
    const installed = new Map(this.db.prepare("SELECT * FROM marketplace_installed").all().map(rowToInstalled).map((item) => [item.id, item]));
    const describe = (relation) => {
      const record = installed.get(relation.id);
      return {
        ...relation,
        installed: Boolean(record),
        enabled: Boolean(record?.enabled),
        version: record?.version || "",
        satisfies: Boolean(record && semverSatisfies(record.version, relation.range))
      };
    };
    return {
      dependencies: manifest.dependencies.map(describe),
      conflicts: manifest.conflicts.map(describe)
    };
  }

  resolveCommand(qualifiedId, input) {
    const command = this.runtime().find((item) => item.type === "command" && item.id === qualifiedId);
    if (!command) throw Object.assign(new Error("Pack command is unavailable or its pack is disabled."), { status: 404 });
    const installed = this.getInstalled(command.packId);
    const agent = installed.manifest.agents.find((item) => item.id === command.agentId);
    this.db.prepare("UPDATE marketplace_installed SET last_used_at=? WHERE id=?").run(timestamp(), command.packId);
    this.#log(command.packId, "command-used", `Used ${command.name}`, { commandId: command.id });
    return {
      command,
      agent,
      promptTemplate: command.promptTemplate,
      inputLength: String(input || "").slice(0, 50_000).length,
      config: installed.config,
      grantedPermissions: installed.grantedPermissions
    };
  }

  resolveChat(packId, input) {
    const installed = this.getInstalled(packId);
    if (!installed || !installed.enabled || installed.status !== "healthy") {
      throw Object.assign(new Error("This pack is unavailable or disabled."), { status: 404 });
    }
    const agent = installed.manifest.agents[0];
    if (!agent) throw Object.assign(new Error("This pack does not provide a chat agent."), { status: 400 });
    this.db.prepare("UPDATE marketplace_installed SET last_used_at=? WHERE id=?").run(timestamp(), packId);
    this.#log(packId, "chat-used", `Started free-form chat with ${installed.manifest.name}`, { agentId: agent.id });
    return {
      command: {
        id: `${packId}:free-form-chat`,
        packId,
        packName: installed.manifest.name,
        name: "Free-form specialist chat"
      },
      agent,
      promptTemplate: "Infer the concrete task, desired outcome, constraints, and useful next action from the user's message. Do not require a preset command. If the request is broad, formulate a sensible task and state it briefly before proceeding. Ask a question only when the missing answer would materially change the result.",
      inputLength: String(input || "").slice(0, 50_000).length,
      config: installed.config,
      grantedPermissions: installed.grantedPermissions,
      freeForm: true
    };
  }

  exportPack(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const root = path.join(this.packsDir, id);
    const files = {};
    const pending = fs.existsSync(root) ? [root] : [];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Pack contains an unsupported symbolic link.");
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile() && entry.name !== "manifest.json") {
          const relative = path.relative(root, candidate).replace(/\\/g, "/");
          files[safePackPath(relative)] = fs.readFileSync(candidate, "utf8").slice(0, 500_000);
        }
      }
    }
    const exported = { packageVersion: 1, manifest: current.manifest, files };
    if (current.packageMetadata?.publisher && current.packageMetadata?.signature) {
      exported.publisher = current.packageMetadata.publisher;
      exported.signature = current.packageMetadata.signature;
    }
    return exported;
  }

  diagnostics(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    return {
      pack: { id: current.id, version: current.version, enabled: current.enabled, status: current.status, source: current.source },
      manifestValid: true,
      capabilities: {
        agents: current.manifest.agents.length,
        commands: current.manifest.commands.length,
        workflows: current.manifest.workflows.length
      },
      configurationValid: true,
      canOpenDirectory: Boolean(this.host?.openPackDirectory),
      grantedPermissions: current.grantedPermissions,
      unsupportedPermissions: current.manifest.permissions.filter((item) => !RUNTIME_SUPPORTED.has(item.id)).map((item) => item.id),
      recent: this.db.prepare("SELECT event_type AS eventType,summary,metadata_json AS metadata,created_at AS createdAt FROM marketplace_logs WHERE pack_id=? ORDER BY created_at DESC LIMIT 30")
        .all(id).map((item) => ({ ...item, metadata: JSON.parse(item.metadata || "{}") }))
    };
  }

  repair(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const manifestFile = path.join(this.packsDir, id, "manifest.json");
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")), { evolvVersion: this.version, platform: this.platform });
    this.db.prepare("UPDATE marketplace_installed SET manifest_json=?,status='healthy',error='',updated_at=? WHERE id=?")
      .run(JSON.stringify(manifest), timestamp(), id);
    this.#log(id, "repaired", `Repaired ${manifest.name} registration`);
    return this.getInstalled(id);
  }

  async openDirectory(id) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    if (!this.host?.openPackDirectory) throw Object.assign(new Error("Opening a pack directory requires the Evolv desktop app."), { status: 409 });
    await this.host.openPackDirectory(path.join(this.packsDir, id));
    this.#log(id, "directory-opened", `Opened ${current.manifest.name} pack directory`);
    return { ok: true };
  }

  async chooseConfigurationPath(id, key) {
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Installed pack not found."), { status: 404 });
    const definition = current.manifest.configSchema.properties?.[String(key || "")];
    if (!definition || !["file", "folder"].includes(definition.format)) {
      throw Object.assign(new Error("This configuration field does not support a file or folder picker."), { status: 400 });
    }
    if (!this.host?.chooseConfigurationPath) {
      throw Object.assign(new Error("File and folder pickers require the Evolv desktop app."), { status: 409 });
    }
    return this.host.chooseConfigurationPath({
      kind: definition.format,
      title: definition.title || `Choose ${definition.format}`
    });
  }

  developerWatchStatus() {
    return [...this.devWatchers.entries()].map(([id, watcher]) => ({
      id,
      sourceName: watcher.sourceName,
      status: watcher.status,
      lastReloadAt: watcher.lastReloadAt,
      error: watcher.error
    }));
  }

  async startDeveloperWatch(id) {
    if (!this.developerMode()) throw Object.assign(new Error("Enable Marketplace Developer Mode first."), { status: 403 });
    const current = this.getInstalled(id);
    if (!current) throw Object.assign(new Error("Install the development pack once before enabling live reload."), { status: 404 });
    if (!this.host?.choosePackSourceDirectory) {
      throw Object.assign(new Error("Pack live reload requires the Evolv desktop app."), { status: 409 });
    }
    const selection = await this.host.choosePackSourceDirectory();
    if (selection.canceled || !selection.path) return { canceled: true };
    const sourceRoot = path.resolve(selection.path);
    if (sourceRoot === this.packsDir || sourceRoot.startsWith(`${this.packsDir}${path.sep}`)) {
      throw Object.assign(new Error("Choose your separate source folder, not Evolv's installed-pack folder."), { status: 400 });
    }
    this.stopDeveloperWatch(id);
    const watcher = {
      sourceRoot,
      sourceName: path.basename(sourceRoot),
      status: "validating",
      lastReloadAt: null,
      error: "",
      timer: null,
      stop: null
    };
    const reload = () => {
      try {
        const sourcePackage = readPackSourceDirectory(sourceRoot);
        const checked = validatePackPackage(sourcePackage, {
          evolvVersion: this.version,
          platform: this.platform,
          trustedKeyIds: this.#trustedKeyIds()
        });
        if (checked.manifest.id !== id) throw new Error(`Source manifest ID must remain ${id}.`);
        const active = this.getInstalled(id);
        const added = permissionDiff(active.manifest.permissions, checked.manifest.permissions).added;
        if (added.length || checked.manifest.permissions.some((permission) => permission.required && !active.grantedPermissions.includes(permission.id))) {
          throw new Error("Live reload paused because the source requests permissions that were not approved.");
        }
        this.install({ package: sourcePackage, approvedPermissions: active.grantedPermissions, reinstall: true });
        watcher.status = "watching";
        watcher.lastReloadAt = timestamp();
        watcher.error = "";
      } catch (error) {
        watcher.status = "invalid";
        watcher.error = String(error.message || error).slice(0, 1000);
      }
    };
    reload();
    if (watcher.status === "invalid") throw Object.assign(new Error(watcher.error), { status: 400 });
    watcher.stop = watchPackSource(sourceRoot, () => {
      clearTimeout(watcher.timer);
      watcher.timer = setTimeout(reload, 220);
    });
    this.devWatchers.set(id, watcher);
    this.#log(id, "dev-watch-started", `Started validated live reload for ${current.manifest.name}`, { sourceName: watcher.sourceName });
    return { canceled: false, ...this.developerWatchStatus().find((item) => item.id === id) };
  }

  stopDeveloperWatch(id) {
    const watcher = this.devWatchers.get(id);
    if (!watcher) return { ok: true };
    clearTimeout(watcher.timer);
    watcher.stop?.();
    this.devWatchers.delete(id);
    return { ok: true };
  }

  close() {
    for (const id of [...this.devWatchers.keys()]) this.stopDeveloperWatch(id);
  }

  developerMode(enabled) {
    if (enabled !== undefined) {
      this.db.prepare(`INSERT INTO marketplace_settings(key,value_json,updated_at) VALUES ('developerMode',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(JSON.stringify(Boolean(enabled)), timestamp());
    }
    const row = this.db.prepare("SELECT value_json FROM marketplace_settings WHERE key='developerMode'").get();
    return Boolean(row && JSON.parse(row.value_json));
  }

  createStarter(input) {
    if (!this.developerMode()) throw Object.assign(new Error("Enable Marketplace Developer Mode first."), { status: 403 });
    const name = String(input.name || "").trim().slice(0, 120);
    const id = String(input.id || "").trim();
    if (!name || !PACK_ID.test(id)) throw Object.assign(new Error("Enter a valid pack name and evolv.pack-id."), { status: 400 });
    const selectedPermissions = normalizeStringList(input.permissions, 20, 100);
    for (const permission of selectedPermissions) if (!PERMISSIONS[permission]) throw Object.assign(new Error(`Unknown permission: ${permission}.`), { status: 400 });
    const slug = id.slice("evolv.".length).replaceAll(".", "-");
    return validatePackPackage({
      packageVersion: 1,
      manifest: {
        schemaVersion: 1, id, name, version: "0.1.0",
        author: { name: String(input.author || "Local developer").slice(0, 120) },
        description: String(input.description || `${name} capability pack.`).slice(0, 300),
        fullDescription: String(input.description || `${name} is a locally developed declarative Evolv capability pack.`).slice(0, 5000),
        category: CATEGORIES.includes(input.category) ? input.category : "productivity",
        license: "Local development pack",
        tags: [slug], icon: "◇", screenshots: ["Starter pack preview"], minEvolvVersion: this.version,
        platforms: ["windows", "linux", "macos"], models: { local: ["llama", "qwen"], cloud: [] },
        permissions: [...new Set(["models.local", ...selectedPermissions])].map((permission) => ({ id: permission, required: permission === "models.local", reason: "Selected by the pack developer." })),
        installedSize: 8_000, changelog: ["0.1.0 — Starter pack."],
        configSchema: { type: "object", properties: {} },
        agents: [{ id: `${slug}-agent`, name: String(input.agentName || name), description: `Specialist agent for ${name}.`, systemPrompt: String(input.agentPrompt || `You are the ${name} specialist. Be accurate, evidence-based, and explicit about uncertainty.`), recommendedModels: ["llama"], tools: [], temperature: 0.3 }],
        commands: [{ id: `${slug}-command`, name: String(input.commandName || `Use ${name}`), description: `Run the primary ${name} task.`, agentId: `${slug}-agent`, promptTemplate: String(input.commandPrompt || "Complete this specialist task: {{input}}"), requiresApproval: false }],
        workflows: [{ id: `${slug}-workflow`, name: `${name} workflow`, description: "Gather, analyze, verify, and report.", steps: ["Gather context.", "Analyze evidence.", "Verify constraints.", "Report the result."] }],
        examples: ["Run the starter command", "Review a relevant example", "Create a repeatable checklist", "Explain an error", "Plan the next step"],
        features: ["Specialist agent", "Primary command", "Guided workflow"], documentation: `# ${name}\n\nStarter pack generated by Evolv Marketplace Developer Mode.`, knowledge: [],
        verified: false, featured: false, price: 0, rating: 0, reviewCount: 0
      },
      files: { "README.md": `# ${name}\n\nStarter pack generated locally.`, "CHANGELOG.md": "0.1.0 — Starter pack." }
    }, { evolvVersion: this.version, platform: this.platform });
  }
}
