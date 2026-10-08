using System.Net;
using FrontierLink;
using Xunit;

namespace FrontierLink.Core.Tests;

public class CoreTests
{
    static readonly Place[] Places =
    [
        new("horse-white-arabian", "White Arabian", "Horse"),
        new("leg-bull-gator", "Legendary Bull Gator", "Legendary"),
        new("gold-limpany", "Limpany gold bar", "Gold"),
        new("gold-braithwaite", "Braithwaite Manor gold", "Gold")
    ];

    [Fact]
    public void Capture_allows_only_the_red_dead_window()
    {
        Assert.True(CapturePolicy.IsGameWindow("Red Dead Redemption 2"));
        Assert.True(CapturePolicy.IsGameWindow("Red Dead Redemption 2 - Steam"));
        Assert.False(CapturePolicy.IsGameWindow("Frontier Link"));
        Assert.False(CapturePolicy.IsGameWindow("Red Dead Redemption"));
        Assert.False(CapturePolicy.IsGameWindow("Chrome"));
        Assert.False(CapturePolicy.IsGameWindow(""));
    }

    [Fact]
    public void Named_pickup_marks_one_place_and_a_gold_bar_asks()
    {
        var named = SightingMatcher.Match("Legendary Bull Gator pelt added", Places);
        Assert.Equal("leg-bull-gator", Assert.Single(named.Marks).Id);
        Assert.Empty(named.Prompts);

        var generic = SightingMatcher.Match("You received a Gold Bar", Places);
        Assert.Empty(generic.Marks);
        var prompt = Assert.Single(generic.Prompts);
        Assert.Equal("gold-bar", prompt.Kind);
        Assert.Equal(new[] { "gold-limpany", "gold-braithwaite" }, prompt.Candidates.Select(item => item.Id));

        var challenge = SightingMatcher.Match("Challenge Complete", Places);
        Assert.Contains(challenge.Prompts, item => item.Kind == "challenge");
    }

    [Fact]
    public void Pair_text_accepts_a_code_or_a_link()
    {
        Assert.True(PairLink.TryParse("482913", out var code, out var host));
        Assert.Equal("482913", code);
        Assert.Equal("", host);
        Assert.True(PairLink.TryParse("frontier-link://pair?code=123456&host=https%3A%2F%2Ffrontier-guide-api.onrender.com", out code, out host));
        Assert.Equal("123456", code);
        Assert.Equal("https://frontier-guide-api.onrender.com", host);
        Assert.False(PairLink.TryParse("not a code", out _, out _));
    }

    [Fact]
    public async Task Client_claims_and_posts_a_frame()
    {
        var handler = new StubHandler();
        var client = new LinkClient(new HttpClient(handler), "https://example.test");
        var token = await client.ClaimAsync("123456");
        Assert.Equal("helper-token", token);
        await client.PostFrameAsync(token, "data:image/jpeg;base64,aaaa");
        Assert.Equal("https://example.test/api/link/claim", handler.Calls[0].RequestUri?.ToString());
        Assert.Equal("Bearer helper-token", handler.Calls[1].Headers.Authorization?.ToString());
        Assert.Contains("/api/link/frame", handler.Calls[1].RequestUri?.ToString());
    }

    [Fact]
    public void Missing_minimized_and_zero_size_windows_are_skipped()
    {
        Assert.Equal(CaptureWindow.Waiting, CaptureWindow.Describe(found: false, minimized: false, width: 1920, height: 1080));
        Assert.Equal(CaptureWindow.Waiting, CaptureWindow.Describe(found: true, minimized: true, width: 1920, height: 1080));
        Assert.Equal(CaptureWindow.Waiting, CaptureWindow.Describe(found: true, minimized: false, width: 0, height: 0));
        Assert.Equal(CaptureWindow.Waiting, CaptureWindow.Describe(found: true, minimized: false, width: -32000, height: 40));
        Assert.Null(CaptureWindow.Describe(found: true, minimized: false, width: 1920, height: 1080));
    }

    [Fact]
    public void An_all_black_frame_is_detected()
    {
        Assert.True(CaptureWindow.IsMostlyBlack(new byte[64]));
        var mixed = new byte[64];
        mixed[0] = 180;
        mixed[1] = 180;
        Assert.False(CaptureWindow.IsMostlyBlack(mixed));
    }

    [Fact]
    public async Task Slow_first_response_still_pairs()
    {
        var handler = new ScriptedHandler(async (request, cancellationToken) =>
        {
            if (request.RequestUri?.AbsolutePath.EndsWith("/health") == true)
            {
                await Task.Delay(TimeSpan.FromSeconds(40), cancellationToken);
                return Json(HttpStatusCode.OK, """{"ok":true}""");
            }
            return Json(HttpStatusCode.OK, """{"token":"helper-token"}""");
        });
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
        var notes = new List<string>();
        var token = await PairingSession.WakeAndClaimAsync(http, "https://example.test", "123456", notes.Add, pause: TimeSpan.FromMilliseconds(1));
        Assert.Equal("helper-token", token);
        Assert.Contains(PairingSession.Waking, notes);
        Assert.Contains(PairingSession.Paired, notes);
        Assert.EndsWith("/api/health", handler.Paths[0]);
        Assert.EndsWith("/api/link/claim", handler.Paths[1]);
    }

    [Fact]
    public async Task Wake_retries_and_an_expired_code_says_to_show_it_again()
    {
        var health = 0;
        var handler = new ScriptedHandler((request, _) =>
        {
            if (request.RequestUri?.AbsolutePath.EndsWith("/health") == true)
            {
                health++;
                return Task.FromResult(Json(health < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK, """{"ok":false}"""));
            }
            return Task.FromResult(Json(HttpStatusCode.NotFound, """{"error":"gone"}"""));
        });
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
        var notes = new List<string>();
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PairingSession.WakeAndClaimAsync(http, "https://example.test", "123456", notes.Add, pause: TimeSpan.FromMilliseconds(1)));
        Assert.Equal(PairingSession.Expired, error.Message);
        Assert.Contains(PairingSession.Waking, notes);
        Assert.DoesNotContain(notes, note => note.Contains("HttpClient", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(notes, note => note.Contains("Parameter is not valid", StringComparison.Ordinal));
    }

    static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json")
    };

    sealed class ScriptedHandler : HttpMessageHandler
    {
        readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _next;
        public List<string> Paths { get; } = [];
        public ScriptedHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> next) => _next = next;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Paths.Add(request.RequestUri?.AbsolutePath ?? "");
            return _next(request, cancellationToken);
        }
    }

    sealed class StubHandler : HttpMessageHandler
    {
        public List<HttpRequestMessage> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add(request);
            var json = request.RequestUri?.AbsolutePath.EndsWith("/claim") == true
                ? """{"token":"helper-token"}"""
                : """{"ok":true}""";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json")
            });
        }
    }
}
