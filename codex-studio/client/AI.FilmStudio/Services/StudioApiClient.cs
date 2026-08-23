using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using AI.FilmStudio.Models;

namespace AI.FilmStudio.Services;

public sealed class StudioApiClient
{
    private readonly HttpClient _http;
    public string? CurrentProjectId { get; private set; }

    public StudioApiClient()
    {
        _http = new HttpClient { BaseAddress = StudioRuntime.ApiBaseAddress, Timeout = TimeSpan.FromMinutes(10) };
    }

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
            return result?.Status == "ok" && result.Version == StudioRuntime.ProductVersion &&
                   (StudioRuntime.InstanceId == "external" || result.InstanceId == StudioRuntime.InstanceId);
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

    public async Task<IReadOnlyList<AssetItem>> GetAssetsAsync(string? assetType = null, int? episode = null, CancellationToken token = default)
    {
        var query = new List<string>();
        if (!string.IsNullOrWhiteSpace(assetType)) query.Add($"asset_type={Uri.EscapeDataString(assetType)}");
        if (episode is not null) query.Add($"episode={episode}");
        var suffix = "assets" + (query.Count > 0 ? "?" + string.Join("&", query) : "");
        return await _http.GetFromJsonAsync<List<AssetItem>>(ProjectPath(suffix), token) ?? [];
    }

    public async Task<AssetItem> ImportAssetAsync(string path, string assetType, string name, int episode = 1, int? shotId = null, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("assets/import"), new { source_path = path, asset_type = assetType, name, episode, shot_id = shotId, copy_into_project = true }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<AssetItem>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回资产");
    }

    public async Task DeleteAssetAsync(int assetId, bool deleteFile = true, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync($"assets/{assetId}?delete_file={deleteFile.ToString().ToLowerInvariant()}", token);
        response.EnsureSuccessStatusCode();
    }

    public async Task<TaskAccepted> GenerateShotAsync(int shotId, string taskType, string provider, string prompt, string? model, IReadOnlyList<int> references, Dictionary<string, object?> options, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("shots/generate"), new { shot_id = shotId, task_type = taskType, provider, prompt, model, reference_asset_ids = references, options }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    public async Task<IReadOnlyList<TimelineClip>> GetTimelineAsync(int episode = 1, CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<TimelineClip>>(ProjectPath($"timeline?episode={episode}"), token) ?? [];

    public async Task<TimelineClip> AddTimelineClipAsync(string sourcePath, string title, int episode = 1, string track = "V1", CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline"), new { episode, track, source_path = sourcePath, title }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<TimelineClip>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回时间线片段");
    }

    public async Task<int> BuildTimelineFromStoryboardAsync(int episode = 1, CancellationToken token = default)
    {
        var response = await _http.PostAsync(ProjectPath($"timeline/from-storyboard?episode={episode}&replace=true"), null, token);
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<OperationAccepted>(cancellationToken: token);
        return result?.Created ?? 0;
    }

    public async Task UpdateTimelineClipAsync(TimelineClip clip, CancellationToken token = default)
    {
        var response = await _http.PatchAsJsonAsync($"timeline/{clip.Id}", new { position = clip.Position, track = clip.Track, title = clip.Title, trim_in = clip.TrimIn, trim_out = clip.TrimOut, duration = clip.Duration, transition = clip.Transition, transition_duration = clip.TransitionDuration, volume = clip.Volume }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task ReorderTimelineAsync(IEnumerable<int> clipIds, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline/reorder"), new { clip_ids = clipIds }, token);
        response.EnsureSuccessStatusCode();
    }

    public async Task DeleteTimelineClipAsync(int clipId, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync($"timeline/{clipId}", token);
        response.EnsureSuccessStatusCode();
    }

    public async Task<TaskAccepted> ExportTimelineAsync(int episode, int width, int height, int fps, string quality, string outputName, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline/export"), new { episode, width, height, fps, quality, burn_subtitles = true, output_name = outputName }, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    public async Task<ProofreadResult> ProofreadAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<ProofreadResult>(ProjectPath("proofread"), token) ?? new ProofreadResult();

    public async Task<JsonElement> SavePrevizAsync(string sceneKey, double cameraX, double cameraY, double targetX, double targetY, double subjectX, double subjectY, double lens, double sunBearing, CancellationToken token = default)
    {
        var payload = new { scene_key = sceneKey, camera = new { position = new { x = cameraX, y = cameraY }, target = new { x = targetX, y = targetY }, lens_mm = lens, height_m = 1.6, movement = "fixed" }, subjects = new[] { new { entity_key = "主角", position = new { x = subjectX, y = subjectY }, facing_deg = 180, pose = "standing" } }, landmarks = Array.Empty<object>(), sun_bearing_deg = sunBearing, sun_elevation = "mid" };
        var response = await _http.PostAsJsonAsync(ProjectPath("previz/layouts"), payload, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: token);
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

    private sealed class HealthResult
    {
        [System.Text.Json.Serialization.JsonPropertyName("status")] public string Status { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("version")] public string Version { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("instance_id")] public string InstanceId { get; set; } = "";
    }
}
