"""
server.py  –  Databricks VS Extension Backend
Supports two OAuth flows:
  1. Service Principal  (client credentials – recommended for teams)
  2. Interactive Login  (Azure AD Authorization Code + PKCE – per-user login)
"""

import os
import secrets
import threading
import webbrowser
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from flask import Flask, jsonify, request, session, redirect, send_from_directory
from flask_cors import CORS
from databricks.sdk import WorkspaceClient
from databricks.sdk.config import Config

import clusters as clusters_mod
import jobs     as jobs_mod
import dbfs     as dbfs_mod
import notebooks as notebooks_mod

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)   # session encryption key
CORS(app, supports_credentials=True)

# ── Azure AD OAuth constants ───────────────────────────────────────────────
DATABRICKS_SCOPE  = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default"
REDIRECT_URI      = "http://localhost:5050/oauth/callback"

# ── In-memory state ────────────────────────────────────────────────────────
_oauth_states: dict[str, dict] = {}   # state_token -> { status, token, user }
_workspace_client: WorkspaceClient | None = None

# ═══════════════════════════════════════════════════════════════════════════
# STATIC FILES (serve frontend)
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/")
@app.route("/index.html")
def serve_ui():
    return send_from_directory("../frontend", "index.html")

@app.route("/<path:filename>")
def serve_static(filename):
    return send_from_directory("../frontend", filename)

# ═══════════════════════════════════════════════════════════════════════════
# AUTH STATUS
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/auth/status")
def auth_status():
    if "authenticated" in session and session["authenticated"]:
        return jsonify({
            "authenticated": True,
            "user_name":     session.get("user_name", "User"),
            "user_email":    session.get("user_email", ""),
            "auth_mode":     session.get("auth_mode", "unknown")
        })
    return jsonify({"authenticated": False})

