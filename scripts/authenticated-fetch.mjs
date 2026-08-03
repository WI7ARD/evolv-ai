export async function createAuthenticatedFetch(baseUrl) {
  const statusResponse = await fetch(`${baseUrl}/api/auth/status`);
  if (!statusResponse.ok) throw new Error(`Cannot reach Evolv authentication (${statusResponse.status}).`);
  const status = await statusResponse.json();
  if (!status.configured) {
    throw new Error(`Evolv has not been secured yet. Open ${baseUrl} and complete first-run setup.`);
  }
  const password = process.env.EVOLV_PASSWORD;
  if (!password) {
    throw new Error("Set EVOLV_PASSWORD for smoke tests. The value is used only to create a temporary local session.");
  }
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ password })
  });
  const login = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok) throw new Error(login.error || `Evolv login failed (${loginResponse.status}).`);
  const cookie = String(loginResponse.headers.get("set-cookie") || "").split(";", 1)[0];
  const csrfToken = login.csrfToken;

  return async (pathname, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const headers = {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    };
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.origin ||= baseUrl;
      headers["x-evolv-csrf"] ||= csrfToken;
    }
    return fetch(pathname.startsWith("http") ? pathname : `${baseUrl}${pathname}`, { ...options, headers });
  };
}
