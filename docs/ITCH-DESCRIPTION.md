# itch.io store description

The copy for the Evolv project page. Kept here so it is versioned with the build
it describes, rather than living only in a web form. Paste into the itch.io
editor when the description changes.

---

## Evolv — local intelligence

An AI hardware bench and a chat that run on your own machine, against your own
models, and keep everything they learn there.

Evolv talks to Ollama running locally. Your conversations live in a SQLite file
on your disk, not on anyone's server. OpenAI is available for when a local model
is not enough, and when you use it Evolv tells you plainly what left the machine
— and lets you decide in advance what it is allowed to send.

### Evolv Circuit — a hardware bench

The reason to open Evolv. It takes a board from a sentence to something you can
order the parts for, and keeps the whole of it as one thing.

**The schematic is solved, not drawn.** Same method SPICE uses. An LED behind a
resistor lands where a bench meter would, because it comes from the diode
equation rather than a lookup table. Op-amps clip on their rails. A 555 astable
runs within a fraction of a percent of the formula. Motors draw an inrush, slow
under load, and stall.

**Put a microcontroller on it and write firmware.** Pin reads and writes, PWM,
timers, in a small language Evolv runs directly. Instructions cost clock cycles,
so `delay()` costs real time and a busy loop is genuinely slow, exactly like a
real board.

**Say what it should do, and be told whether it does.** *This LED reaches half
brightness. This rail never draws more than 30mA.* Every answer comes with the
figure it was judged on, so a failure is a diagnosis — "reached 8%, needed 50%"
points straight at the resistor.

**Then go and build it.** Export a KiCad netlist and a parts list.

**And when it is built, tell Evolv what your meter said.** That reading is
shown next to what the solver predicted — the one number in the whole program
that did not come from the simulation, and so the only one that can prove the
simulation wrong.

Each board keeps its own history: nine stages from the sentence that started it
to the reading off the finished thing. Nothing has to be remembered — every
stage writes itself down as it happens. And because each record names the design
it judged, a netlist exported before you changed a resistor says it is out of
date rather than quietly looking current.

### Ask, and it builds

It is all wired to the assistant as tools, so you can say:

> Build a bike telemetry board: a wheel sensor, a temperature sensor and an
> accelerometer into a microcontroller, and log the speed once a second.

and watch it appear, run, and report back what actually happened.

### There is a physics world too

Boxes, ramps, motors, gears, chains, ropes, ragdolls and cars, with five
materials that behave like their names — rubber bounces about three times higher
than default, and a crate that slides 279 pixels down a ramp carries on to 774
if you make it ice. Gravity goes negative. Wind pushes. Grab anything and drag
it mid-simulation.

### The rest of it

- **Multiple local accounts**, each with its own password, recovery code and
  completely separate conversation database
- **Reversible behaviour upgrades** — Evolv proposes changes to how it works with
  you, and nothing takes effect until you approve it
- **Safe local tools** with a permission tier per tool, and a checkpoint so an
  effectful tool never runs twice
- **API keys encrypted and write-only** — sealed with the Windows Data Protection
  API on the desktop build, and never returned to the browser or included in an
  export
- **Obsidian vault integration** and project folders, both opt-in
- **Runs in a browser** with `npm start`, or as a hardened Windows desktop app

### Requirements

Ollama, for local models. An OpenAI key is optional and only needed if you want
a cloud model. Windows build is 64-bit; there is a Linux AppImage too.

Free, MIT licensed, and the source is on GitHub.
