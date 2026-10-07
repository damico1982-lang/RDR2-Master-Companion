using System.Reflection;
using System.Text.Json;

namespace FrontierLink;

sealed class MainForm : Form
{
    readonly TextBox _server = new() { Text = "https://frontier-guide-api.onrender.com", Width = 360 };
    readonly TextBox _code = new() { Width = 160 };
    readonly Button _pair = new() { Text = "Pair", AutoSize = true };
    readonly CheckBox _capture = new() { Text = "Capture the Red Dead Redemption 2 window", AutoSize = true };
    readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(420, 0), Text = "Capture is off." };
    readonly NotifyIcon _tray = new() { Visible = true, Text = "Frontier Link — capture off" };
    readonly System.Windows.Forms.Timer _timer = new() { Interval = 4000 };
    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };
    readonly IReadOnlyList<Place> _places;
    string _token = "";
    int _busy;

    public MainForm()
    {
        Text = "Frontier Link 1.7.0";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 280);
        _places = LoadCatalog();
        var privacy = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(430, 0),
            Text = "Frontier Link captures only the Red Dead Redemption 2 window, and only while the switch below is on. Frames go to your paired Frontier Guide for Live Coach. Pickup text is read on this PC. Nothing else is captured. This program does not read game memory or inject code."
        };
        var serverLabel = new Label { AutoSize = true, Text = "Frontier Guide server" };
        var codeLabel = new Label { AutoSize = true, Text = "6-digit code or frontier-link link" };
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(16), AutoScroll = true };
        layout.Controls.AddRange([privacy, serverLabel, _server, codeLabel, _code, _pair, _capture, _status]);
        Controls.Add(layout);
        _pair.Click += async (_, _) => await PairAsync();
        _capture.CheckedChanged += (_, _) =>
        {
            _tray.Text = _capture.Checked ? "Frontier Link — capture on" : "Frontier Link — capture off";
            _status.Text = _capture.Checked
                ? "Capture is on. Only the Red Dead Redemption 2 window is used."
                : "Capture is off.";
        };
        _timer.Tick += async (_, _) => await TickAsync();
        _timer.Start();
        _tray.Icon = SystemIcons.Application;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show", null, (_, _) => ShowForm());
        menu.Items.Add("Capture on/off", null, (_, _) => _capture.Checked = !_capture.Checked);
        menu.Items.Add("Exit", null, (_, _) => ExitApp());
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => ShowForm();
        FormClosing += (_, args) =>
        {
            if (args.CloseReason == CloseReason.UserClosing)
            {
                args.Cancel = true;
                Hide();
            }
        };
    }

    static IReadOnlyList<Place> LoadCatalog()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FrontierLink.catalog.json");
        if (stream == null) return Array.Empty<Place>();
        var places = JsonSerializer.Deserialize<List<CatalogPlace>>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        return places?.Select(item => new Place(item.Id ?? "", item.Title ?? "", item.Category ?? "")).Where(item => item.Id.Length > 0).ToArray()
            ?? Array.Empty<Place>();
    }

    async Task PairAsync()
    {
        if (!PairLink.TryParse(_code.Text, out var code, out var host))
        {
            _status.Text = "Enter the 6-digit code from Frontier Guide.";
            return;
        }
        if (host.Length > 0) _server.Text = host;
        var baseUrl = _server.Text.Trim().TrimEnd('/');
        if (!baseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            _status.Text = "The server URL must be https.";
            return;
        }
        try
        {
            _pair.Enabled = false;
            var client = new LinkClient(_http, baseUrl);
            _token = await client.ClaimAsync(code);
            _status.Text = _token.Length > 0
                ? "Paired. Leave capture off until you want the RDR2 window sent to Live Coach."
                : "Pairing did not return a token.";
        }
        catch (Exception error)
        {
            _status.Text = "Pairing failed. Check the code and the server. " + error.Message;
        }
        finally
        {
            _pair.Enabled = true;
        }
    }

    async Task TickAsync()
    {
        if (!_capture.Checked || _token.Length == 0 || Interlocked.Exchange(ref _busy, 1) == 1) return;
        try
        {
            var hwnd = WindowCapture.FindGameWindow();
            if (hwnd == IntPtr.Zero)
            {
                _status.Text = "Capture is on. Red Dead Redemption 2 is not the open window, so nothing was captured.";
                return;
            }
            using var bitmap = WindowCapture.CopyWindow(hwnd);
            if (bitmap == null)
            {
                _status.Text = "The Red Dead window could not be copied. Nothing else was captured.";
                return;
            }
            var client = new LinkClient(_http, _server.Text.Trim());
            var frame = WindowCapture.ToJpegDataUrl(bitmap);
            await client.PostFrameAsync(_token, frame);
            var text = "";
            try { text = await GameOcr.ReadAsync(bitmap); }
            catch { text = ""; }
            var sightings = SightingMatcher.Match(text, _places);
            await client.PostSightingsAsync(_token, sightings);
            _status.Text = sightings.Marks.Count > 0
                ? $"Sent one RDR2 frame. Marked {sightings.Marks[0].Title}."
                : "Sent one RDR2 frame to Frontier Guide.";
        }
        catch (Exception error)
        {
            _status.Text = "The frame was not sent. " + error.Message;
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    void ShowForm()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    void ExitApp()
    {
        _timer.Stop();
        _capture.Checked = false;
        _tray.Visible = false;
        _tray.Dispose();
        Application.Exit();
    }

    sealed class CatalogPlace
    {
        public string? Id { get; set; }
        public string? Title { get; set; }
        public string? Category { get; set; }
    }
}
