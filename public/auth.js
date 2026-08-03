const views = {
  loading: document.querySelector("#loading-view"),
  setup: document.querySelector("#setup-view"),
  login: document.querySelector("#login-view"),
  recovery: document.querySelector("#recovery-view"),
  result: document.querySelector("#recovery-result-view")
};
const errorNode = document.querySelector("#auth-error");
let registrationNonce = "";
let configured = false;

function show(name) {
  Object.entries(views).forEach(([key, node]) => node.classList.toggle("hidden", key !== name));
  errorNode.classList.add("hidden");
  errorNode.textContent = "";
  views[name]?.querySelector("input")?.focus();
}

function showError(message) {
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.retryAfter = Number(response.headers.get("retry-after")) || 0;
    throw error;
  }
  return payload;
}

function showRecoveryCode(code) {
  document.querySelector("#new-recovery-code").textContent = code;
  document.querySelector("#recovery-saved").checked = false;
  document.querySelector("#continue-button").disabled = true;
  show("result");
}

document.querySelector("#setup-view").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/api/auth/setup", {
      registrationNonce,
      username: document.querySelector("#setup-username").value,
      password: document.querySelector("#setup-password").value,
      confirmPassword: document.querySelector("#setup-confirm").value
    });
    showRecoveryCode(result.recoveryCode);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#login-view").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await request("/api/auth/login", {
      username: document.querySelector("#login-username").value,
      password: document.querySelector("#login-password").value
    });
    window.location.replace("/");
  } catch (error) {
    showError(error.message);
    document.querySelector("#login-password").select();
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#recovery-view").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/api/auth/recover", {
      username: document.querySelector("#recovery-username").value,
      recoveryCode: document.querySelector("#recovery-code").value,
      newPassword: document.querySelector("#recovery-password").value,
      confirmPassword: document.querySelector("#recovery-confirm").value
    });
    showRecoveryCode(result.recoveryCode);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#forgot-button").addEventListener("click", () => show("recovery"));
document.querySelector("#back-login-button").addEventListener("click", () => show("login"));
document.querySelector("#create-account-button").addEventListener("click", () => {
  document.querySelector("#back-from-register-button").classList.remove("hidden");
  show("setup");
});
document.querySelector("#back-from-register-button").addEventListener("click", () => show("login"));
document.querySelector("#recovery-saved").addEventListener("change", (event) => {
  document.querySelector("#continue-button").disabled = !event.currentTarget.checked;
});
document.querySelector("#continue-button").addEventListener("click", () => window.location.replace("/"));
document.querySelector("#copy-recovery-button").addEventListener("click", async () => {
  const code = document.querySelector("#new-recovery-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    document.querySelector("#copy-recovery-button").textContent = "Copied";
  } catch {
    showError("Copy was blocked. Select the code and copy it manually.");
  }
});

const exitButton = document.querySelector("#exit-app-button");
if (window.evolvDesktopApp?.quit) {
  exitButton.classList.remove("hidden");
  exitButton.addEventListener("click", async () => {
    exitButton.disabled = true;
    exitButton.textContent = "Closing Evolv…";
    try {
      await window.evolvDesktopApp.quit();
    } catch {
      exitButton.disabled = false;
      exitButton.textContent = "Exit Evolv";
      showError("Evolv could not close. Use the window X or Alt+F4.");
    }
  });
}

try {
  const status = await request("/api/auth/status");
  configured = status.configured;
  registrationNonce = status.registrationNonce || status.setupNonce;
  if (status.authenticated) {
    window.location.replace("/");
  } else if (status.configured) {
    show("login");
  } else {
    document.querySelector("#back-from-register-button").classList.add("hidden");
    show("setup");
  }
} catch (error) {
  showError(error.message);
}
