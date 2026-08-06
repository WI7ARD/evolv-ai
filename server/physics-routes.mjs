// Physics sandbox HTTP surface.
//
// The scene lives in the server, so these routes are a window onto it rather
// than a second copy of it. Two shapes of read, because they answer different
// questions: /frame is geometry for drawing, /look is meaning for reading.
// Keeping them apart stops the renderer from paying for prose and stops a
// model from parsing vertex arrays to find out whether a ball has stopped.
//
// Every write here is the same set of actions the model's tools call, through
// the same service method, so a person clicking a button and a model calling
// physics_build cannot drift apart.

export async function handlePhysicsRoutes(context) {
  const { req, res, url, readBody, bodyLimit, json, physicsService } = context;
  if (!url.pathname.startsWith("/api/physics")) return false;
  if (!physicsService) {
    throw Object.assign(new Error("The physics sandbox is unavailable in this build."), {
      status: 503, code: "CAPABILITY_UNAVAILABLE"
    });
  }

  // Drawing data: solved vertices, no prose. Polled every frame, so it stays
  // as small as it can be.
  if (req.method === "GET" && url.pathname === "/api/physics/frame") {
    json(res, 200, physicsService.frame());
    return true;
  }

  // Perception: the same reading a model gets from physics_look.
  if (req.method === "GET" && url.pathname === "/api/physics") {
    json(res, 200, physicsService.perceive());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/physics/actions") {
    const body = await readBody(req, bodyLimit);
    const actions = Array.isArray(body.actions) ? body.actions : [body];
    if (actions.length === 0 || actions.length > 50) {
      throw Object.assign(new Error("Send between 1 and 50 actions."), { status: 400, code: "PHYSICS_INVALID" });
    }
    // Applied in order, and a bad one stops the batch rather than leaving the
    // caller guessing which half of their scene exists.
    const results = [];
    for (const action of actions) {
      results.push(physicsService.apply(action?.action, action || {}));
    }
    json(res, 200, { results, scene: physicsService.perceive() });
    return true;
  }

  // Advancing time is a POST because it changes the world, even though it adds
  // nothing to it.
  if (req.method === "POST" && url.pathname === "/api/physics/step") {
    const body = await readBody(req, bodyLimit);
    const stepped = physicsService.step(body.steps === undefined ? 1 : body.steps);
    json(res, 200, { ...stepped, frame: physicsService.frame() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/physics/at") {
    json(res, 200, { object: physicsService.at(url.searchParams.get("x"), url.searchParams.get("y")) });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/physics") {
    json(res, 200, physicsService.clear());
    return true;
  }

  return false;
}
