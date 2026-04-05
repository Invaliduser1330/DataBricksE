// ═══════════════════════════════════════════════════════════════
// CONFIG & STATE
// ═══════════════════════════════════════════════════════════════
let config = {
  host: localStorage.getItem("db_host") || "",
  tenantId: localStorage.getItem("db_tenant_id") || "",
  clientId: localStorage.getItem("db_client_id") || "",
  clientSecret: localStorage.getItem("db_client_secret") || "",
  port: localStorage.getItem("db_port") || "5050",
  authMode: localStorage.getItem("db_auth_mode") || "sp", // 'sp' | 'interactive'
};

let authState = {
  isAuthenticated: false,
  accessToken: null,
  tokenExpiry: null,
  userName: null,
  userEmail: null,
};

let oauthPollTimer = null;
let currentDbfsPath = "/";
let currentNbPath = "/";

function apiBase() {
  return `http://localhost:${config.port}/api`;
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
(async function init() {
  updateWsBadge();

  // Attempt to restore session from backend
  const restored = await tryRestoreSession();
  if (restored) {
    showApp();
  } else {
    showLoginScreen();
  }
})();

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════
async function tryRestoreSession() {
  if (!config.host) return false;
  try {
    const res = await fetch(apiBase() + "/auth/status");
    const data = await res.json();
    if (data.authenticated) {
      authState.isAuthenticated = true;
      authState.userName = data.user_name || "User";
      authState.userEmail = data.user_email || "";
      return true;
    }
  } catch (_) {}
  return false;
}

// ═══════════════════════════════════════════════════════════════
// UI: LOGIN / APP SCREENS
// ═══════════════════════════════════════════════════════════════
function showLoginScreen() {
  document.getElementById("login-screen").classList.remove("hidden");
  document
    .querySelectorAll(".tab-content")
    .forEach((t) => t.classList.remove("active"));
  document.getElementById("conn-status").classList.remove("connected");
  document.getElementById("user-pill").style.display = "none";
  document.getElementById("logout-btn").style.display = "none";
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("conn-status").classList.add("connected");

  // Show user pill
  if (authState.userName) {
    document.getElementById("user-name").textContent = authState.userName;
    document.getElementById("user-pill").style.display = "flex";
    document.getElementById("logout-btn").style.display = "inline-flex";
  }

  // Activate clusters tab
  document.getElementById("tab-clusters").classList.add("active");
  updateWsBadge();
  loadClusters();
}

// ═══════════════════════════════════════════════════════════════
// OAUTH — INTERACTIVE (Azure AD Authorization Code + PKCE)
// ═══════════════════════════════════════════════════════════════

// Step 1: User clicks "Sign in with Microsoft"
async function startOAuth() {
  if (!config.host) {
    openConfig();
    return;
  }

  try {
    // Ask backend to start the OAuth flow — it generates the auth URL
    const res = await fetch(apiBase() + "/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: config.host,
        tenant_id: config.tenantId,
        port: config.port,
      }),
    });
    const data = await res.json();

    if (data.auth_url) {
      // Open Microsoft login in default browser
      window.open(data.auth_url, "_blank");

      // Show waiting overlay
      document.getElementById("oauth-overlay").classList.add("open");

      // Poll backend until token arrives (backend catches the redirect callback)
      pollForOAuthToken(data.state);
    } else {
      toast("Failed to start OAuth: " + (data.error || "Unknown error"));
    }
  } catch (e) {
    toast("OAuth error: " + e.message);
  }
}

// Step 2: Poll backend — it runs a local HTTP server on /oauth/callback
function pollForOAuthToken(state) {
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes max

  oauthPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      cancelOAuth();
      toast("OAuth login timed out. Please try again.");
      return;
    }

    try {
      const res = await fetch(apiBase() + "/auth/oauth/status?state=" + state);
      const data = await res.json();

      if (data.authenticated) {
        clearInterval(oauthPollTimer);
        document.getElementById("oauth-overlay").classList.remove("open");

        authState.isAuthenticated = true;
        authState.userName = data.user_name || "User";
        authState.userEmail = data.user_email || "";

        toast("Signed in as " + authState.userName, "success");
        showApp();
      }
    } catch (_) {}
  }, 1000);
}

