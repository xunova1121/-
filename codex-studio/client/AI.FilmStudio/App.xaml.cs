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
        EventManager.RegisterClassHandler(typeof(Window), FrameworkElement.LoadedEvent, new RoutedEventHandler(FitWindowToWorkArea));
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

    private static void FitWindowToWorkArea(object sender, RoutedEventArgs _)
    {
        if (sender is not Window window) return;
        var area = SystemParameters.WorkArea;
        var maxWidth = Math.Max(760, area.Width - 24);
        var maxHeight = Math.Max(560, area.Height - 24);
        window.MinWidth = Math.Min(window.MinWidth, maxWidth);
        window.MinHeight = Math.Min(window.MinHeight, maxHeight);
        window.MaxWidth = maxWidth;
        window.MaxHeight = maxHeight;
        if (!double.IsNaN(window.Width) && window.Width > maxWidth) window.Width = maxWidth;
        if (!double.IsNaN(window.Height) && window.Height > maxHeight) window.Height = maxHeight;
        var width = double.IsNaN(window.Width) || window.Width <= 0 ? Math.Min(window.ActualWidth, maxWidth) : window.Width;
        var height = double.IsNaN(window.Height) || window.Height <= 0 ? Math.Min(window.ActualHeight, maxHeight) : window.Height;
        var preferredLeft = window.Owner is null ? area.Left + (area.Width - width) / 2 : window.Owner.Left + (window.Owner.ActualWidth - width) / 2;
        var preferredTop = window.Owner is null ? area.Top + (area.Height - height) / 2 : window.Owner.Top + (window.Owner.ActualHeight - height) / 2;
        window.Left = Math.Clamp(preferredLeft, area.Left + 12, Math.Max(area.Left + 12, area.Right - width - 12));
        window.Top = Math.Clamp(preferredTop, area.Top + 12, Math.Max(area.Top + 12, area.Bottom - height - 12));
        window.UseLayoutRounding = true;
        window.SnapsToDevicePixels = true;
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
        File.WriteAllText(Path.Combine(directory, "desktop-ready.txt"), $"{Environment.ProcessId}|{StudioRuntime.ProductVersion}|{StudioRuntime.ApiBaseAddress}|{DateTimeOffset.Now:O}");
    }
}
