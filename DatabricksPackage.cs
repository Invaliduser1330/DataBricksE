[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[ProvideMenuResource("Menus.ctmenu", 1)]
[ProvideToolWindow(typeof(DatabricksToolWindow))]
[Guid(PackageGuidString)]
public sealed class DatabricksPackage : AsyncPackage
{
    public const string PackageGuidString = "your-guid-here";
    private Process _pythonProcess;

    protected override async Task InitializeAsync(CancellationToken ct, IProgress<ServiceProgressData> progress)
    {
        await base.InitializeAsync(ct, progress);
        StartPythonServer();  // Launch Flask backend on load
        await JoinableTaskFactory.SwitchToMainThreadAsync(ct);
        await ShowDatabricksWindowCommand.InitializeAsync(this);
    }

    private void StartPythonServer()
    {
        _pythonProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "python",
                Arguments = @"path\to\python_backend\server.py",
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        _pythonProcess.Start();
    }

    protected override void Dispose(bool disposing)
    {
        _pythonProcess?.Kill();  // Stop server when VS closes
        base.Dispose(disposing);
    }
}