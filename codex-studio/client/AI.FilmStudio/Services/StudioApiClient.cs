using System.Net.Http;
using System.Net.Http.Json;
using AI.FilmStudio.Models;

namespace AI.FilmStudio.Services;

public sealed class StudioApiClient
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri("http://127.0.0.1:18118/api/v1/") };

    public async Task<bool> IsHealthyAsync(CancellationToken token = default)
    {
        try
        {
            var result = await _http.GetFromJsonAsync<HealthResult>("health", token);
            return result?.Status == "ok";
        }
        catch { return false; }
    }

    public async Task<IReadOnlyList<Shot>> GetShotsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<Shot>>("projects/demo/shots", token) ?? [];

    public async Task<IReadOnlyList<TaskItem>> GetTasksAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<TaskItem>>("projects/demo/tasks", token) ?? [];

    public async Task CreateDemoTaskAsync(string taskType, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync("projects/demo/tasks", new
        {
            task_type = taskType,
            provider = "mock",
            priority = 10,
            max_attempts = 3,
            payload = new { prompt = $"为雪山剑客执行 {taskType} 生成", episode = 1 }
        }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task CancelTaskAsync(int taskId, CancellationToken token = default)
    {
        var response = await _http.PostAsync($"tasks/{taskId}/cancel", null, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task RetryTaskAsync(int taskId, CancellationToken token = default)
    {
        var response = await _http.PostAsync($"tasks/{taskId}/retry", null, token);
        response.EnsureSuccessStatusCode();
    }

    private sealed record HealthResult(string Status);
}
