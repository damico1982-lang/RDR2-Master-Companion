namespace FrontierLink;

public static class CapturePolicy
{
    public static bool IsGameWindow(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return false;
        var trimmed = title.Trim();
        if (trimmed.Contains("Frontier Link", StringComparison.OrdinalIgnoreCase)) return false;
        return trimmed.Equals("Red Dead Redemption 2", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("Red Dead Redemption 2 ", StringComparison.OrdinalIgnoreCase);
    }
}
