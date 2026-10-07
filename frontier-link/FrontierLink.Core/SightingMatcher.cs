namespace FrontierLink;

public sealed record Place(string Id, string Title, string Category);
public sealed record Mark(string Id, string Title);
public sealed record Prompt(string Kind, string Label, IReadOnlyList<Place> Candidates);
public sealed record SightingResult(IReadOnlyList<Mark> Marks, IReadOnlyList<Prompt> Prompts);

public static class SightingMatcher
{
    public static string Normalize(string? value)
    {
        var chars = (value ?? "").ToLowerInvariant().Select(ch => char.IsLetterOrDigit(ch) ? ch : ' ').ToArray();
        return string.Join(' ', new string(chars).Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    static bool HasPhrase(string text, string phrase)
    {
        if (string.IsNullOrEmpty(phrase)) return false;
        return $" {text} ".Contains($" {phrase} ", StringComparison.Ordinal);
    }

    public static SightingResult Match(string? text, IReadOnlyList<Place> places)
    {
        var normalized = Normalize(text);
        var marks = new List<Mark>();
        var seen = new HashSet<string>();
        foreach (var place in places)
        {
            var title = Normalize(place.Title);
            if (title.Length < 8 || !HasPhrase(normalized, title) || !seen.Add(place.Id)) continue;
            marks.Add(new Mark(place.Id, place.Title));
        }

        var prompts = new List<Prompt>();
        var markedGold = marks.Any(item => Normalize(item.Title).Contains("gold", StringComparison.Ordinal));
        if (!markedGold && HasPhrase(normalized, "gold bar"))
        {
            var candidates = places.Where(place => place.Category == "Gold").Take(8).ToList();
            if (candidates.Count > 0) prompts.Add(new Prompt("gold-bar", "Gold Bar", candidates));
        }

        var markedLegendary = marks.Any(item => Normalize(item.Title).Contains("legendary", StringComparison.Ordinal));
        if (!markedLegendary && HasPhrase(normalized, "legendary pelt"))
        {
            var candidates = places.Where(place => place.Category == "Legendary").Take(8).ToList();
            if (candidates.Count > 0) prompts.Add(new Prompt("legendary-pelt", "Legendary pelt", candidates));
        }

        if (HasPhrase(normalized, "challenge complete"))
            prompts.Add(new Prompt("challenge", "Challenge complete", Array.Empty<Place>()));

        return new SightingResult(marks, prompts);
    }
}
