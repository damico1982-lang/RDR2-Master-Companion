namespace FrontierLink;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "FrontierLink.1.7.0", out var created);
        if (!created) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
