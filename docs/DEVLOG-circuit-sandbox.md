# Evolv can build a circuit now, and program it

Evolv is a local-first AI chat that runs against your own Ollama models. It
already had a physics sandbox. This update adds a second one that is less about
play and more about building something real: a schematic you could put on a
bench, solved properly, with firmware you can run on it.

Type `/circuit` and it opens.

![The bike telemetry board: a wheel sensor, a thermistor divider and an accelerometer into a microcontroller](assets/circuit-board.png)

## It is a solver, not a drawing

Everything is computed on your machine by a modified nodal analysis solver with
Newton–Raphson for the nonlinear parts — the same method SPICE uses. Diodes come
from the exponential rather than a lookup table, so a red LED behind 220Ω on 5V
lands at 2.1V and 13mA because that is where the maths puts it.

Resistor values snap to the E12 series, and the snap is reported back: ask for
3.7k and you are told you were given 3.9k, because nobody sells a 3.7k.

Parts get real reference designators — R1, C3, D2 — so the bill of materials is
one you could actually order from.

## The chips real projects are built from

Op-amps, 7805 regulators, 74HC logic, D-type flip-flops, 555 timers. Each was
checked against its datasheet arithmetic: an inverting op-amp at exactly
−Rf/Rin, a 555 astable within 0.3% of `1.44/((R1+2·R2)·C)`, a 7805 holding
5.000V from 9V and honestly following the input down below dropout.

An op-amp asked for 40V on a 12V rail clips at 10.5V, which is the whole lesson
of the first op-amp circuit anyone builds wrong.

## Outputs that do something

LEDs light at a brightness taken from their actual forward current. Motors have
winding resistance, inductance and back-EMF, so they draw an inrush at start-up,
slow under load, and stall — all three falling out of the model rather than
being special-cased. Servos slew. Buzzers show a frequency and a note name and
stay silent, and the interface says so, because a buzzer that draws a waveform
and makes no sound looks broken.

## Firmware, in an interpreter

There is no AVR toolchain here and there cannot be one, so firmware is written
in a small language Evolv reads directly: `pinMode`, `digitalWrite`,
`analogRead`, `analogWrite`, `delay`, `millis`, plus variables, loops and
functions.

Instructions cost clock cycles at the chip's rate. `delay()` therefore costs
real simulated time, a busy loop is genuinely slow, and `analogWrite` produces
an actual square wave rather than an average — so a PWM-dimmed LED and a
PWM-driven servo both behave.

Evolv has never run AI-written code — there is no `eval`, no `new Function`, no
`node:vm` anywhere in the tree — and this is the first thing that would have
tested that. So it is an interpreter, never an evaluator. A name the interpreter
does not know is a firmware error, not a lookup in some outer scope, because
there is no outer scope to reach.

![What the board printed over an eight-second ride](assets/circuit-firmware.png)

## Sensors, and a world for them to sense

A sensor with nothing to sense is a resistor with an interesting name. So the
sandbox has surroundings — temperature, road speed, tilt, light — and four parts
that respond to them: a 10kΩ NTC thermistor on its beta curve, a light sensor on
its power law, a hall wheel sensor, and a ±3g accelerometer that sits at half the
rail and pins at its range.

Each condition is a number or a ramp. The ramp is the point: *does my board read
the right speed while I accelerate away from the lights* is not a question a
constant can ask.

## Saying what it should do

`circuit_expect` states a requirement — `D1 lit reaches 50%`, `PS1 current never
goes above 30mA` — and Check runs the circuit and reports each one **with the
measured figure**. "Failed" without the number is not a diagnosis; "reached 8%
brightness, needed 50%" points at the resistor.

These test the device, not the code. An assertion inside firmware can only see
the pin it just set, never the current that pin caused.

![Four expectations, each with what was actually measured](assets/circuit-checks.png)

## And then out to a real board

Export produces a KiCad netlist and a bill of materials. Every part carries a
symbol, a footprint from the libraries KiCad ships with, and a numbered leg for
each named pin. Ground symbols are not exported as parts, because a ground is a
label rather than something to solder.

One honest caveat: this has not been opened in KiCad — there is none in the
environment it was written in. The structure is asserted by a test that parses
the file as an s-expression, and every part is checked for a symbol, a footprint
and unique pin numbers. What that cannot check is whether the diode pin
numbering matches your KiCad. Pin 1 is the cathode here; it is the one
convention that is not self-evident and the first thing to check on a first
board.

## What running it kept finding

Every stage had a fault that only appeared by launching the app and looking.
Symbols floating above their wires. Three nets rendered into one channel as
`NVC2.5G6V`. Six chips missing from the designator table, so a 555 came out
labelled `undefined1` — on the schematic, in the parts list, and in the bill of
materials, while every test passed.

Two were physics rather than polish. A microcontroller drew no supply current at
all, which on a battery board is the largest line in the budget. And every
driven output created its current instead of taking it off the rail: a gate lit
an LED at exactly the bench current while the supply reported delivering none of
it. Both are fixed; a board now adds up to a figure you can choose a cell
against.

The bike telemetry board above draws 17.5mA — which is what this was built for.
