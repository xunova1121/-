using System.Net.Http;
using System.Net.Http.Json;
using AI.FilmStudio.Models;

namespace AI.FilmStudio.Services;

public sealed class StudioApiClient
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri("http://127.0.0.1:18118/api/v1/") };
    public string? CurrentProjectId { get; private set; }

    public void SelectProject(string projectId) => CurrentProjectId = projectId;

    private string ProjectPath(string suffix)
    {
        if (string.IsNullOrWhiteSpace(CurrentProjectId)) throw new InvalidOperationException("请先创建或选择项目");
        return $"projects/{Uri.EscapeDataString(CurrentProjectId)}/{suffix}";
    }

    public async Task<bool> IsHealthyAsync(CancellationToken token = default)
    {
        try
        {
            var result = await _http.GetFromJsonAsync<HealthResult>("health", token);
            return result?.Status == "ok";
        }
        catch { return false; }
    }

    public async Task<IReadOnlyList<StudioProject>> GetProjectsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<StudioProject>>("projects", token) ?? [];

    public async Task<StudioProject> CreateProjectAsync(string name, string genre, int episodeCount, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync("projects", new { name, genre, episode_count = episodeCount }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<StudioProject>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回项目");
    }

    public async Task<ProjectSummary> GetProjectSummaryAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<ProjectSummary>(ProjectPath("summary"), token) ?? new ProjectSummary();

    public async Task<IReadOnlyList<Shot>> GetShotsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<Shot>>(ProjectPath("shots"), token) ?? [];

    public async Task<ScriptDocument> GetScriptAsync(int episode, CancellationToken token = default) =>
        await _http.GetFromJsonAsync<ScriptDocument>(ProjectPath($"episodes/{episode}/script"), token) ?? new ScriptDocument { Episode = episode };

    public async Task SaveScriptAsync(int episode, string title, string sourceName, string sourceText, CancellationToken token = default)
    {
        var response = await _http.PutAsJsonAsync(ProjectPath($"episodes/{episode}/script"), new { title, source_name = sourceName, source_text = sourceText }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task<ScriptParseResult> ParseScriptAsync(int episode, CancellationToken token = default)
    {
        var response = await _http.PostAsync(ProjectPath($"episodes/{episode}/script/parse"), null, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ScriptParseResult>(cancellationToken: token) ?? new ScriptParseResult();
    }

    public async Task<StoryboardGenerateResult> GenerateStoryboardAsync(int episode, bool replaceExisting = true, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath($"episodes/{episode}/storyboard/generate"), new { replace_existing = replaceExisting }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<StoryboardGenerateResult>(cancellationToken: token) ?? new StoryboardGenerateResult();
    }

    public async Task UpdateShotAsync(Shot shot, CancellationToken token = default)
    {
        var response = await _http.PatchAsJsonAsync($"shots/{shot.Id}", new
        {
            title = shot.Title, description = shot.Description, duration = shot.Duration,
            status = shot.Status, prompt = shot.Prompt, shot_type = shot.ShotType,
            camera = shot.Camera, action = shot.Action, dialogue = shot.Dialogue,
            characters = shot.Characters
        }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task<IReadOnlyList<TaskItem>> GetTasksAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<TaskItem>>(ProjectPath("tasks"), token) ?? [];

    public async Task CreateTaskAsync(string taskType, string provider, string prompt, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("tasks"), new
        {
            task_type = taskType,
            provider,
            priority = 10,
            max_attempts = 3,
            payload = new { prompt, episode = 1 }
        }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task<IReadOnlyList<ProviderConfigStatus>> GetProviderConfigsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<ProviderConfigStatus>>("provider-configs", token) ?? [];

    public async Task SaveProviderConfigAsync(string providerId, string baseUrl, string model, string? apiKey, CancellationToken token = default)
    {
        var response = await _http.PutAsJsonAsync($"provider-configs/{Uri.EscapeDataString(providerId)}", new { base_url = baseUrl, model, api_key = string.IsNullOrWhiteSpace(apiKey) ? null : apiKey }, token);
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

    public async Task<MediaCapabilities> GetMediaCapabilitiesAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<MediaCapabilities>("media/capabilities", token) ?? new MediaCapabilities();

    public async Task<TaskAccepted> QueueTransitionRenderAsync(string leftPath, string rightPath, string method, double duration, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("transition-renders"), new
        {
            left_path = leftPath,
            right_path = rightPath,
            method,
            duration_seconds = duration,
            target_fps = 24,
            width = 1280,
            height = 720,
            preserve_audio = true
        }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    private sealed record HealthResult(string Status);
}
