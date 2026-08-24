namespace AI.FilmStudio.Models;

using System.Text.Json.Serialization;
using System.Text.Json;

public sealed class Shot
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("scene_id")] public int? SceneId { get; set; }
    [JsonPropertyName("sequence")] public int Sequence { get; set; }
    [JsonPropertyName("number")] public string Number { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("duration")] public string Duration { get; set; } = "3.0s";
    [JsonPropertyName("status")] public string Status { get; set; } = "待生成";
    [JsonPropertyName("color")] public string Color { get; set; } = "#1C2027";
    [JsonPropertyName("prompt")] public string Prompt { get; set; } = "";
    [JsonPropertyName("shot_type")] public string ShotType { get; set; } = "中景";
    [JsonPropertyName("camera")] public string Camera { get; set; } = "固定";
    [JsonPropertyName("action")] public string Action { get; set; } = "";
    [JsonPropertyName("dialogue")] public string Dialogue { get; set; } = "";
    [JsonPropertyName("characters")] public List<string> Characters { get; set; } = [];
    [JsonPropertyName("continuity")] public Dictionary<string, JsonElement> Continuity { get; set; } = [];
    [JsonIgnore] public string Link { get => ReadText("link", "cut"); set => WriteText("link", value); }
    [JsonIgnore] public string ActionId { get => ReadText("action_id", ""); set => WriteText("action_id", value); }
    [JsonIgnore] public string ScreenDirection { get => ReadText("screen_direction", "unknown"); set => WriteText("screen_direction", value); }
    [JsonIgnore] public string ActionPhase { get => ReadText("action_phase", "static"); set => WriteText("action_phase", value); }
    [JsonIgnore] public string Momentum { get => ReadText("momentum", "still"); set => WriteText("momentum", value); }
    [JsonIgnore] public string StateBeforeText { get => ReadJson("state_before"); set => WriteJson("state_before", value); }
    [JsonIgnore] public string StateAfterText { get => ReadJson("state_after"); set => WriteJson("state_after", value); }
    [JsonIgnore] public string CharacterText => string.Join("、", Characters);
    [JsonIgnore] public string Display => $"{Number} · {Title}";

    private string ReadText(string key, string fallback) => Continuity.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    private void WriteText(string key, string value) => Continuity[key] = JsonSerializer.SerializeToElement(value ?? "");
    private string ReadJson(string key) => Continuity.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.Object ? value.GetRawText() : "{}";
    private void WriteJson(string key, string value)
    {
        try { using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(value) ? "{}" : value); Continuity[key] = document.RootElement.Clone(); }
        catch (JsonException) { }
    }
}

public sealed class ScriptDocument
{
    [JsonPropertyName("project_id")] public string ProjectId { get; set; } = "";
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("source_name")] public string SourceName { get; set; } = "";
    [JsonPropertyName("source_text")] public string SourceText { get; set; } = "";
    [JsonPropertyName("parse_status")] public string ParseStatus { get; set; } = "empty";
}

public sealed class ParsedScene
{
    [JsonPropertyName("sequence")] public int Sequence { get; set; }
    [JsonPropertyName("heading")] public string Heading { get; set; } = "";
    [JsonPropertyName("summary")] public string Summary { get; set; } = "";
    [JsonIgnore] public string Display => $"{Sequence:00}  {Heading}  {Summary}";
}

public sealed class ScriptParseResult
{
    [JsonPropertyName("scene_count")] public int SceneCount { get; set; }
    [JsonPropertyName("character_count")] public int CharacterCount { get; set; }
    [JsonPropertyName("characters")] public List<string> Characters { get; set; } = [];
    [JsonPropertyName("scenes")] public List<ParsedScene> Scenes { get; set; } = [];
}

public sealed class StoryboardGenerateResult
{
    [JsonPropertyName("shot_count")] public int ShotCount { get; set; }
    [JsonPropertyName("replaced")] public bool Replaced { get; set; }
}

public sealed class DirectorBuildResult
{
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
    [JsonPropertyName("logline")] public string Logline { get; set; } = "";
    [JsonPropertyName("scene_count")] public int SceneCount { get; set; }
    [JsonPropertyName("shot_count")] public int ShotCount { get; set; }
    [JsonPropertyName("bible_count")] public int BibleCount { get; set; }
    [JsonPropertyName("blocking_state_conflicts")] public int BlockingStateConflicts { get; set; }
    [JsonPropertyName("warnings")] public List<string> Warnings { get; set; } = [];
}

