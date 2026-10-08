namespace FrontierLink;

public static class CaptureWindow
{
    public const string Waiting = "Waiting for the RDR2 window, keep it open and not minimized";
    public const string BlackFrame = "The RDR2 window came back black. Switch the game to borderless windowed and leave it open.";

    public static string? Describe(bool found, bool minimized, int width, int height)
    {
        if (!found || minimized || width <= 0 || height <= 0) return Waiting;
        return null;
    }

    public static bool IsMostlyBlack(ReadOnlySpan<byte> luminances)
    {
        if (luminances.IsEmpty) return true;
        var dark = 0;
        foreach (var value in luminances)
        {
            if (value < 12) dark++;
        }
        return dark * 100 >= luminances.Length * 98;
    }
}
