using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace FrontierLink;

public sealed class LinkClient
{
    readonly HttpClient _http;
    readonly string _baseUrl;

    public LinkClient(HttpClient http, string baseUrl)
    {
        _http = http;
        _baseUrl = baseUrl.TrimEnd('/');
    }

    public async Task<string> ClaimAsync(string code, CancellationToken cancellationToken = default)
    {
        var response = await _http.PostAsJsonAsync($"{_baseUrl}/api/link/claim", new { code }, cancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken);
        return body?.Token ?? "";
    }

    public async Task PostFrameAsync(string token, string imageDataUrl, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/link/frame");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = JsonContent.Create(new { imageDataUrl, capturedAt = DateTime.UtcNow.ToString("o") });
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public async Task PostSightingsAsync(string token, SightingResult result, CancellationToken cancellationToken = default)
    {
        if (result.Marks.Count == 0 && result.Prompts.Count == 0) return;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/link/sightings");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = JsonContent.Create(new
        {
            marks = result.Marks.Select(item => new { id = item.Id, title = item.Title }),
            prompts = result.Prompts.Select(item => new
            {
                kind = item.Kind,
                label = item.Label,
                candidates = item.Candidates.Select(place => new { id = place.Id, title = place.Title })
            })
        });
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    sealed record TokenResponse(string Token);
}
