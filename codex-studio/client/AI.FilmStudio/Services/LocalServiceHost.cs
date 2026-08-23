using System.Diagnostics;
using System.IO;

namespace AI.FilmStudio.Services;

public sealed class LocalServiceHost : IDisposable
{
    private Process? _process;
    public string? LastError { get; private set; }

    public void StartIfPackaged()
    {
        var baseDir = AppContext.BaseDirectory;
        var executable = Path.Combine(baseDir, "service", "AIStudioService.exe");
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
