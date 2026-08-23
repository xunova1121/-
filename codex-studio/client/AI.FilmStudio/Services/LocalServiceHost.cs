using System.Diagnostics;
using System.IO;

namespace AI.FilmStudio.Services;

public sealed class LocalServiceHost : IDisposable
{
    private Process? _process;

    public void StartIfPackaged()
    {
        var baseDir = AppContext.BaseDirectory;
        var executable = Path.Combine(baseDir, "service", "AIStudioService.exe");
        if (!File.Exists(executable)) return;
        _process = Process.Start(new ProcessStartInfo(executable)
        {
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
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

