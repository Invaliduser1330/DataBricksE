# Databricks VS Extension – Team Setup Guide

## Prerequisites

| Tool                       | Version      | Download                                              |
| -------------------------- | ------------ | ----------------------------------------------------- |
| Visual Studio Professional | 2019 or 2022 | visualstudio.microsoft.com                            |
| Python                     | 3.9+         | python.org                                            |
| .NET SDK                   | 6.0+         | dotnet.microsoft.com                                  |
| WebView2 Runtime           | Latest       | developer.microsoft.com/en-us/microsoft-edge/webview2 |

---

## Step 1 – Get Your Databricks Credentials

1. Log in to your **Azure Databricks workspace**
2. Click your **profile icon** (top right) → **Settings** → **Developer**
3. Under **Access Tokens** → click **Generate new token**
4. Set a name (e.g. `vs-extension`) and expiry → click **Generate**
5. **Copy the token** — you won't see it again!
6. Also note your **Workspace URL** (e.g. `https://adb-123456.azuredatabricks.net`)

---

## Step 2 – Set Up the Python Backend

```bash
# 1. Create a project folder
mkdir DatabricksExtension
cd DatabricksExtension
mkdir python_backend frontend

# 2. Create virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# or: source venv/bin/activate  (Mac/Linux)

# 3. Install dependencies
pip install databricks-sdk databricks-connect flask flask-cors
```

### Create `python_backend/server.py`

Copy the full `server.py` code from the earlier section and update:

```python
w = WorkspaceClient(
    host  = "https://YOUR-WORKSPACE.azuredatabricks.net",
    token = "YOUR-PAT-TOKEN"
)
```

### Create all module files

Copy `clusters.py`, `jobs.py`, `dbfs.py`, `notebooks.py` from the earlier section into `python_backend/`.

### Test the backend

```bash
cd python_backend
python server.py
# Should print: * Running on http://127.0.0.1:5050
```

Open your browser and test:

- http://localhost:5050/api/clusters
- http://localhost:5050/api/jobs

---

## Step 3 – Set Up the Frontend

Copy `index.html` into your `frontend/` folder.

The frontend will be served by Flask — add this to `server.py`:

```python
from flask import send_from_directory

@app.route("/")
@app.route("/index.html")
def serve_ui():
    return send_from_directory("../frontend", "index.html")
```

---

## Step 4 – Create the Visual Studio VSIX Extension

### 4a. Install the VSIX SDK

In Visual Studio:

1. **Extensions** → **Manage Extensions**
2. Search for **"Extensibility Essentials 2022"** → Install
3. Restart Visual Studio

### 4b. Create the Project

1. **File** → **New** → **Project**
2. Search for **"VSIX Project"** → Select it → Click **Next**
3. Name it `DatabricksExtension` → Click **Create**

### 4c. Add NuGet Packages

In **Package Manager Console**:

```powershell
Install-Package Microsoft.Web.WebView2
```

### 4d. Add the Tool Window

Right-click the project → **Add** → **New Item** → **Tool Window (Community)**  
Name it `DatabricksToolWindow` → Click **Add**

### 4e. Update `DatabricksToolWindow.cs`

Replace the generated `DatabricksWindowControl` content with:

```csharp
using Microsoft.Web.WebView2.Wpf;
using System.Windows.Controls;

public partial class DatabricksWindowControl : UserControl
{
    private WebView2 _webView;

    public DatabricksWindowControl()
    {
        InitializeComponent();
        Loaded += async (s, e) => await InitWebViewAsync();
    }

    private async Task InitWebViewAsync()
    {
        _webView = new WebView2();
        Content = _webView;
        await _webView.EnsureCoreWebView2Async();
        _webView.Source = new Uri("http://localhost:5050/index.html");
    }
}
```

### 4f. Auto-start Python in `DatabricksPackage.cs`

```csharp
protected override async Task InitializeAsync(CancellationToken ct, IProgress<ServiceProgressData> progress)
{
    await base.InitializeAsync(ct, progress);
    StartPythonBackend();
    await JoinableTaskFactory.SwitchToMainThreadAsync(ct);
}

private Process _pythonProcess;

private void StartPythonBackend()
{
    string scriptPath = Path.Combine(
        Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
        @"python_backend\server.py"
    );

    _pythonProcess = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = "python",
            Arguments = $"\"{scriptPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true
        }
    };
    _pythonProcess.Start();
}

protected override void Dispose(bool disposing)
{
    try { _pythonProcess?.Kill(); } catch { }
    base.Dispose(disposing);
}
```

---

## Step 5 – Bundle Python Files in the VSIX

1. In **Solution Explorer**, right-click the project → **Add** → **Existing Item**
2. Add all `.py` files from `python_backend/` and `index.html`
3. For each file, set **Build Action** = `Content` and **Copy to Output** = `Copy always`

---

## Step 6 – Build & Package

```bash
# In Visual Studio
Build → Build Solution

# Output: bin\Release\DatabricksExtension.vsix
```

---

## Step 7 – Distribute to Your Team

### Option A: Manual Install (small teams)

Share the `.vsix` file and have each team member:

1. Double-click the `.vsix` file
2. Click **Install** in the popup
3. Restart Visual Studio
4. Go to **View** → **Other Windows** → **Databricks Explorer**

### Option B: Private Gallery (recommended for larger teams)

1. Set up a shared folder or internal web server with the `.vsix`
2. In Visual Studio → **Tools** → **Options** → **Environment** → **Extensions**
3. Add your internal gallery URL
4. Team members can install via **Extensions** → **Manage Extensions**

---

## Step 8 – First Launch

When the extension opens for the first time:

1. A **Config popup** will appear automatically
2. Enter your **Workspace URL** and **Personal Access Token**
3. Click **Save & Connect**
4. Clusters will load immediately in the panel

---

## Troubleshooting

| Issue                        | Fix                                                                  |
| ---------------------------- | -------------------------------------------------------------------- |
| "Failed to load" on all tabs | Check Python server is running on port 5050                          |
| WebView2 blank screen        | Install WebView2 Runtime from Microsoft                              |
| Python not found             | Add Python to System PATH or use full path in `StartPythonBackend()` |
| Token expired                | Generate a new PAT and update via ⚙ Config button                    |
| Port conflict                | Change port in Config to 5051 or 5052, update server.py to match     |

---

## Security Best Practices

- **Never commit** your PAT token to source control
- Use **Azure Key Vault** to store tokens in production
- Set token **expiry dates** and rotate regularly
- Consider using **Azure AD authentication** instead of PAT for enterprise teams

---

## Feature Summary

| Feature             | Shortcut / Action                  |
| ------------------- | ---------------------------------- |
| View all clusters   | Clusters tab → loads automatically |
| Start a cluster     | Clusters tab → ▶ Start button      |
| Stop a cluster      | Clusters tab → ■ Stop button       |
| Run a job           | Jobs tab → ▶ Run Now               |
| View job history    | Runs tab                           |
| Browse notebooks    | Notebooks tab → click folders      |
| Export notebook     | Notebooks tab → ⬇ Export           |
| Browse DBFS         | DBFS tab → click folders           |
| Upload file to DBFS | DBFS tab → ⬆ Upload                |
| Delete DBFS file    | DBFS tab → 🗑 button               |
| Change workspace    | ⚙ Config button (top right)        |
| Refresh any tab     | ↻ Refresh button                   |
