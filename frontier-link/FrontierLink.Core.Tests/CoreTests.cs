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
