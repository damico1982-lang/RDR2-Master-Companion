using System.Reflection;
using System.Text.Json;

namespace FrontierLink;

sealed class MainForm : Form
{
    readonly TextBox _server = new() { Text = "https://frontier-guide-api.onrender.com", Width = 360 };
    readonly TextBox _code = new() { Width = 160 };
    readonly Button _pair = new() { Text = "Pair", AutoSize = true };
    readonly CheckBox _capture = new() { Text = "Capture the Red Dead Redemption 2 window", AutoSize = true };
    readonly Label _paired = new() { AutoSize = true, Font = new Font(FontFamily.GenericSansSerif, 9f, FontStyle.Bold), Text = "" };
    readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(420, 0), Text = "Capture is off." };
    readonly NotifyIcon _tray = new() { Visible = true, Text = "Frontier Link — capture off" };
    readonly System.Windows.Forms.Timer _timer = new() { Interval = 4000 };
    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    readonly IReadOnlyList<Place> _places;
    string _token = "";
    int _busy;
    internal static bool ScreenshotMode;

    public MainForm()
    {
        Text = "Frontier Link 1.7.6";
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
        layout.Controls.AddRange([privacy, serverLabel, _server, codeLabel, _code, _pair, _capture, _paired, _status]);
        Controls.Add(layout);
        _pair.Click += async (_, _) => await PairAsync();
        _capture.CheckedChanged += (_, _) =>
        {
            _tray.Text = _capture.Checked ? "Frontier Link — capture on" : "Frontier Link — capture off";
            if (_paired.Text.Length == 0)
            {
                _status.Text = _capture.Checked
                    ? "Capture is on. Only the Red Dead Redemption 2 window is used."
                    : "Capture is off.";
            }
            else if (!_capture.Checked)
            {
                _status.Text = "Paired. Capture is off until you turn it on.";
            }
            else
            {
                _status.Text = "Paired. Capture is on. Only the Red Dead Redemption 2 window is used.";
            }
        };
        _timer.Tick += async (_, _) => await TickAsync();
        if (!ScreenshotMode) _timer.Start();
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
            _token = await PairingSession.WakeAndClaimAsync(_http, baseUrl, code, note => _status.Text = note);
            _paired.Text = PairingSession.Paired;
            _status.Text = "Paired. Leave capture off until you want the RDR2 window sent to Live Coach.";
        }
        catch (InvalidOperationException error) when (error.Message == PairingSession.Expired || error.Message == PairingSession.Failed)
        {
            _status.Text = error.Message;
        }
        catch
        {
            _status.Text = PairingSession.Failed;
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
            var window = WindowCapture.FindGameWindow();
            var skip = CaptureWindow.Describe(window.Found, window.Minimized, window.Width, window.Height);
            if (skip != null)
            {
                _status.Text = skip;
                return;
            }
            var copied = WindowCapture.CopyWindow(window.Handle);
            if (copied.Black)
            {
                _status.Text = CaptureWindow.BlackFrame;
                return;
            }
            using var bitmap = copied.Image;
            if (bitmap == null)
            {
                _status.Text = CaptureWindow.Waiting;
                return;
            }
            var client = new LinkClient(_http, _server.Text.Trim());
            var frame = WindowCapture.ToJpegDataUrl(bitmap);
            if (frame.Length == 0)
            {
                _status.Text = CaptureWindow.Waiting;
                return;
            }
            await client.PostFrameAsync(_token, frame);
            var text = "";
            try { text = await GameOcr.ReadAsync(bitmap); }
            catch { text = ""; }
            var sightings = SightingMatcher.Match(text, _places);
            await client.PostSightingsAsync(_token, sightings);
            _status.Text = sightings.Marks.Count > 0
                ? $"Paired. Sent one RDR2 frame. Marked {sightings.Marks[0].Title}."
                : "Paired. Sent one RDR2 frame to Frontier Guide.";
        }
        catch
        {
            _status.Text = "The frame was not sent. Leave Red Dead Redemption 2 open and not minimized.";
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    internal void SaveShots(string directory)
    {
        Directory.CreateDirectory(directory);
        var handle = Handle;
        PerformLayout();
        Refresh();
        _status.Text = PairingSession.Waking;
        WriteShot(directory, "frontierlink-waking-1.7.6.png");
        _paired.Text = PairingSession.Paired;
        _status.Text = "Paired. Leave capture off until you want the RDR2 window sent to Live Coach.";
        WriteShot(directory, "frontierlink-paired-1.7.6.png");
        _capture.Checked = true;
        _status.Text = "Paired. Capture is on. Only the Red Dead Redemption 2 window is used.";
        WriteShot(directory, "frontierlink-capture-on-1.7.6.png");
        _ = handle;
    }

    void WriteShot(string directory, string name)
    {
        var width = Math.Max(1, ClientSize.Width);
        var height = Math.Max(1, ClientSize.Height);
        using var bitmap = new Bitmap(width, height);
        DrawToBitmap(bitmap, new Rectangle(0, 0, width, height));
        bitmap.Save(Path.Combine(directory, name), System.Drawing.Imaging.ImageFormat.Png);
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
