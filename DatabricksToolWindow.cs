[Guid("your-window-guid")]
public class DatabricksToolWindow : ToolWindowPane
{
    public DatabricksToolWindow() : base(null)
    {
        Caption = "Databricks Explorer";
        Content = new DatabricksWindowControl();
    }
}

public partial class DatabricksWindowControl : UserControl
{
    private WebView2 _webView;

    public DatabricksWindowControl()
    {
        InitializeComponent();
        InitWebView();
    }

    private async void InitWebView()
    {
        _webView = new WebView2();
        this.Content = _webView;
        await _webView.EnsureCoreWebView2Async();

        // Load your frontend UI (talks to Flask on port 5050)
        _webView.Source = new Uri("http://localhost:5050/index.html");
    }
}