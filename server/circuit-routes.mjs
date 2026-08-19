// Circuit sandbox HTTP surface.
//
// Modelled on server/physics-routes.mjs, and for the same reasons. The circuit
// lives in the server, so these routes are a window onto it rather than a second
// copy of it, and the two shapes of read answer different questions: /frame is
// geometry for drawing, / is meaning for reading. Keeping them apart stops the
// renderer paying for prose and stops a model parsing wire coordinates to find
// out what voltage a node sits at.
//
// Every write is the same action the model's tools call, through the same
// service method, so a person clicking the toolbar and a model calling
// circuit_build cannot drift apart.

export async function handleCircuitRoutes(context) {
  const { req, res, url, readBody, bodyLimit, json, circuitService, database } = context;
  if (!url.pathname.startsWith("/api/circuit")) return false;
  if (!circuitService) {
    throw Object.assign(new Error("The circuit sandbox is unavailable in this build."), {
      status: 503, code: "CAPABILITY_UNAVAILABLE"
    });
  }

  // Drawing data: symbols, wires, and the numbers to write beside them.
  if (req.method === "GET" && url.pathname === "/api/circuit/frame") {
    json(res, 200, circuitService.frame());
    return true;
  }

  // The same reading a model gets from circuit_look.
  if (req.method === "GET" && url.pathname === "/api/circuit") {
    json(res, 200, circuitService.perceive());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/circuit/actions") {
    const body = await readBody(req, bodyLimit);
    const actions = Array.isArray(body.actions) ? body.actions : [body];
    if (actions.length > 40) {
      throw Object.assign(new Error("Send at most 40 circuit actions at once."), { status: 400, code: "CIRCUIT_TOO_MANY_ACTIONS" });
    }
    const results = [];
    for (const action of actions) results.push(circuitService.apply(action?.action, action || {}));
    json(res, 200, { results, circuit: circuitService.perceive() });
    return true;
  }

  // Running gets its own route rather than going through /actions, which
  // returns full perception. A run answers with traces, which are the point of
  // it, and rebuilding the bill of materials alongside them is work nobody
  // reads.
  if (req.method === "POST" && url.pathname === "/api/circuit/run") {
    const body = await readBody(req, bodyLimit);
    json(res, 200, circuitService.run(body));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/circuit/rewind") {
    json(res, 200, { circuit: circuitService.rewind() });
    return true;
  }

  const firmwareMatch = url.pathname.match(/^\/api\/circuit\/firmware\/([^/]+)$/);
  if (firmwareMatch) {
    const id = decodeURIComponent(firmwareMatch[1]);
    if (req.method === "GET") {
      json(res, 200, circuitService.readFirmware(id));
      return true;
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req, bodyLimit);
      json(res, 200, circuitService.writeFirmware(id, body.source));
      return true;
    }
  }

  if (url.pathname === "/api/circuit/probes") {
    if (req.method === "POST") {
      const body = await readBody(req, bodyLimit);
      json(res, 200, circuitService.probe(body.target, body.measure));
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, circuitService.unprobe(url.searchParams.get("target")));
      return true;
    }
  }

  if (req.method === "DELETE" && url.pathname === "/api/circuit") {
    json(res, 200, circuitService.clear());
    return true;
  }

  // Saved circuits. The service holds no database handle — it stays memory-only,
  // which is what keeps its tools in the automatic risk tier — so persistence
  // lives out here, moving opaque snapshots between the two.
  if (url.pathname === "/api/circuit/circuits") {
    if (req.method === "GET") {
      json(res, 200, { circuits: database.listCircuits({ limit: url.searchParams.get("limit") || 50 }) });
      return true;
    }
    if (req.method === "POST") {
      const body = await readBody(req, bodyLimit);
      const snapshot = circuitService.snapshot();
      json(res, 201, database.saveCircuit({
        name: body.name, snapshot, partCount: snapshot.components.length
      }));
      return true;
    }
  }

  const savedMatch = url.pathname.match(/^\/api\/circuit\/circuits\/([^/]+)(?:\/(load))?$/);
  if (savedMatch) {
    const id = decodeURIComponent(savedMatch[1]);
    if (req.method === "POST" && savedMatch[2] === "load") {
      const saved = database.getCircuit(id);
      if (!saved) throw Object.assign(new Error("That circuit no longer exists."), { status: 404, code: "CIRCUIT_NOT_FOUND" });
      json(res, 200, { name: saved.name, circuit: circuitService.restore(saved.snapshot) });
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, { removed: database.deleteCircuit(id) });
      return true;
    }
  }

  return false;
}