public sealed class ProjectSummary
{
    [JsonPropertyName("scripts")] public int Scripts { get; set; }
    [JsonPropertyName("scenes")] public int Scenes { get; set; }
    [JsonPropertyName("shots")] public int Shots { get; set; }
    [JsonPropertyName("characters")] public int Characters { get; set; }
    [JsonPropertyName("locations")] public int Locations { get; set; }
    [JsonPropertyName("props")] public int Props { get; set; }
}

public sealed class AssetItem
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("project_id")] public string ProjectId { get; set; } = "";
    [JsonPropertyName("asset_type")] public string AssetType { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("shot_id")] public int? ShotId { get; set; }
    [JsonPropertyName("local_path")] public string LocalPath { get; set; } = "";
    [JsonPropertyName("mime_type")] public string MimeType { get; set; } = "";
    [JsonPropertyName("source_kind")] public string SourceKind { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("created_at")] public string CreatedAt { get; set; } = "";
    [JsonIgnore] public string ShotText => ShotId is null ? "—" : ShotId.ToString()!;
}

public sealed class TimelineClip
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("track")] public string Track { get; set; } = "V1";
    [JsonPropertyName("position")] public int Position { get; set; }
    [JsonPropertyName("asset_id")] public int? AssetId { get; set; }
    [JsonPropertyName("source_path")] public string SourcePath { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("trim_in")] public double TrimIn { get; set; }
    [JsonPropertyName("trim_out")] public double TrimOut { get; set; }
    [JsonPropertyName("duration")] public double Duration { get; set; }
    [JsonPropertyName("transition")] public string Transition { get; set; } = "cut";
    [JsonPropertyName("transition_duration")] public double TransitionDuration { get; set; } = 0.4;
    [JsonPropertyName("volume")] public double Volume { get; set; } = 1;
}

public sealed class OperationAccepted
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("created")] public int Created { get; set; }
}

public sealed class ProofreadResult
{
    [JsonPropertyName("score")] public int Score { get; set; }
    [JsonPropertyName("shot_count")] public int ShotCount { get; set; }
    [JsonPropertyName("state_conflicts")] public int StateConflicts { get; set; }
    [JsonPropertyName("findings")] public List<ContinuityFinding> Findings { get; set; } = [];
}
public sealed class ContinuityFinding
{
    [JsonPropertyName("shot")] public string Shot { get; set; } = "";
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("action")] public string Action { get; set; } = "";
    [JsonPropertyName("severity")] public string Severity { get; set; } = "warning";
    [JsonIgnore] public string ActionText => Action switch { "adjust_axis" => "调整机位/运动方向", "adjust_lighting" => "统一光照状态", "fix_story_state" => "修正状态前/状态后 JSON", "fix_action_phase" => "补中间相位/过渡镜头", _ => "人工复核" };
}
public sealed record Episode(string Title, string Duration, bool IsActive = false);
public sealed record Finding(string Shot, string Message, string Action);
public sealed record Workspace(string Key, string Title);

public sealed class StudioProject
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("genre")] public string Genre { get; set; } = "";
    [JsonPropertyName("episode_count")] public int EpisodeCount { get; set; } = 1;
    [JsonIgnore] public string Summary => $"{Genre} · {EpisodeCount} 集";
}

