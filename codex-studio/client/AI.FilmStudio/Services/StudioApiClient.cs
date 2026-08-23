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

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        var raw = await response.Content.ReadAsStringAsync();
        var detail = raw;
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.TryGetProperty("detail", out var value)) detail = value.ValueKind == JsonValueKind.String ? value.GetString() ?? raw : value.ToString();
        }
        catch { }
        throw new InvalidOperationException($"服务返回 {(int)response.StatusCode} {response.ReasonPhrase}：{detail}");
    }

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
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<StudioProject>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回项目");
    }

    public async Task<StudioProject> UpdateProjectAsync(string projectId, string name, string genre, int episodeCount, CancellationToken token = default)
    {
        var response = await _http.PatchAsJsonAsync($"projects/{Uri.EscapeDataString(projectId)}", new { name, genre, episode_count = episodeCount }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<StudioProject>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回项目");
    }

    public async Task DeleteProjectAsync(string projectId, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync($"projects/{Uri.EscapeDataString(projectId)}", token);
        await EnsureSuccessAsync(response);
        if (CurrentProjectId == projectId) CurrentProjectId = null;
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
        await EnsureSuccessAsync(response);
    }

    public async Task<ScriptParseResult> ParseScriptAsync(int episode, CancellationToken token = default)
    {
        var response = await _http.PostAsync(ProjectPath($"episodes/{episode}/script/parse"), null, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<ScriptParseResult>(cancellationToken: token) ?? new ScriptParseResult();
    }

    public async Task<StoryboardGenerateResult> GenerateStoryboardAsync(int episode, bool replaceExisting = true, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath($"episodes/{episode}/storyboard/generate"), new { replace_existing = replaceExisting }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<StoryboardGenerateResult>(cancellationToken: token) ?? new StoryboardGenerateResult();
    }

    public async Task<DirectorBuildResult> GenerateDirectorPackageAsync(int episode, string provider, bool replaceExisting = true, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath($"episodes/{episode}/director/generate"), new { provider, replace_existing = replaceExisting, freeze_bible = true }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<DirectorBuildResult>(cancellationToken: token) ?? throw new InvalidOperationException("导演模型未返回生产设计");
    }

    public async Task UpdateShotAsync(Shot shot, CancellationToken token = default)
    {
        var response = await _http.PatchAsJsonAsync($"shots/{shot.Id}", new
        {
            title = shot.Title, description = shot.Description, duration = shot.Duration,
            status = shot.Status, prompt = shot.Prompt, shot_type = shot.ShotType,
            camera = shot.Camera, action = shot.Action, dialogue = shot.Dialogue,
            characters = shot.Characters, continuity = shot.Continuity
        }, token);
        await EnsureSuccessAsync(response);
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
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<AssetItem>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回资产");
    }

    public async Task DeleteAssetAsync(int assetId, bool deleteFile = true, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync($"assets/{assetId}?delete_file={deleteFile.ToString().ToLowerInvariant()}", token);
        await EnsureSuccessAsync(response);
    }

    public async Task<TaskAccepted> GenerateShotAsync(int shotId, string taskType, string provider, string prompt, string? model, IReadOnlyList<int> references, Dictionary<string, object?> options, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("shots/generate"), new { shot_id = shotId, task_type = taskType, provider, prompt, model, reference_asset_ids = references, options }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    public async Task<IReadOnlyList<TimelineClip>> GetTimelineAsync(int episode = 1, CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<TimelineClip>>(ProjectPath($"timeline?episode={episode}"), token) ?? [];

    public async Task<TimelineClip> AddTimelineClipAsync(string sourcePath, string title, int episode = 1, string track = "V1", CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline"), new { episode, track, source_path = sourcePath, title }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<TimelineClip>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回时间线片段");
    }

    public async Task<int> BuildTimelineFromStoryboardAsync(int episode = 1, CancellationToken token = default)
    {
        var response = await _http.PostAsync(ProjectPath($"timeline/from-storyboard?episode={episode}&replace=true"), null, token);
        await EnsureSuccessAsync(response);
        var result = await response.Content.ReadFromJsonAsync<OperationAccepted>(cancellationToken: token);
        return result?.Created ?? 0;
    }

    public async Task UpdateTimelineClipAsync(TimelineClip clip, CancellationToken token = default)
    {
        var response = await _http.PatchAsJsonAsync($"timeline/{clip.Id}", new { position = clip.Position, track = clip.Track, title = clip.Title, trim_in = clip.TrimIn, trim_out = clip.TrimOut, duration = clip.Duration, transition = clip.Transition, transition_duration = clip.TransitionDuration, volume = clip.Volume }, token);
        await EnsureSuccessAsync(response);
    }

    public async Task ReorderTimelineAsync(IEnumerable<int> clipIds, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline/reorder"), new { clip_ids = clipIds }, token);
        await EnsureSuccessAsync(response);
    }

    public async Task DeleteTimelineClipAsync(int clipId, CancellationToken token = default)
    {
        var response = await _http.DeleteAsync($"timeline/{clipId}", token);
        await EnsureSuccessAsync(response);
    }

    public async Task<TaskAccepted> ExportTimelineAsync(int episode, int width, int height, int fps, string quality, string outputName, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("timeline/export"), new { episode, width, height, fps, quality, burn_subtitles = true, output_name = outputName }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    public async Task<ProofreadResult> ProofreadAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<ProofreadResult>(ProjectPath("proofread"), token) ?? new ProofreadResult();

    public async Task<JsonElement> SavePrevizAsync(string sceneKey, double cameraX, double cameraY, double targetX, double targetY, double subjectX, double subjectY, double lens, double sunBearing, CancellationToken token = default)
    {
        var payload = new { scene_key = sceneKey, camera = new { position = new { x = cameraX, y = cameraY }, target = new { x = targetX, y = targetY }, lens_mm = lens, height_m = 1.6, movement = "fixed" }, subjects = new[] { new { entity_key = "主角", position = new { x = subjectX, y = subjectY }, facing_deg = 180, pose = "standing" } }, landmarks = Array.Empty<object>(), sun_bearing_deg = sunBearing, sun_elevation = "mid" };
        var response = await _http.PostAsJsonAsync(ProjectPath("previz/layouts"), payload, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: token);
    }

    public async Task<IReadOnlyList<BibleEntity>> GetBibleAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<BibleEntity>>(ProjectPath("bible?latest_only=true"), token) ?? [];

    public async Task<BibleEntity> SaveBibleVersionAsync(string entityType, string entityKey, string name, JsonElement data, IReadOnlyList<string> references, bool frozen, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("bible"), new { entity_type = entityType, entity_key = entityKey, name, data, reference_assets = references, state = frozen ? "frozen" : "draft" }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<BibleEntity>(cancellationToken: token) ?? throw new InvalidOperationException("服务未返回设定版本");
    }

    public async Task<AutomationRun> StartAutomationAsync(int episode, string mode, string imageProvider, string imageModel, string videoProvider, string videoModel, string? voiceProvider, string voiceModel, string? qualityProvider, string outputName, int width, int height, int fps, string quality, CancellationToken token = default)
    {
        var response = await _http.PostAsJsonAsync(ProjectPath("automation/start"), new { episode, mode, image_provider = imageProvider, image_model = imageModel, video_provider = videoProvider, video_model = videoModel, voice_provider = voiceProvider, voice_model = voiceModel, quality_provider = qualityProvider, output_name = outputName, width, height, fps, quality, auto_freeze_bible = true, generate_images = true, generate_voice = voiceProvider is not null, auto_repair = true }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<AutomationRun>(cancellationToken: token) ?? new AutomationRun();
    }

    public async Task<IReadOnlyList<AutomationRun>> GetAutomationRunsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<AutomationRun>>(ProjectPath("automation/runs"), token) ?? [];

    public async Task CancelAutomationAsync(int runId, CancellationToken token = default)
    {
        var response = await _http.PostAsync($"automation/runs/{runId}/cancel", null, token);
        await EnsureSuccessAsync(response);
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
        await EnsureSuccessAsync(response);
    }

    public async Task<IReadOnlyList<ProviderConfigStatus>> GetProviderConfigsAsync(CancellationToken token = default) =>
        await _http.GetFromJsonAsync<List<ProviderConfigStatus>>("provider-configs", token) ?? [];

    public async Task SaveProviderConfigAsync(string providerId, string baseUrl, string model, string? apiKey, CancellationToken token = default)
    {
        var response = await _http.PutAsJsonAsync($"provider-configs/{Uri.EscapeDataString(providerId)}", new { base_url = baseUrl, model, api_key = string.IsNullOrWhiteSpace(apiKey) ? null : apiKey }, token);
        await EnsureSuccessAsync(response);
    }

    public async Task<GatewayTextResult> RunDirectorAnalysisAsync(string provider, string script, int episode, CancellationToken token = default)
    {
        var prompt = $"""
请对以下第{episode}集短剧剧本做可执行的导演分析。必须给出：
1. 戏剧节拍与前三秒钩子；2. 逐场景视觉目标；3. 关键镜头与景别/运镜；
4. 相邻镜头的动作承接、视线方向和可用转场；5. 人物/服装/道具/场景连续性风险；
6. 适合图像及视频生成模型的具体约束。不要复述剧本，不要空泛建议。

剧本：
{script}
""";
        var response = await _http.PostAsJsonAsync("gateway/llm", new
        {
            provider,
            prompt,
            context = new { task_type = "llm", temperature = 0.25, max_tokens = 4096, system_prompt = "你是短剧导演与连续性总监。你的结论必须能直接指导分镜、生成和剪辑。" }
        }, token);
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<GatewayTextResult>(cancellationToken: token) ?? throw new InvalidOperationException("导演模型未返回分析结果");
    }

    public async Task CancelTaskAsync(int taskId, CancellationToken token = default)
    {
        var response = await _http.PostAsync($"tasks/{taskId}/cancel", null, token);
        await EnsureSuccessAsync(response);
    }

    public async Task RetryTaskAsync(int taskId, CancellationToken token = default)
    {
        var response = await _http.PostAsync($"tasks/{taskId}/retry", null, token);
        await EnsureSuccessAsync(response);
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
        await EnsureSuccessAsync(response);
        return await response.Content.ReadFromJsonAsync<TaskAccepted>(cancellationToken: token) ?? new TaskAccepted();
    }

    private sealed class HealthResult
    {
        [System.Text.Json.Serialization.JsonPropertyName("status")] public string Status { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("version")] public string Version { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("instance_id")] public string InstanceId { get; set; } = "";
    }
}
