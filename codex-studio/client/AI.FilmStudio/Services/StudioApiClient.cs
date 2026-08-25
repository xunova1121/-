using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
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

    public async Task<IReadOnlyList<Shot>> GetShotsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<Shot>>(ProjectPath("shots"), token) ?? [];

    public async Task<Shot> CreateShotAsync(string number, string title, string description = "", CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("shots"), new { episode = 1, number, title, description }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<Shot>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回镜头");
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

    public async Task<IReadOnlyList<PrevizLayoutVersion>> GetPrevizLayoutsAsync(string? sceneKey = null, CancellationToken token = default)
    {
        var query = string.IsNullOrWhiteSpace(sceneKey) ? "" : $"?scene_key={Uri.EscapeDataString(sceneKey)}";
        return await _http.GetFromJsonAsync<List<PrevizLayoutVersion>>(ProjectPath("previz/layouts") + query, token) ?? [];
    }

    public async Task<PrevizLayoutVersion> SavePrevizAsync(string sceneKey, double cameraX, double cameraY, double targetX, double targetY, double lens, double sunBearing, IReadOnlyList<PrevizSubject> subjects, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("previz/layouts"), new
        {
            scene_key = sceneKey,
            camera = new { position = new { x = cameraX, y = cameraY }, target = new { x = targetX, y = targetY }, lens_mm = lens, height_m = 1.6, movement = "fixed" },
            subjects,
            landmarks = Array.Empty<object>(),
            sun_bearing_deg = sunBearing,
            sun_elevation = "mid"
        }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<PrevizLayoutVersion>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回预演版本");
    }

    public async Task<ShotPrevizBinding?> GetShotPrevizBindingAsync(int shotId, CancellationToken token = default)
    {
        var response = await _http.GetAsync(ProjectPath($"shots/{shotId}/previz-binding"), token);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ShotPrevizBinding>(cancellationToken: token);
    }

    public async Task<ShotPrevizBinding> BindShotPrevizAsync(int shotId, int layoutId, CancellationToken token = default)
    {
        var response = await _http.PutAsJsonAsync(ProjectPath($"shots/{shotId}/previz-binding"), new { layout_id = layoutId }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ShotPrevizBinding>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回镜头绑定");
    }

    public async Task RemoveShotPrevizBindingAsync(int shotId, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync(ProjectPath($"shots/{shotId}/previz-binding"), token);
        if (response.StatusCode != System.Net.HttpStatusCode.NotFound) response.EnsureSuccessStatusCode();
    }

    private sealed record HealthResult(string Status);
}