public sealed class ProviderConfigStatus
{
    [JsonPropertyName("provider_id")] public string ProviderId { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("base_url")] public string BaseUrl { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
    [JsonPropertyName("configured")] public bool Configured { get; set; }
    [JsonPropertyName("credential_source")] public string CredentialSource { get; set; } = "";
    [JsonPropertyName("capabilities")] public List<string> Capabilities { get; set; } = [];
    [JsonIgnore] public string DisplayName => Configured ? $"● {Name}" : $"○ {Name}";
}

public sealed class GatewayTextResult
{
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
    [JsonPropertyName("result")] public string Result { get; set; } = "";
}

public sealed class TaskItem
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("task_type")] public string TaskType { get; set; } = "";
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("progress")] public int Progress { get; set; }
    [JsonPropertyName("attempts")] public int Attempts { get; set; }
    [JsonPropertyName("max_attempts")] public int MaxAttempts { get; set; }
    [JsonPropertyName("error_message")] public string ErrorMessage { get; set; } = "";
    [JsonPropertyName("created_at")] public string CreatedAt { get; set; } = "";
    [JsonPropertyName("provider_task_id")] public string ProviderTaskId { get; set; } = "";
    [JsonPropertyName("payload")] public Dictionary<string, JsonElement> Payload { get; set; } = [];
    [JsonPropertyName("result")] public Dictionary<string, JsonElement> Result { get; set; } = [];
    [JsonIgnore] public string OutputPath => Result.TryGetValue("output_path", out var value) ? value.GetString() ?? "" : "";
    [JsonIgnore] public string RouteState
    {
        get
        {
            if (Payload.TryGetValue("routing", out var routing) && routing.ValueKind == JsonValueKind.Object &&
                routing.TryGetProperty("degraded_from", out var from) && routing.TryGetProperty("degraded_to", out var to))
            {
                var pending = routing.TryGetProperty("upgrade_pending", out var value) && value.ValueKind == JsonValueKind.True;
                return $"{from.GetString()}→{to.GetString()}" + (pending ? " · 秘塔待升级" : "");
            }
            return string.IsNullOrWhiteSpace(ProviderTaskId) ? "正常路由" : $"外部任务 {ProviderTaskId}";
        }
    }
}

public sealed class MediaCapabilities
{
    [JsonPropertyName("ffmpeg_available")] public bool FfmpegAvailable { get; set; }
    [JsonPropertyName("ffmpeg_path")] public string? FfmpegPath { get; set; }
}

public sealed class TaskAccepted
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("status")] public string Status { get; set; } = "";
}

public sealed class BibleEntity
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("entity_type")] public string EntityType { get; set; } = "character";
    [JsonPropertyName("entity_key")] public string EntityKey { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("state")] public string State { get; set; } = "draft";
    [JsonPropertyName("data")] public Dictionary<string, JsonElement> Data { get; set; } = [];
    [JsonPropertyName("reference_assets")] public List<string> ReferenceAssets { get; set; } = [];
    [JsonPropertyName("fingerprint")] public string Fingerprint { get; set; } = "";
    [JsonIgnore] public string Display => $"{Name} · v{Version} · {(State == "frozen" ? "已冻结" : "草稿")}";
}

public sealed class AutomationRun
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("mode")] public string Mode { get; set; } = "balanced";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("stage")] public string Stage { get; set; } = "";
    [JsonPropertyName("progress")] public int Progress { get; set; }
    [JsonPropertyName("error_message")] public string ErrorMessage { get; set; } = "";
    [JsonPropertyName("checkpoint")] public Dictionary<string, JsonElement> Checkpoint { get; set; } = [];
    [JsonPropertyName("created_at")] public string CreatedAt { get; set; } = "";
    [JsonIgnore] public string OutputPath => Checkpoint.TryGetValue("output_path", out var value) ? value.GetString() ?? "" : "";
}

public sealed class AutomationRoutePlan
{
    [JsonPropertyName("ready")] public bool Ready { get; set; }
    [JsonPropertyName("shot_count")] public int ShotCount { get; set; }
    [JsonPropertyName("blocking_conflicts")] public int BlockingConflicts { get; set; }
    [JsonPropertyName("routes")] public List<AutomationRoute> Routes { get; set; } = [];
    [JsonPropertyName("totals")] public List<AutomationRouteTotal> Totals { get; set; } = [];
}

public sealed class AutomationRoute
{
    [JsonPropertyName("shot_number")] public string ShotNumber { get; set; } = "";
    [JsonPropertyName("seconds")] public int Seconds { get; set; }
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
    [JsonPropertyName("resolution")] public string Resolution { get; set; } = "";
    [JsonPropertyName("reason")] public string Reason { get; set; } = "";
    [JsonPropertyName("tier")] public string Tier { get; set; } = "";
    [JsonPropertyName("value_score")] public int ValueScore { get; set; }
    [JsonIgnore] public string RouteReason => Reason == "high_value_h3" ? "高价值镜头" : Reason == "standard_value_wan" ? "普通镜头节费" : "手动选择";
}

public sealed class AutomationRouteTotal
{
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("shots")] public int Shots { get; set; }
    [JsonPropertyName("seconds")] public int Seconds { get; set; }
}
