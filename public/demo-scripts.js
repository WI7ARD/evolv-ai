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
//
// Steps may also declare `expect`, which is checked against the engine's own
// perception once the step finishes. A script that builds the wrong thing then
// stops with a specific complaint instead of being narrated over confidently —
// which is exactly the failure this file had before.
//
//   objects   exact object count in the scene
//   atLeast   lower bound on the count
//   visible   named objects that must exist and be inside the 800x600 world
//   moved     named objects that must be somewhere else than when the step began
//   movedBy   how far "somewhere else" is, in pixels (default 20)
//
// Geometry is composed for the frame that is on screen: the world is 800 wide
// and 600 tall, the floor is the bottom edge, and everything below is built
// inside it rather than trusting objects to fall somewhere useful.

// Physics actions are named exactly as the engine's dispatch switch expects,
// and a test asserts that every one of them is real. Objects a later step needs
// to name declare `as`, and are referenced as "$name" — hard-coding "circle-11"
// works until someone inserts a step above it, and then silently pushes the
// wrong object.

// Both lanes of the friction experiment are the same shape to the pixel: a
// sloped ramp that feeds a long flat runout. Only the crate differs, which is
// the whole point — a taller drop or a shorter runout on one side would hand
// the result to whichever lane got the better deal.
//
// The track is metal and the slope is 23 degrees on purpose. Matter takes the
// lower of the two frictions in a contact, so a wood track (0.6) against a
// 17-degree slope holds the wood crate still — correct, and a demo where
// nothing moves. Metal (0.3) under tan(0.4) = 0.42 lets both crates run.
const SLOPE = 0.4;
const lane = (top) => [
  { action: "create_ramp", x: 190, y: top, width: 260, height: 16, angle: SLOPE, material: "metal" },
  { action: "create_ramp", x: 557, y: top + 51, width: 485, height: 16, angle: 0, material: "metal" }
];

export const DEMO_SCRIPTS = Object.freeze([
  {
    id: "friction",
    title: "Which slides further, wood or ice?",
    kind: "physics",
    steps: [
      {
        say: "Here is a question you can answer in about thirty seconds. Two identical crates, two identical slopes. One crate is wood, the other is ice. How much further does the ice travel?",
        physics: [{ action: "clear" }, { action: "set_gravity", gravity: 1 }, { action: "set_wind", wind: 0 }],
        expect: { objects: 0 }
      },
      {
        say: "Two lanes, one above the other. Each is a metal slope feeding a long flat run, and the two are the same length and the same angle, so nothing about the track favours either crate.",
        physics: [...lane(190), ...lane(450)],
        expect: { objects: 4 }
      },
      {
        say: "Now the crates. Same size, same shape, released from the same point on the slope. The top one is wood. The bottom one is ice, which in this world means no friction at all.",
        physics: [
          { action: "create_box", as: "wood", x: 110, y: 115, width: 44, height: 44, material: "wood", note: "wood crate" },
          { action: "create_box", as: "ice", x: 110, y: 375, width: 44, height: 44, material: "ice", note: "ice crate" }
        ],
        expect: { objects: 6, visible: ["$wood", "$ice"] }
      },
      {
        say: "Let them go. Same slope, same gravity, same starting height — watch how far each one carries along the flat.",
        run: 480,
        expect: { visible: ["$wood", "$ice"], moved: ["$wood", "$ice"], movedBy: 120 }
      },
      { say: "", measure: { compare: ["$wood", "$ice"], axis: "x", names: ["wood", "ice"] } }
    ]
  },
  {
    id: "impact",
    title: "A heavy ball and a wall of crates",
    kind: "physics",
    steps: [
      {
        say: "Something less scientific and more satisfying. A wall of crates, and something heavy to throw at it.",
        physics: [{ action: "clear" }, { action: "set_gravity", gravity: 1 }, { action: "set_wind", wind: 0 }],
        expect: { objects: 0 }
      },
      {
        say: "The wall first. Nine metal crates, stacked three high on the floor. Each one is a separate object with its own mass and friction, so the pile behaves like a pile rather than a single lump.",
        physics: [
          ...[0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => ({
            action: "create_box", x: 560 + column * 45, y: 578 - row * 45,
            width: 44, height: 44, material: "metal"
          })))
        ],
        expect: { objects: 9 }
      },
      { say: "Let it settle, so nothing is falling when the ball arrives.", run: 120 },
      {
        say: "Now a solid metal ball, over on the left.",
        physics: [{ action: "create_circle", as: "ball", x: 120, y: 560, radius: 34, material: "metal" }],
        expect: { objects: 10, visible: ["$ball"] }
      },
      {
        say: "And throw it.",
        physics: [{ action: "push", id: "$ball", vx: 26, vy: -2 }],
        run: 300,
        expect: { visible: ["$ball"], moved: ["$ball"], movedBy: 200 }
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
