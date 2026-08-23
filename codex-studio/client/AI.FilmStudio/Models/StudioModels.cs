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
    [JsonIgnore] public string CharacterText => string.Join("、", Characters);
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

public sealed class ProjectSummary
{
    [JsonPropertyName("scripts")] public int Scripts { get; set; }
    [JsonPropertyName("scenes")] public int Scenes { get; set; }
    [JsonPropertyName("shots")] public int Shots { get; set; }
    [JsonPropertyName("characters")] public int Characters { get; set; }
    [JsonPropertyName("locations")] public int Locations { get; set; }
    [JsonPropertyName("props")] public int Props { get; set; }
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
    [JsonIgnore] public string DisplayName => Configured ? $"● {Name}" : $"○ {Name}";
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
    [JsonPropertyName("result")] public Dictionary<string, JsonElement> Result { get; set; } = [];
    [JsonIgnore] public string OutputPath => Result.TryGetValue("output_path", out var value) ? value.GetString() ?? "" : "";
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
