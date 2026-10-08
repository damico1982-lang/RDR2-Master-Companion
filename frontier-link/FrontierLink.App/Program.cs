namespace FrontierLink;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        if (args.Length >= 2 && args[0] == "--screenshots")
        {
            try
            {
                MainForm.ScreenshotMode = true;
                ApplicationConfiguration.Initialize();
                using var form = new MainForm();
                form.Show();
                Application.DoEvents();
                form.SaveShots(args[1]);
            }
            catch (Exception error)
            {
                Directory.CreateDirectory(args[1]);
                File.WriteAllText(Path.Combine(args[1], "capture-error.txt"), error.ToString());
            }
            return;
        }
        using var mutex = new Mutex(true, "FrontierLink.1.7.6", out var created);
        if (!created) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
