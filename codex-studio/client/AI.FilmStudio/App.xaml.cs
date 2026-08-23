using System.Windows;
using System.IO;

using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class App : Application
{
    private readonly LocalServiceHost _service = new();

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            WriteCrashLog(args.Exception);
            MessageBox.Show($"程序发生异常，诊断日志已保存。\n\n{args.Exception.Message}", "AI影视Studio", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
            Shutdown(-1);
        };
        try
        {
            _service.StartIfPackaged();
            MainWindow = new MainWindow();
            MainWindow.Show();
            try { WriteReadyMarker(); }
            catch (Exception markerError) { WriteCrashLog(markerError); }
        }
        catch (Exception ex)
        {
            WriteCrashLog(ex);
            MessageBox.Show($"启动失败，诊断日志已保存。\n\n{ex.Message}", "AI影视Studio 启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(-1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _service.Dispose();
        base.OnExit(e);
    }

    private static void WriteCrashLog(Exception exception)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI-Film-Studio", "logs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "desktop.log"), $"[{DateTimeOffset.Now:O}] {exception}\n\n");
        }
        catch { }
    }

    private static void WriteReadyMarker()
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI-Film-Studio");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "desktop-ready.txt"), $"{Environment.ProcessId}|0.6.0|{DateTimeOffset.Now:O}");
    }
}