# ═══════════════════════════════════════════════════════════════════════════
# SERVICE PRINCIPAL — CLIENT CREDENTIALS FLOW
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/auth/sp/connect", methods=["POST"])
def sp_connect():
    global _workspace_client
    data          = request.json
    host          = data.get("host", "").rstrip("/")
    tenant_id     = data.get("tenant_id")
    client_id     = data.get("client_id")
    client_secret = data.get("client_secret")

    if not all([host, tenant_id, client_id, client_secret]):
        return jsonify({"error": "Missing required fields"}), 400

    # Acquire token via client credentials
    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    token_res = requests.post(token_url, data={
        "grant_type":    "client_credentials",
        "client_id":     client_id,
        "client_secret": client_secret,
        "scope":         DATABRICKS_SCOPE
    })

    if not token_res.ok:
        err = token_res.json().get("error_description", "Token request failed")
        return jsonify({"error": err}), 401

    access_token = token_res.json()["access_token"]

    # Build Databricks client with the OAuth token
    try:
        cfg = Config(
            host  = host,
            token = access_token   # SDK accepts bearer tokens directly
        )
        _workspace_client = WorkspaceClient(config=cfg)

        # Test connection
        me = _workspace_client.current_user.me()

        session["authenticated"] = True
        session["auth_mode"]     = "service_principal"
        session["user_name"]     = me.display_name or client_id
        session["user_email"]    = me.emails[0].value if me.emails else ""
        session["access_token"]  = access_token
        session["host"]          = host

        return jsonify({
            "authenticated": True,
            "user_name":     session["user_name"],
            "user_email":    session["user_email"]
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ═══════════════════════════════════════════════════════════════════════════
# INTERACTIVE LOGIN — AUTHORIZATION CODE + PKCE
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/auth/oauth/start", methods=["POST"])
def oauth_start():
    data      = request.json
    host      = data.get("host", "").rstrip("/")
    tenant_id = data.get("tenant_id")

    if not host or not tenant_id:
        return jsonify({"error": "host and tenant_id are required"}), 400

    # Generate PKCE code verifier + challenge
    import base64, hashlib
    code_verifier  = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()

    state = secrets.token_urlsafe(16)

    # Store state for polling & callback
    _oauth_states[state] = {
        "status":        "pending",
        "host":          host,
        "tenant_id":     tenant_id,
        "code_verifier": code_verifier,
    }

    # Register a temporary client_id (Azure AD public client)
    # Teams should register their own App Registration in Azure AD
    # and set DATABRICKS_CLIENT_ID in the environment
    client_id = os.environ.get("DATABRICKS_CLIENT_ID", "04b07795-8ddb-461a-bbee-02f9e1bf7b46")
    # ☝ the default is the Azure CLI public client ID — works for testing

    auth_url = (
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize?"
        + urlencode({
            "client_id":             client_id,
            "response_type":         "code",
            "redirect_uri":          REDIRECT_URI,
            "scope":                 f"{DATABRICKS_SCOPE} openid profile email offline_access",
            "state":                 state,
            "code_challenge":        code_challenge,
            "code_challenge_method": "S256"
        })
    )

    _oauth_states[state]["client_id"] = client_id
    return jsonify({"auth_url": auth_url, "state": state})

# OAuth callback — Azure redirects here after login
@app.route("/oauth/callback")
def oauth_callback():
    code     = request.args.get("code")
    state    = request.args.get("state")
    error    = request.args.get("error")

    if error or not state or state not in _oauth_states:
        return "<h2>Authentication failed. You can close this window.</h2>", 400

    info = _oauth_states[state]

    if error:
        _oauth_states[state]["status"] = "error"
        return f"<h2>Error: {error}. You can close this window.</h2>", 400

    # Exchange code for token
    token_url = f"https://login.microsoftonline.com/{info['tenant_id']}/oauth2/v2.0/token"
    token_res = requests.post(token_url, data={
        "grant_type":    "authorization_code",
        "client_id":     info["client_id"],
        "code":          code,
        "redirect_uri":  REDIRECT_URI,
        "code_verifier": info["code_verifier"],
        "scope":         f"{DATABRICKS_SCOPE} openid profile email offline_access"
    })

    if not token_res.ok:
        _oauth_states[state]["status"] = "error"
        return "<h2>Token exchange failed. You can close this window.</h2>", 400

    tokens       = token_res.json()
    access_token = tokens["access_token"]

    # Get user info from id_token claims
    import jwt as pyjwt
    user_name  = "User"
    user_email = ""
    try:
        id_claims  = pyjwt.decode(tokens["id_token"], options={"verify_signature": False})
        user_name  = id_claims.get("name", id_claims.get("upn", "User"))
        user_email = id_claims.get("upn", id_claims.get("email", ""))
    except Exception:
        pass

    # Build Databricks client
    global _workspace_client
    try:
        cfg = Config(host=info["host"], token=access_token)
        _workspace_client = WorkspaceClient(config=cfg)
    except Exception as e:
        _oauth_states[state]["status"] = "error"
        return f"<h2>Databricks connection failed: {e}. You can close this window.</h2>", 500

    _oauth_states[state].update({
        "status":       "authenticated",
        "access_token": access_token,
        "user_name":    user_name,
        "user_email":   user_email
    })

    return """
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0c0e14;color:#e8eaf0">
      <h2>✅ Signed in successfully!</h2>
      <p>You can close this window and return to Visual Studio.</p>
      <script>setTimeout(() => window.close(), 2000);</script>
    </body></html>
    """

# Polling endpoint — frontend polls this until auth completes
@app.route("/api/auth/oauth/status")
def oauth_status():
    state = request.args.get("state")
    if not state or state not in _oauth_states:
        return jsonify({"authenticated": False, "error": "Invalid state"})

    info = _oauth_states[state]

    if info["status"] == "authenticated":
        # Migrate to session
        session["authenticated"] = True
        session["auth_mode"]     = "interactive"
        session["user_name"]     = info["user_name"]
        session["user_email"]    = info["user_email"]
        session["access_token"]  = info["access_token"]
        session["host"]          = info["host"]

        del _oauth_states[state]   # clean up

        return jsonify({
            "authenticated": True,
            "user_name":     session["user_name"],
            "user_email":    session["user_email"]
        })

    if info["status"] == "error":
        del _oauth_states[state]
        return jsonify({"authenticated": False, "error": "Authentication failed"})

    return jsonify({"authenticated": False, "status": "pending"})

@app.route("/api/auth/oauth/cancel", methods=["POST"])
def oauth_cancel():
    # Clean up any pending states
    to_delete = [k for k, v in _oauth_states.items() if v.get("status") == "pending"]
    for k in to_delete:
        del _oauth_states[k]
    return jsonify({"cancelled": True})

# ═══════════════════════════════════════════════════════════════════════════
# LOGOUT
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/auth/logout", methods=["POST"])
def logout():
    global _workspace_client
    session.clear()
    _workspace_client = None
    return jsonify({"logged_out": True})

# ═══════════════════════════════════════════════════════════════════════════
# AUTH GUARD HELPER
# ═══════════════════════════════════════════════════════════════════════════
def get_client():
    """Returns the WorkspaceClient or raises 401."""
    if not session.get("authenticated") or _workspace_client is None:
        return None
    return _workspace_client

# ═══════════════════════════════════════════════════════════════════════════
# CLUSTERS
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/clusters")
def get_clusters():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(clusters_mod.list_clusters(w))

@app.route("/api/clusters/<cluster_id>/start", methods=["POST"])
def start_cluster(cluster_id):
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(clusters_mod.start_cluster(w, cluster_id))

@app.route("/api/clusters/<cluster_id>/stop", methods=["POST"])
def stop_cluster(cluster_id):
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(clusters_mod.stop_cluster(w, cluster_id))

# ═══════════════════════════════════════════════════════════════════════════
# JOBS
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/jobs")
def get_jobs():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(jobs_mod.list_jobs(w))

@app.route("/api/jobs/<job_id>/run", methods=["POST"])
def run_job(job_id):
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(jobs_mod.run_job(w, job_id))

@app.route("/api/jobs/runs")
def get_runs():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(jobs_mod.list_runs(w))

# ═══════════════════════════════════════════════════════════════════════════
# DBFS
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/dbfs")
def browse_dbfs():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    path = request.args.get("path", "/")
    return jsonify(dbfs_mod.list_files(w, path))

@app.route("/api/dbfs/upload", methods=["POST"])
def upload_file():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    return jsonify(dbfs_mod.upload_file(w, request))

@app.route("/api/dbfs/delete", methods=["DELETE"])
def delete_file():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    path = request.args.get("path")
    return jsonify(dbfs_mod.delete_file(w, path))

# ═══════════════════════════════════════════════════════════════════════════
# NOTEBOOKS
# ═══════════════════════════════════════════════════════════════════════════
@app.route("/api/notebooks")
def get_notebooks():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    path = request.args.get("path", "/")
    return jsonify(notebooks_mod.list_notebooks(w, path))

@app.route("/api/notebooks/export")
def export_notebook():
    w = get_client()
    if not w: return jsonify({"error": "Not authenticated"}), 401
    path = request.args.get("path")
    return jsonify(notebooks_mod.export_notebook(w, path))

# ═══════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app.run(port=5050, debug=False)