function cancelOAuth() {
  if (oauthPollTimer) clearInterval(oauthPollTimer);
  document.getElementById("oauth-overlay").classList.remove("open");

  // Tell backend to cancel
  fetch(apiBase() + "/auth/oauth/cancel", { method: "POST" }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// OAUTH — SERVICE PRINCIPAL (Client Credentials Flow)
// ═══════════════════════════════════════════════════════════════
async function saveSpConfig() {
  const host = document.getElementById("cfg-host").value.trim();
  const tenantId = document.getElementById("cfg-tenant").value.trim();
  const clientId = document.getElementById("cfg-client-id").value.trim();
  const clientSecret = document
    .getElementById("cfg-client-secret")
    .value.trim();
  const port = document.getElementById("cfg-port").value.trim();

  if (!host || !tenantId || !clientId || !clientSecret) {
    toast("Please fill in all Service Principal fields");
    return;
  }

  // Persist
  config = { host, tenantId, clientId, clientSecret, port, authMode: "sp" };
  localStorage.setItem("db_host", host);
  localStorage.setItem("db_tenant_id", tenantId);
  localStorage.setItem("db_client_id", clientId);
  localStorage.setItem("db_client_secret", clientSecret);
  localStorage.setItem("db_port", port);
  localStorage.setItem("db_auth_mode", "sp");

  closeConfig();
  toast("Connecting via Service Principal...");

  // Send credentials to backend — it will acquire tokens automatically
  try {
    const res = await fetch(apiBase() + "/auth/sp/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host,
        tenant_id: tenantId,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await res.json();

    if (data.authenticated) {
      authState.isAuthenticated = true;
      authState.userName = data.user_name || "Service Principal";
      toast("Connected as " + authState.userName, "success");
      showApp();
    } else {
      toast("Connection failed: " + (data.error || "Check your credentials"));
    }
  } catch (e) {
    toast("Connection error: " + e.message);
  }
}

async function saveInteractiveConfig() {
  const host = document.getElementById("cfg-host-interactive").value.trim();
  const tenantId = document
    .getElementById("cfg-tenant-interactive")
    .value.trim();
  const port = document.getElementById("cfg-port-interactive").value.trim();

  if (!host || !tenantId) {
    toast("Please fill in Host URL and Tenant ID");
    return;
  }

  config.host = host;
  config.tenantId = tenantId;
  config.port = port;
  config.authMode = "interactive";

  localStorage.setItem("db_host", host);
  localStorage.setItem("db_tenant_id", tenantId);
  localStorage.setItem("db_port", port);
  localStorage.setItem("db_auth_mode", "interactive");

  closeConfig();
  startOAuth();
}

// ═══════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════
async function logout() {
  await fetch(apiBase() + "/auth/logout", { method: "POST" }).catch(() => {});
  authState = {
    isAuthenticated: false,
    accessToken: null,
    tokenExpiry: null,
    userName: null,
    userEmail: null,
  };
  showLoginScreen();
  toast("Signed out successfully");
}

// ═══════════════════════════════════════════════════════════════
// CONFIG MODAL
// ═══════════════════════════════════════════════════════════════
function openConfig() {
  document.getElementById("cfg-host").value = config.host;
  document.getElementById("cfg-tenant").value = config.tenantId;
  document.getElementById("cfg-client-id").value = config.clientId;
  document.getElementById("cfg-client-secret").value = config.clientSecret;
  document.getElementById("cfg-port").value = config.port;

  document.getElementById("cfg-host-interactive").value = config.host;
  document.getElementById("cfg-tenant-interactive").value = config.tenantId;
  document.getElementById("cfg-port-interactive").value = config.port;

  // Restore last auth tab
  const tabs = document.querySelectorAll(".auth-tab");
  tabs.forEach((t) => t.classList.remove("active"));
  const activeIdx = config.authMode === "interactive" ? 1 : 0;
  tabs[activeIdx].classList.add("active");
  document.getElementById("auth-sp").style.display =
    config.authMode === "sp" ? "" : "none";
  document.getElementById("auth-interactive").style.display =
    config.authMode === "interactive" ? "" : "none";

  document.getElementById("config-modal").classList.add("open");
}

function closeConfig() {
  document.getElementById("config-modal").classList.remove("open");
}

function switchAuthTab(mode, btn) {
  document
    .querySelectorAll(".auth-tab")
    .forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("auth-sp").style.display =
    mode === "sp" ? "" : "none";
  document.getElementById("auth-interactive").style.display =
    mode === "interactive" ? "" : "none";
  config.authMode = mode;
}

// ═══════════════════════════════════════════════════════════════
// WORKSPACE BADGE
// ═══════════════════════════════════════════════════════════════
function updateWsBadge() {
  const host = (config.host || "")
    .replace("https://", "")
    .replace("http://", "");
  document.getElementById("ws-badge").textContent = host || "not configured";
}

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show " + type;
  setTimeout(() => {
    el.className = "";
  }, 2800);
}

// ═══════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════
function showTab(name, btn) {
  document
    .querySelectorAll(".tab-content")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  btn.classList.add("active");

  const loaders = {
    clusters: loadClusters,
    jobs: loadJobs,
    runs: loadRuns,
    notebooks: () => loadNotebooks("/"),
    dbfs: () => loadDBFS("/"),
  };

  if (loaders[name]) loaders[name]();
}

// ═══════════════════════════════════════════════════════════════
// FILTER
// ═══════════════════════════════════════════════════════════════
function filterList(listId, query) {
  document.querySelectorAll("#" + listId + " .card").forEach((c) => {
    c.style.display = c.textContent.toLowerCase().includes(query.toLowerCase())
      ? ""
      : "none";
  });
}

// ═══════════════════════════════════════════════════════════════
// API HELPERS  (token is managed server-side via OAuth session)
// ═══════════════════════════════════════════════════════════════
async function apiFetch(path) {
  try {
    const res = await fetch(apiBase() + path, { credentials: "include" });
    if (res.status === 401) {
      logout();
      return { error: "Session expired. Please log in again." };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function apiPost(path, body = {}) {
  try {
    const res = await fetch(apiBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      logout();
      return { error: "Session expired." };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function apiDelete(path) {
  try {
    const res = await fetch(apiBase() + path, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.status === 401) {
      logout();
      return { error: "Session expired." };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// CLUSTERS
// ═══════════════════════════════════════════════════════════════
async function loadClusters() {
  const el = document.getElementById("cluster-list");
  el.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;

  const data = await apiFetch("/clusters");

  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="empty"><p style="color:var(--accent)">⚠ ${data.error || "Failed to load clusters"}</p></div>`;
    return;
  }

  if (!data.length) {
    el.innerHTML = `<div class="empty"><div class="icon">⬡</div><p>No clusters found</p></div>`;
    return;
  }

  el.innerHTML = data
    .map(
      (c) => `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-name">${c.name}</div>
          <div class="card-meta">ID: ${c.id}</div>
        </div>
        <span class="badge ${clusterBadge(c.state)}">${c.state}</span>
        <div class="card-actions">
          ${
            c.state === "TERMINATED"
              ? `<button class="btn btn-green btn-sm" onclick="clusterAction('start','${c.id}','${c.name}')">▶ Start</button>`
              : c.state === "RUNNING"
                ? `<button class="btn btn-ghost btn-sm" onclick="clusterAction('stop','${c.id}','${c.name}')">■ Stop</button>`
                : ""
          }
        </div>
      </div>
    </div>`,
    )
    .join("");
}

function clusterBadge(state) {
  if (state === "RUNNING") return "badge-running";
  if (state === "TERMINATED") return "badge-stopped";
  return "badge-pending";
}

async function clusterAction(action, id, name) {
  toast(`${action === "start" ? "Starting" : "Stopping"} ${name}...`);
  await apiPost(`/clusters/${id}/${action}`);
  setTimeout(loadClusters, 1500);
}

// ═══════════════════════════════════════════════════════════════
// JOBS
// ═══════════════════════════════════════════════════════════════
async function loadJobs() {
  const el = document.getElementById("job-list");
  el.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;

  const data = await apiFetch("/jobs");

  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="empty"><p style="color:var(--accent)">⚠ ${data.error || "Failed to load jobs"}</p></div>`;
    return;
  }

  if (!data.length) {
    el.innerHTML = `<div class="empty"><div class="icon">▶</div><p>No jobs found</p></div>`;
    return;
  }

  el.innerHTML = data
    .map(
      (j) => `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-name">${j.name}</div>
          <div class="card-meta">Job ID: ${j.id}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="runJob('${j.id}','${j.name}')">▶ Run Now</button>
      </div>
      <div class="run-progress" id="prog-${j.id}">
        <div class="run-progress-bar"></div>
      </div>
    </div>`,
    )
    .join("");
}

async function runJob(id, name) {
  const prog = document.getElementById("prog-" + id);
  if (prog) prog.classList.add("active");

  toast(`Triggering job: ${name}...`);
  const res = await apiPost(`/jobs/${id}/run`);

  if (res.run_id) {
    toast(`Job triggered! Run ID: ${res.run_id}`, "success");
    setTimeout(() => {
      if (prog) prog.classList.remove("active");
    }, 3000);
  } else {
    toast("Failed to run job: " + (res.error || "Unknown error"));
    if (prog) prog.classList.remove("active");
  }
}

// ═══════════════════════════════════════════════════════════════
// JOB RUNS
// ═══════════════════════════════════════════════════════════════
async function loadRuns() {
  const el = document.getElementById("runs-list");
  el.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;

  const data = await apiFetch("/jobs/runs");

  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="empty"><p style="color:var(--accent)">⚠ ${data.error || "Failed to load runs"}</p></div>`;
    return;
  }

  if (!data.length) {
    el.innerHTML = `<div class="empty"><div class="icon">◎</div><p>No recent runs</p></div>`;
    return;
  }

  el.innerHTML = data
    .map((r) => {
      const s = r.state || "UNKNOWN";
      const cls = s.includes("SUCCESS")
        ? "badge-success"
        : s.includes("FAIL") || s.includes("ERROR")
          ? "badge-failed"
          : "badge-pending";
      return `
      <div class="card">
        <div class="card-row">
          <div>
            <div class="card-name">Run #${r.run_id}</div>
            <div class="card-meta">Job ID: ${r.job_id}</div>
          </div>
          <span class="badge ${cls}">${s}</span>
        </div>
      </div>`;
    })
    .join("");
}

// ═══════════════════════════════════════════════════════════════
// NOTEBOOKS
// ═══════════════════════════════════════════════════════════════
async function loadNotebooks(path) {
  currentNbPath = path;
  document.getElementById("nb-path-input").value = path;

  const el = document.getElementById("notebook-list");
  el.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;

  const data = await apiFetch("/notebooks?path=" + encodeURIComponent(path));

  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="empty"><p style="color:var(--accent)">⚠ ${data.error || "Failed to load notebooks"}</p></div>`;
    return;
  }

  if (!data.length) {
    el.innerHTML = `<div class="empty"><div class="icon">☰</div><p>Empty directory</p></div>`;
    return;
  }

  let html = "";

  if (path !== "/") {
    const parent = path.substring(0, path.lastIndexOf("/")) || "/";
    html += `
      <div class="card" style="cursor:pointer" onclick="loadNotebooks('${parent}')">
        <div class="card-row">
          <div class="card-name">← Back</div>
          <span class="badge badge-dir">UP</span>
        </div>
      </div>`;
  }

  html += data
    .map((n) => {
      const isDir = n.type === "DIRECTORY";
      const label = n.path.split("/").pop();
      return `
      <div class="card" style="cursor:pointer"
           onclick="${isDir ? `loadNotebooks('${n.path}')` : `exportNotebook('${n.path}')`}">
        <div class="card-row">
          <div>
            <div class="card-name">${label}</div>
            <div class="card-meta">${n.path}</div>
          </div>
          <span class="badge ${isDir ? "badge-dir" : "badge-notebook"}">
            ${isDir ? "📁 DIR" : "📓 NB"}
          </span>
          ${
            !isDir
              ? `<button class="btn btn-ghost btn-sm"
                       onclick="event.stopPropagation(); exportNotebook('${n.path}')">⬇ Export</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");

  el.innerHTML = html;
}

async function exportNotebook(path) {
  toast(`Exporting ${path.split("/").pop()}...`);
  const res = await apiFetch(
    "/notebooks/export?path=" + encodeURIComponent(path),
  );
  if (res.content) {
    const blob = new Blob([atob(res.content)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() + ".py";
    a.click();
    toast("Notebook exported!", "success");
  } else {
    toast("Export failed: " + (res.error || "Unknown error"));
  }
}

// ═══════════════════════════════════════════════════════════════
// DBFS
// ═══════════════════════════════════════════════════════════════
async function loadDBFS(path) {
  currentDbfsPath = path;
  document.getElementById("dbfs-path-input").value = path;

  const el = document.getElementById("dbfs-list");
  el.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;

  const data = await apiFetch("/dbfs?path=" + encodeURIComponent(path));

  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="empty"><p style="color:var(--accent)">⚠ ${data.error || "Failed to load DBFS"}</p></div>`;
    return;
  }

  if (!data.length) {
    el.innerHTML = `<div class="empty"><div class="icon">◫</div><p>Empty directory</p></div>`;
    return;
  }

  let html = "";

  if (path !== "/") {
    const parent = path.substring(0, path.lastIndexOf("/")) || "/";
    html += `
      <div class="card" style="cursor:pointer" onclick="loadDBFS('${parent}')">
        <div class="card-row">
          <div class="card-name">← Back</div>
          <span class="badge badge-dir">UP</span>
        </div>
      </div>`;
  }

  html += data
    .map((f) => {
      const label = f.path.split("/").pop() || f.path;
      return `
      <div class="card">
        <div class="card-row">
          <div style="cursor:pointer; flex:1"
               onclick="${f.is_dir ? `loadDBFS('${f.path}')` : ""}">
            <div class="card-name">${label}</div>
            <div class="card-meta">${f.is_dir ? "Directory" : formatBytes(f.size)}</div>
          </div>
          <span class="badge ${f.is_dir ? "badge-dir" : "badge-notebook"}">
            ${f.is_dir ? "📁" : "📄"}
          </span>
          ${
            !f.is_dir
              ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent)"
                       onclick="deleteFile('${f.path}')">🗑 Delete</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");

  el.innerHTML = html;
}

async function deleteFile(path) {
  if (!confirm(`Are you sure you want to delete:\n${path}`)) return;
  toast(`Deleting ${path.split("/").pop()}...`);
  const res = await apiDelete("/dbfs/delete?path=" + encodeURIComponent(path));
  if (res.deleted) {
    toast("Deleted successfully", "success");
    loadDBFS(currentDbfsPath);
  } else {
    toast("Delete failed: " + (res.error || "Unknown error"));
  }
}

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;
  toast(`Uploading ${file.name}...`);
  const form = new FormData();
  form.append("file", file);
  form.append("path", currentDbfsPath);
  try {
    await fetch(apiBase() + "/dbfs/upload", {
      method: "POST",
      credentials: "include",
      body: form,
    });
    toast(`${file.name} uploaded!`, "success");
    loadDBFS(currentDbfsPath);
  } catch (e) {
    toast("Upload failed: " + e.message);
  }
  input.value = "";
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
function formatBytes(b) {
  if (!b || b === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
