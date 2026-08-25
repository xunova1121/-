namespace AI.FilmStudio.Models;

using System.Text.Json.Serialization;
using System.Text.Json;

public sealed class Shot
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("episode")] public int Episode { get; set; }
    [JsonPropertyName("number")] public string Number { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("duration")] public string Duration { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("color")] public string Color { get; set; } = "";
    [JsonPropertyName("prompt")] public string Prompt { get; set; } = "";
    [JsonIgnore] public string Display => $"{Number} · {Title}";
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

public sealed class PrevizPoint
{
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
}

public sealed class PrevizCamera
{
    [JsonPropertyName("position")] public PrevizPoint Position { get; set; } = new();
    [JsonPropertyName("target")] public PrevizPoint Target { get; set; } = new();
    [JsonPropertyName("lens_mm")] public double LensMm { get; set; } = 35;
    [JsonPropertyName("height_m")] public double HeightM { get; set; } = 1.6;
    [JsonPropertyName("movement")] public string Movement { get; set; } = "fixed";
}

public sealed class PrevizSubject
{
    [JsonPropertyName("entity_key")] public string EntityKey { get; set; } = "角色";
    [JsonPropertyName("position")] public PrevizPoint Position { get; set; } = new();
    [JsonPropertyName("facing_deg")] public double FacingDeg { get; set; } = 180;
    [JsonPropertyName("pose")] public string Pose { get; set; } = "standing";
}

public sealed class PrevizLayoutVersion
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("scene_key")] public string SceneKey { get; set; } = "";
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("fingerprint")] public string Fingerprint { get; set; } = "";
    [JsonPropertyName("created_at")] public string CreatedAt { get; set; } = "";
    [JsonPropertyName("camera")] public PrevizCamera Camera { get; set; } = new();
    [JsonPropertyName("subjects")] public List<PrevizSubject> Subjects { get; set; } = [];
    [JsonPropertyName("sun_bearing_deg")] public double? SunBearingDeg { get; set; }
    [JsonPropertyName("sun_elevation")] public string SunElevation { get; set; } = "mid";
    [JsonPropertyName("analysis")] public JsonElement Analysis { get; set; }
    [JsonIgnore] public string Display => $"v{Version} · {CreatedAt}";
}

public sealed class ShotPrevizBinding
{
    [JsonPropertyName("shot_id")] public int ShotId { get; set; }
    [JsonPropertyName("shot_number")] public string ShotNumber { get; set; } = "";
    [JsonPropertyName("layout_id")] public int LayoutId { get; set; }
    [JsonPropertyName("scene_key")] public string SceneKey { get; set; } = "";
    [JsonPropertyName("layout_version")] public int LayoutVersion { get; set; }
    [JsonPropertyName("fingerprint")] public string Fingerprint { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("prompt_constraint")] public string PromptConstraint { get; set; } = "";
}
