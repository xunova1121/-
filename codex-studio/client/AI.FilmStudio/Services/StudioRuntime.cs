namespace AI.FilmStudio.Services;

public static class StudioRuntime
{
    public const string ProductVersion = "1.5.4";
    public static Uri ApiBaseAddress { get; set; } = new("http://127.0.0.1:18118/api/v1/");
    public static string InstanceId { get; set; } = "external";
}
