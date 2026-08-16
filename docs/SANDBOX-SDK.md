# Evolv Sandbox SDK

A proposed format for extending the simulation world with new object types,
skills, and zones.

> **This is a design, not a feature.** No code reads this format. `objectTypes`
> has never appeared anywhere in `lib/` or `server/` in the project's history,
> and the pack system that 0.6.4 assumed would deliver extensions never carried
> a `world` field either. `lib/world.mjs` exports frozen `ZONES` and `SKILLS`
> literals — the set is written in the file and nothing extends it.
>
> Removing packs in 0.6.5 therefore broke nothing here; it removed a delivery
> vehicle this document had assumed and which had never been connected. What
> follows is worth keeping because the constraints are the interesting part and
> they have held up — but read it as a specification to build against, not as
> instructions you can follow today.

An extension would be data: it names object types, the skills that may act on
them, and where they appear. It carries no code and executes nothing. This is not
a limitation to be worked around later — it is the reason a user could install
one without auditing it.

Version the design targets: `WORLD_VERSION = 1` (`lib/world.mjs`).

---

## The one rule

**Everything drawn must be derived from something that happened.**

This part is not aspirational — it is how `lib/world.mjs` already works, and it
is the constraint any extension format has to inherit.

`perceive(session)` is a pure function of a real sandbox session. It has no
state of its own, no timers, and no random placement that varies between
calls. The renderer draws its output and nothing else.

An extension that wanted to show an object with no underlying record, or a
sprite mood not implied by session state, would have to break this contract,
and the review for any published extension should reject it. A product whose
claim is "we tell you exactly what we did" cannot have an animation layer that
embellishes. If a frame shows the agent testing, a check is really running.

---

## Object types

An object type declares how a kind of real record is presented.

```json
{
  "id": "migration",
  "label": "Migration",
  "zone": "workbench",
  "shape": "card",
  "states": {
    "pending": { "color": "#c9d24b" },
    "applied": { "color": "#6fd08c" },
    "failed":  { "color": "#e2685f" }
  },
  "derivedFrom": "sandbox.edits",
  "match": { "pathPattern": "^migrations/" }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique within the extension |
| `zone` | One of the declared zones |
| `shape` | `card`, `disc`, or `slab` — the renderer owns the drawing |
| `states` | Named states with a colour; a state must correspond to real record state |
| `derivedFrom` | The record set this reads: `sandbox.edits`, `sandbox.validations`, `run.steps`, `run.evidence` |
| `match` | Optional filter narrowing which records become this object |

`derivedFrom` is the enforcement point. An object type can only ever be backed
by a record set Evolv already maintains, so an extension cannot conjure
objects; it can only choose how existing ones look.

## Skills

A skill declares a capability. It names tools; it does not contain them.

```json
{
  "id": "migrate",
  "label": "Migrate",
  "summary": "Write and check a schema migration inside the simulation.",
  "tools": ["sandbox_write_file", "sandbox_validate"],
  "requires": ["sandbox"]
}
```

Every entry in `tools` must already exist and be enabled; a skill cannot
introduce a new capability, only compose approved ones. `requires` gates
availability on real state — `sandbox`, `validated`, `failed-check`.

The tool layer stays the only thing that acts. A skill that could execute
would be an executable plugin, which is a different security model with a much
higher bar (see the roadmap, §11, where that route was closed).

## Zones

```json
{ "id": "archive", "label": "Archive", "x": 74, "y": 50, "width": 26, "height": 50 }
```

Coordinates are percentages of the canvas. Zones must not overlap; the
renderer clips objects to their zone, so an overlapping layout hides work
rather than revealing it.

## Delivery — unresolved

This is the open question, and it is the reason none of the above is built.

Earlier drafts assumed a world extension would ship inside a `.evolvpack` under
a `world` key. Packs were removed in 0.6.5 (roadmap §11) and had never
implemented that key, so there is currently no answer to "where does an
extension come from".

What the answer must preserve, whatever it turns out to be:

- **No permissions.** A declaration that reads existing records and draws them
  grants nothing. Installing a world extension should never be a security
  decision, and if a proposed delivery mechanism makes it one, that mechanism is
  wrong for this.
- **Validated before it renders**, against the rules below.
- **Pulled, not pushed.** The same conclusion the roadmap reached about plugins
  generally: build the install path when somebody wants to ship an extension,
  not on the chance that they might.

A file the user points at, validated on load, would satisfy all three and is
considerably less machinery than a catalog.

## Validation

The validator does not exist yet. When it does, an extension should be rejected
if it:

- names a `derivedFrom` that is not a known record set;
- names a tool that does not exist or is not enabled;
- declares a skill containing executable fields (`run`, `execute`, `script`);
- declares overlapping zones or coordinates outside 0–100;
- declares an object state with no corresponding real record state;
- targets a `worldVersion` this build does not implement.

## Stability

`WORLD_VERSION` changes when the shape of `perceive()` output changes.
Extensions would declare the version they target and be refused against a build
that does not implement it, rather than being silently half-rendered. The
constant is real and lives in `lib/world.mjs`; the refusal is not built.

## What is deliberately absent

- **No physics, collision, or pathfinding.** Position is a layout of real
  records. Movement between frames would imply activity that did not occur.
- **No agent inventory beyond staged edits.** "Carrying" means "has staged and
  not yet applied", which is a real thing with a real record.
- **No custom rendering code.** Extensions choose shape and colour from a
  fixed set. Arbitrary drawing would let an extension paint anything,
  including a claim that work succeeded.
