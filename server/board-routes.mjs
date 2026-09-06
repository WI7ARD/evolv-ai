// Boards: the HTTP surface of the bench.
//
// One board is open at a time and everything else on the bench acts on it, so
// most of these routes are about which one that is. The stages are not written
// from here — they are written by the circuit routes as the work happens, which
// is the only way a history stays complete without anyone maintaining it.
//
// The exceptions are the two stages that happen off the machine: a board being
// built, and a board being measured. Nothing in the simulator can observe
// either, so those are the two things a person tells it.

export async function handleBoardRoutes(context) {
  const { req, res, url, readBody, bodyLimit, json, bench } = context;
  if (!url.pathname.startsWith("/api/boards")) return false;
  if (!bench) {
    throw Object.assign(new Error("Boards are unavailable in this build."), {
      status: 503, code: "CAPABILITY_UNAVAILABLE"
    });
  }

  if (url.pathname === "/api/boards") {
    if (req.method === "GET") {
      json(res, 200, {
        boards: bench.list({
          limit: url.searchParams.get("limit") || 50,
          projectId: url.searchParams.get("projectId") || null
        }),
        openBoardId: bench.openBoardId
      });
      return true;
    }
    // Saving the design on the bench. Updates the open board unless asNew is
    // asked for, so the ordinary press of Save does not fork the board.
    if (req.method === "POST") {
      const body = await readBody(req, bodyLimit);
      const board = bench.save({
        name: body.name, intent: body.intent ?? null,
        projectId: body.projectId ?? null, boardId: body.boardId || null,
        asNew: Boolean(body.asNew)
      });
      json(res, 201, { board });
      return true;
    }
  }

  // Checked before the :id routes below, which would otherwise read "current"
  // as a board id and answer 404 for the board that is actually open.
  if (req.method === "GET" && url.pathname === "/api/boards/current") {
    json(res, 200, { board: bench.current(), openBoardId: bench.openBoardId });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/boards/close") {
    json(res, 200, { closed: bench.close() });
    return true;
  }

  const measurementMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/measurements(?:\/([^/]+))?$/);
  if (measurementMatch) {
    const boardId = decodeURIComponent(measurementMatch[1]);
    if (req.method === "POST" && !measurementMatch[2]) {
      const body = await readBody(req, bodyLimit);
      json(res, 201, { board: bench.measure(body, { boardId }) });
      return true;
    }
    if (req.method === "DELETE" && measurementMatch[2]) {
      json(res, 200, { board: bench.unmeasure(decodeURIComponent(measurementMatch[2]), { boardId }) });
      return true;
    }
  }

  const openMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/open$/);
  if (req.method === "POST" && openMatch) {
    json(res, 200, { board: bench.open(decodeURIComponent(openMatch[1])) });
    return true;
  }

  // The one stage nothing on this machine can observe.
  const builtMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/built$/);
  if (req.method === "POST" && builtMatch) {
    const body = await readBody(req, bodyLimit);
    const id = decodeURIComponent(builtMatch[1]);
    if (id !== bench.openBoardId) bench.open(id);
    json(res, 200, { board: bench.markBuilt({ note: body.note }) });
    return true;
  }

  // The links between the board and the world, and the run that steps both.
  //
  // On /api/boards rather than a surface of their own because a link belongs to
  // the bench, not to either simulation: neither the circuit nor the world can
  // answer what it is joined to.
  if (url.pathname === "/api/boards/links") {
    if (req.method === "GET") {
      json(res, 200, { links: bench.links() });
      return true;
    }
    if (req.method === "POST") {
      const body = await readBody(req, bodyLimit);
      json(res, 201, { link: bench.link(body), links: bench.links() });
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, { ...bench.unlink(url.searchParams.get("id")), links: bench.links() });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/boards/coupled-run") {
    const body = await readBody(req, bodyLimit);
    json(res, 200, bench.runCoupled(body));
    return true;
  }

  const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch) {
    const id = decodeURIComponent(boardMatch[1]);
    if (req.method === "GET") {
      const board = bench.get(id);
      if (!board) throw Object.assign(new Error("There is no board with that id."), { status: 404, code: "BOARD_NOT_FOUND" });
      json(res, 200, { board });
      return true;
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const body = await readBody(req, bodyLimit);
      json(res, 200, {
        board: bench.describe(id, {
          name: body.name ?? null, intent: body.intent ?? null,
          ...("projectId" in body ? { projectId: body.projectId } : {})
        })
      });
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, { removed: bench.remove(id) });
      return true;
    }
  }

  return false;
}
