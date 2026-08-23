using System.Windows;

using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class App : Application
{
    private readonly LocalServiceHost _service = new();

    protected override void OnStartup(StartupEventArgs e)
    {
        _service.StartIfPackaged();
        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _service.Dispose();
        base.OnExit(e);
    }
}
