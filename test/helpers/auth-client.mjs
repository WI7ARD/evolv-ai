const TEST_PASSWORD = "correct horse battery staple";

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

export async function createAuthenticatedClient(base, password = TEST_PASSWORD) {
  const statusResponse = await fetch(`${base}/api/auth/status`);
  const status = await statusResponse.json();
  let response;
  if (!status.configured) {
    response = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base
      },
      body: JSON.stringify({
        setupNonce: status.setupNonce,
        password,
        confirmPassword: password
      })
    });
  } else {
    response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base
      },
      body: JSON.stringify({ password })
    });
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Authentication failed (${response.status})`);
  let cookie = cookieFrom(response);
  let csrfToken = payload.csrfToken;

  return {
    password,
    recoveryCode: payload.recoveryCode,
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },
    async fetch(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase();
      const headers = {
        cookie,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      };
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers.origin ||= base;
        headers["x-evolv-csrf"] ||= csrfToken;
      }
      const result = await fetch(path.startsWith("http") ? path : `${base}${path}`, { ...options, headers });
      const replacementCookie = cookieFrom(result);
      if (replacementCookie) cookie = replacementCookie;
      return result;
    },
    setCsrf(value) {
      csrfToken = value;
    }
  };
}
