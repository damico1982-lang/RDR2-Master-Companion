namespace FrontierLink;

public static class PairLink
{
    public static bool TryParse(string? input, out string code, out string host)
    {
        code = "";
        host = "";
        var text = (input ?? "").Trim();
        if (text.Length == 6 && text.All(char.IsDigit))
        {
            code = text;
            return true;
        }
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != "frontier-link") return false;
        var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in query)
        {
            var cut = part.IndexOf('=');
            if (cut <= 0) continue;
            var key = Uri.UnescapeDataString(part[..cut]);
            var value = Uri.UnescapeDataString(part[(cut + 1)..]);
            if (key == "code" && value.Length == 6 && value.All(char.IsDigit)) code = value;
            if (key == "host" && value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) host = value.TrimEnd('/');
        }
        return code.Length == 6;
    }
}
