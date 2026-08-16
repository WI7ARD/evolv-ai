# Evolv Sandbox SDK

How to extend the simulation world with new object types, skills, and zones.

The contract is **declarative**, matching the Marketplace pack format. An
extension is data: it names object types, the skills that may act on them, and
where they appear. It carries no code and executes nothing. This is not a
limitation to be worked around later — it is the reason a user can install one
without auditing it.

Version: `WORLD_VERSION = 1` (`lib/world.mjs`).

---

## The one rule

**Everything drawn must be derived from something that happened.**

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
higher bar (see the roadmap, §11).

## Zones

```json
{ "id": "archive", "label": "Archive", "x": 74, "y": 50, "width": 26, "height": 50 }
```

Coordinates are percentages of the canvas. Zones must not overlap; the
renderer clips objects to their zone, so an overlapping layout hides work
rather than revealing it.

## Packaging

A world extension ships inside a normal `.evolvpack` under `world`:

```json
{
  "schemaVersion": 1,
  "id": "evolv.migrations-world",
  "name": "Migrations World",
  "version": "1.0.0",
  "minEvolvVersion": "0.6.3",
  "permissions": [],
  "world": {
    "worldVersion": 1,
    "zones": [ ... ],
    "objectTypes": [ ... ],
    "skills": [ ... ]
  }
}
```

It needs no permissions. A declaration that reads existing records and draws
them grants nothing, which is the point: installing a world extension should
never be a security decision.

## Validation

An extension is rejected if it:

- names a `derivedFrom` that is not a known record set;
- names a tool that does not exist or is not enabled;
- declares a skill containing executable fields (`run`, `execute`, `script`);
- declares overlapping zones or coordinates outside 0–100;
- declares an object state with no corresponding real record state;
- targets a `worldVersion` this build does not implement.

## Stability

`WORLD_VERSION` changes when the shape of `perceive()` output changes.
Extensions declare the version they target and are refused against a build
that does not implement it, rather than being silently half-rendered.

## What is deliberately absent

- **No physics, collision, or pathfinding.** Position is a layout of real
  records. Movement between frames would imply activity that did not occur.
- **No agent inventory beyond staged edits.** "Carrying" means "has staged and
  not yet applied", which is a real thing with a real record.
- **No custom rendering code.** Extensions choose shape and colour from a
  fixed set. Arbitrary drawing would let an extension paint anything,
  including a claim that work succeeded.
