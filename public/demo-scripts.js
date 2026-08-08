// What the demo actually does.
//
// These are written out rather than invented by a model at run time. Asking a
// model to design the experiment would make the one button people press to see
// what Evolv is fail whenever Ollama is off, slow, or returns a scene that
// cannot be built. The chat demo still produces a live, unscripted answer — the
// question is fixed, the reply is not.
//
// Every step is a narration line paired with something to do. The line is
// spoken while the action runs, so the timing is the length of the sentence
// rather than a guessed delay.

// Physics actions are named exactly as the engine's dispatch switch expects,
// and a test asserts that every one of them is real. Objects a later step needs
// to name declare `as`, and are referenced as "$name" — hard-coding "circle-11"
// works until someone inserts a step above it, and then silently pushes the
// wrong object.
export const DEMO_SCRIPTS = Object.freeze([
  {
    id: "friction",
    title: "Which slides further, wood or ice?",
    kind: "physics",
    steps: [
      {
        say: "Here is a question you can answer in about thirty seconds. Two identical crates, two identical ramps. One crate is wood, the other is ice. How much further does the ice travel?",
        physics: [{ action: "clear" }, { action: "set_gravity", gravity: 1 }, { action: "set_wind", wind: 0 }]
      },
      {
        say: "First the ramps. Both are the same length and the same angle, so the only thing that differs is what is sliding on them.",
        physics: [
          { action: "create_ramp", x: 260, y: 250, width: 320, height: 18, angle: 0.3, material: "wood" },
          { action: "create_ramp", x: 260, y: 470, width: 320, height: 18, angle: 0.3, material: "wood" }
        ]
      },
      {
        say: "Now the crates. Same size, same shape, dropped from the same height. The top one is wood. The bottom one is ice, which in this world means no friction at all.",
        physics: [
          { action: "create_box", as: "wood", x: 140, y: 150, width: 44, height: 44, material: "wood", note: "wood crate" },
          { action: "create_box", as: "ice", x: 140, y: 370, width: 44, height: 44, material: "ice", note: "ice crate" }
        ]
      },
      { say: "Let it run.", run: 420 },
      { say: "", measure: { compare: ["$wood", "$ice"], axis: "x" } }
    ]
  },
  {
    id: "impact",
    title: "A heavy ball and a wall of crates",
    kind: "physics",
    steps: [
      {
        say: "Something less scientific and more satisfying. A wall of crates, and something heavy to throw at it.",
        physics: [{ action: "clear" }, { action: "set_gravity", gravity: 1 }, { action: "set_wind", wind: 0 }]
      },
      {
        say: "The wall first. Nine metal crates, stacked three high. Each one is a separate object with its own mass and friction, so the pile behaves like a pile rather than a single lump.",
        physics: [
          ...[0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => ({
            action: "create_box", x: 560 + column * 46, y: 530 - row * 46,
            width: 44, height: 44, material: "metal"
          })))
        ]
      },
      { say: "Let it settle, so nothing is falling when the ball arrives.", run: 120 },
      {
        say: "Now a solid metal ball, over on the left.",
        physics: [{ action: "create_circle", as: "ball", x: 120, y: 500, radius: 34, material: "metal" }]
      },
      {
        say: "And throw it.",
        physics: [{ action: "push", id: "$ball", vx: 26, vy: -3 }],
        run: 300
      },
      { say: "Nothing here is animated. Every one of those collisions is being solved as it happens.", run: 240 },
      { say: "", measure: { report: "settled" } }
    ]
  },
  {
    id: "thinking",
    title: "A question worth asking a local model",
    kind: "chat",
    prompt: "In two short paragraphs: why does a heavier object not fall faster than a lighter one in a vacuum, even though gravity pulls on it harder? Explain it the way you would to a first-year engineering student.",
    steps: [
      {
        say: "This one is not a simulation. Evolv is a chat application, and everything it does runs on your own computer against your own model. Nothing is being sent anywhere."
      },
      {
        say: "Here is a question that sounds simple and catches almost everyone out. I am typing it now, and the answer will be generated locally, live.",
        ask: true
      },
      { say: "" }
    ]
  }
]);

export function pickScript(id = "") {
  const chosen = DEMO_SCRIPTS.find((script) => script.id === id);
  if (chosen) return chosen;
  return DEMO_SCRIPTS[Math.floor(Math.random() * DEMO_SCRIPTS.length)];
}
