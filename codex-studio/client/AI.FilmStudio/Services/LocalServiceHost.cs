using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace AI.FilmStudio.Services;

public sealed class LocalServiceHost : IDisposable
{
    private Process? _process;
    public string? LastError { get; private set; }

    public void StartIfPackaged()
    {
        var baseDir = AppContext.BaseDirectory;
        var executable = Path.Combine(baseDir, "service", "AIStudioService.exe");
        if (!File.Exists(executable)) executable = ExtractEmbeddedService() ?? "";
        if (!File.Exists(executable)) return;
        try
        {
            _process = Process.Start(new ProcessStartInfo(executable)
            {
                WorkingDirectory = Path.GetDirectoryName(executable)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            try
            {
                var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI-Film-Studio", "logs");
                Directory.CreateDirectory(logDir);
                File.AppendAllText(Path.Combine(logDir, "desktop.log"), $"[{DateTimeOffset.Now:O}] Local service start failed: {ex}\n\n");
            }
            catch { }
        }
    }

    private static string? ExtractEmbeddedService()
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("AIStudioService.exe");
        if (resource is null) return null;
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "current";
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI-Film-Studio", "runtime", version);
        Directory.CreateDirectory(directory);
        var target = Path.Combine(directory, "AIStudioService.exe");
        if (!File.Exists(target) || new FileInfo(target).Length != resource.Length)
        {
            var temporary = target + ".new";
            using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) resource.CopyTo(output);
            File.Move(temporary, target, true);
        }
        return target;
    }

    public void Dispose()
    {
        try
        {
            if (_process is { HasExited: false }) _process.Kill(true);
        }
        catch { }
        _process?.Dispose();
    }
}
