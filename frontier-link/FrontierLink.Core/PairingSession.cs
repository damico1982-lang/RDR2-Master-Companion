using System.Net;
using System.Net.Http.Json;

namespace FrontierLink;

public static class PairingSession
{
    public const string Waking = "Waking the server...";
    public const string Claiming = "Claiming the pairing code...";
    public const string Paired = "Paired";
    public const string Expired = "That pairing code expired. Tap Show pairing code again.";
    public const string Failed = "Pairing did not finish. Tap Show pairing code again in Frontier Guide.";

    public static async Task<string> WakeAndClaimAsync(
        HttpClient http,
        string baseUrl,
        string code,
        Action<string>? report,
        CancellationToken cancellationToken = default,
        TimeSpan? wakeFor = null,
        TimeSpan? pause = null)
    {
        var root = baseUrl.Trim().TrimEnd('/');
        var budget = wakeFor ?? TimeSpan.FromSeconds(90);
        var delay = pause ?? TimeSpan.FromSeconds(2);
        var deadline = DateTime.UtcNow + budget;
        report?.Invoke(Waking);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await HealthOkAsync(http, root, cancellationToken)) break;
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException(Failed);
            report?.Invoke(Waking);
            await Task.Delay(delay, cancellationToken);
        }

        var backoff = new[] { delay, TimeSpan.FromTicks(delay.Ticks * 2), TimeSpan.FromTicks(delay.Ticks * 4) };
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            report?.Invoke(attempt == 1 ? Claiming : $"{Claiming} Attempt {attempt} of 3.");
            try
            {
                return await ClaimOnceAsync(http, root, code, report, cancellationToken);
            }
            catch (InvalidOperationException ex) when (ex.Message == Expired)
            {
                report?.Invoke(Expired);
                throw;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                if (attempt == 3) break;
                report?.Invoke(Waking);
                await Task.Delay(backoff[attempt - 1], cancellationToken);
            }
        }
        throw new InvalidOperationException(Failed);
    }

    static async Task<bool> HealthOkAsync(HttpClient http, string root, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync($"{root}/api/health", cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    static async Task<string> ClaimOnceAsync(
        HttpClient http,
        string root,
        string code,
        Action<string>? report,
        CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync($"{root}/api/link/claim", new { code }, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new InvalidOperationException(Expired);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken);
        var token = body?.Token ?? "";
        if (token.Length == 0) throw new InvalidOperationException(Failed);
        report?.Invoke(Paired);
        return token;
    }

    sealed record TokenResponse(string? Token);
}
