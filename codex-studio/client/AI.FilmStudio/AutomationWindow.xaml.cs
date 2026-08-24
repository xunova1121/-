using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class AutomationWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private IReadOnlyList<ProviderConfigStatus> _providers = [];
    public AutomationWindow(StudioApiClient api, StudioProject project) { InitializeComponent(); _api = api; _project = project; for (var i = 1; i <= project.EpisodeCount; i++) Episode.Items.Add(i); Episode.SelectedIndex = 0; _timer.Tick += async (_, _) => await LoadRunsAsync(); Loaded += async (_, _) => { await LoadAsync(); _timer.Start(); }; Closed += (_, _) => _timer.Stop(); }
    private static string Tag(ComboBox combo) => (combo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private void VideoProvider_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (VideoProvider.SelectedItem is ProviderConfigStatus item) VideoModel.Text = item.ProviderId == "metaso" ? "MiniMax-H3" : "wan2.7-i2v-2026-04-25"; }
    private async Task LoadAsync() { try { _providers = (await _api.GetProviderConfigsAsync()).Where(x => x.Configured).ToList(); ImageProvider.ItemsSource = _providers.Where(x => x.Capabilities.Contains("t2i")).ToList(); VideoProvider.ItemsSource = _providers.Where(x => x.Capabilities.Contains("i2v")).ToList(); ImageProvider.SelectedIndex = 0; VideoProvider.SelectedIndex = 0; await LoadRunsAsync(); StatusText.Text = _providers.Count == 0 ? "请先配置模型 API。" : "自动生产会冻结 Story Bible，并让连续镜头继承上一镜真实尾帧。秘塔 H3 任务会持久化 ID，重启不会重复提交。"; } catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; } }
    private async Task LoadRunsAsync() { try { RunGrid.ItemsSource = await _api.GetAutomationRunsAsync(); } catch { } }
    private (int Episode, string Mode, ProviderConfigStatus Image, ProviderConfigStatus Video, ProviderConfigStatus? Voice, string? Quality, int Width, int Height) ReadConfiguration()
    {
        if (ImageProvider.SelectedItem is not ProviderConfigStatus image) throw new InvalidOperationException("需要配置 OpenAI 关键帧模型");
        if (VideoProvider.SelectedItem is not ProviderConfigStatus video) throw new InvalidOperationException("需要配置秘塔 H3 或阿里云百炼 Wan 视频模型");
        var voice = EnableVoice.IsChecked == true ? _providers.FirstOrDefault(x => x.ProviderId == "openai") : null;
        if (EnableVoice.IsChecked == true && voice is null) throw new InvalidOperationException("启用配音需要配置 OpenAI");
        var quality = EnableReview.IsChecked == true ? _providers.FirstOrDefault(x => x.ProviderId == "openai")?.ProviderId : null;
        if (EnableReview.IsChecked == true && quality is null) throw new InvalidOperationException("VLM 质检需要配置 OpenAI");
        var (width, height) = Tag(Aspect) switch { "landscape" => (1920, 1080), "square" => (1080, 1080), _ => (1080, 1920) };
        return ((int)Episode.SelectedItem, Tag(Mode), image, video, voice, quality, width, height);
    }
    private async Task<AutomationRoutePlan> PreviewAsync()
    {
        var value = ReadConfiguration();
        var plan = await _api.GetAutomationRoutePlanAsync(value.Episode, value.Mode, value.Image.ProviderId, ImageModel.Text.Trim(), value.Video.ProviderId, VideoModel.Text.Trim(), value.Voice?.ProviderId, "gpt-4o-mini-tts", value.Quality, OutputName.Text.Trim(), value.Width, value.Height, 24, "high");
        RouteGrid.ItemsSource = plan.Routes;
        var totals = string.Join("；", plan.Totals.Select(x => $"{x.Provider} {x.Shots}镜/{x.Seconds}秒"));
        StatusText.Text = plan.Ready ? $"预检通过：{plan.ShotCount} 镜。{totals}" : $"预检阻断：{plan.BlockingConflicts} 个连续性冲突或尚无分镜。";
        return plan;
    }
    private async void Preview_Click(object sender, RoutedEventArgs e) { try { await PreviewAsync(); } catch (Exception ex) { StatusText.Text = $"预检失败：{ex.Message}"; } }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadRunsAsync();
    private async void Start_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var value = ReadConfiguration();
            var plan = await PreviewAsync();
            if (!plan.Ready) throw new InvalidOperationException($"路由预检未通过：{plan.BlockingConflicts} 个连续性阻断");
            StartButton.IsEnabled = false;
            var run = await _api.StartAutomationAsync(value.Episode, value.Mode, value.Image.ProviderId, ImageModel.Text.Trim(), value.Video.ProviderId, VideoModel.Text.Trim(), value.Voice?.ProviderId, "gpt-4o-mini-tts", value.Quality, OutputName.Text.Trim(), value.Width, value.Height, 24, "high");
            StatusText.Text = $"自动生产 #{run.Id} 已启动；可关闭窗口，后台仍会继续。"; await LoadRunsAsync();
        }
        catch (Exception ex) { StatusText.Text = $"启动失败：{ex.Message}"; }
        finally { StartButton.IsEnabled = true; }
    }
    private async void Cancel_Click(object sender, RoutedEventArgs e) { if (RunGrid.SelectedItem is not AutomationRun run) return; try { await _api.CancelAutomationAsync(run.Id); await LoadRunsAsync(); } catch (Exception ex) { StatusText.Text = $"取消失败：{ex.Message}"; } }
    private void Open_Click(object sender, RoutedEventArgs e) { if (RunGrid.SelectedItem is AutomationRun { OutputPath.Length: > 0 } run && File.Exists(run.OutputPath)) Process.Start(new ProcessStartInfo(run.OutputPath) { UseShellExecute = true }); else StatusText.Text = "选中的运行尚无可打开成片。"; }
    private async void Settings_Click(object sender, RoutedEventArgs e) { new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog(); await LoadAsync(); }
}
