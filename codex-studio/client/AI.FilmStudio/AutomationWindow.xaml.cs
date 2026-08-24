using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class AutomationWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private IReadOnlyList<ModelRoleBinding> _roles = [];
    private StoryboardLockStatus _lockStatus = new();

    public AutomationWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent();
        _api = api;
        _project = project;
        for (var i = 1; i <= project.EpisodeCount; i++) Episode.Items.Add(i);
        Episode.SelectedIndex = 0;
        _timer.Tick += async (_, _) => await LoadRunsAsync();
        Loaded += async (_, _) => { await LoadAsync(); _timer.Start(); };
        Closed += (_, _) => _timer.Stop();
    }

    private static string Tag(ComboBox combo) => (combo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private ModelRoleBinding? Role(string id) => _roles.FirstOrDefault(item => item.Id == id);

    private static string RouteLabel(string title, ModelRoleBinding? role) => role is null || string.IsNullOrWhiteSpace(role.ProviderId)
        ? $"⚠ {title}：尚未绑定"
        : role.Available ? $"✓ {title}：{role.BindingLabel}" : $"⚠ {title}：{role.BindingLabel}（服务商未连接）";

    private void ShowRoleRoutes()
    {
        ImageRouteText.Text = RouteLabel("关键帧", Role("keyframe_image"));
        VideoRouteText.Text = RouteLabel("正式视频", Role("shot_video"));
        TransitionRouteText.Text = RouteLabel("镜间桥接", Role("transition_video"));
        VoiceRouteText.Text = RouteLabel("角色配音", Role("dialogue_voice"));
        ReviewRouteText.Text = RouteLabel("连续性质检", Role("continuity_review"));
        foreach (var block in new[] { ImageRouteText, VideoRouteText, TransitionRouteText, VoiceRouteText, ReviewRouteText })
            block.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(block.Text.StartsWith("✓") ? "#75E6A4" : "#FFD166"));
        var missing = new List<string>();
        if (Role("keyframe_image")?.Available != true) missing.Add("关键帧生成");
        if (Role("shot_video")?.Available != true) missing.Add("正式镜头视频");
        if (EnableVoice.IsChecked == true && Role("dialogue_voice")?.Available != true) missing.Add("角色对白配音");
        if (EnableReview.IsChecked == true && Role("continuity_review")?.Available != true) missing.Add("跨镜连续性审核");
        var lockReady = _lockStatus.IsLocked;
        StartButton.IsEnabled = missing.Count == 0 && lockReady;
        LockStatusText.Text = lockReady ? $"✓ 第 {_lockStatus.Episode} 集全量分镜已锁定 · R{_lockStatus.Revision}" : $"⚠ 第 {_lockStatus.Episode} 集分镜门禁：{_lockStatus.Label}";
        LockStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(lockReady ? "#75E6A4" : "#FFD166"));
        RouteBlockerText.Text = missing.Count > 0 ? "尚缺岗位：" + string.Join("、", missing) + "。请进入模型路由中心完成绑定和连接。" :
            !lockReady ? "请先在分镜工作台完成全量审阅并锁定本集；未锁定内容不会提交任何付费任务。" :
            "岗位与分镜门禁均已就绪，可以执行生成前预检。";
    }

    private async Task LoadAsync()
    {
        try
        {
            _roles = await _api.GetModelRolesAsync();
            _lockStatus = await _api.GetStoryboardLockAsync((int)Episode.SelectedItem);
            ShowRoleRoutes();
            await LoadRunsAsync();
            StatusText.Text = "自动生产严格使用岗位绑定；Story Bible、真实尾帧继承、任务断点恢复均在后台执行。";
        }
        catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; }
    }

    private async Task LoadRunsAsync()
    {
        try { RunGrid.ItemsSource = await _api.GetAutomationRunsAsync(); }
        catch { }
    }

    private ModelRoleBinding RequireRole(string id, string label)
    {
        var role = Role(id);
        if (role?.Available != true) throw new InvalidOperationException($"请先在模型路由中心完成并连接“{label}”岗位");
        return role;
    }

    private (int Episode, string Mode, ModelRoleBinding Image, ModelRoleBinding Video, ModelRoleBinding? Voice, ModelRoleBinding? Quality, int Width, int Height) ReadConfiguration()
    {
        var image = RequireRole("keyframe_image", "关键帧生成");
        var video = RequireRole("shot_video", "正式镜头视频");
        var voice = EnableVoice.IsChecked == true ? RequireRole("dialogue_voice", "角色对白配音") : null;
        var quality = EnableReview.IsChecked == true ? RequireRole("continuity_review", "跨镜连续性审核") : null;
        var (width, height) = Tag(Aspect) switch { "landscape" => (1920, 1080), "square" => (1080, 1080), _ => (1080, 1920) };
        return ((int)Episode.SelectedItem, Tag(Mode), image, video, voice, quality, width, height);
    }

    private async Task<AutomationRoutePlan> PreviewAsync()
    {
        var value = ReadConfiguration();
        var plan = await _api.GetAutomationRoutePlanAsync(value.Episode, value.Mode, value.Image.ProviderId, value.Image.Model, value.Video.ProviderId, value.Video.Model, value.Voice?.ProviderId, value.Voice?.Model ?? "", value.Quality?.ProviderId, OutputName.Text.Trim(), value.Width, value.Height, 24, "high");
        RouteGrid.ItemsSource = plan.Routes;
        var totals = string.Join("；", plan.Totals.Select(x => $"{x.Provider} {x.Shots}镜/{x.Seconds}秒"));
        StatusText.Text = plan.Ready ? $"预检通过：锁定版本 R{plan.LockRevision}，{plan.ShotCount} 镜。{totals}" :
            plan.LockStatus != "locked" ? "预检阻断：本集全量分镜尚未锁定或锁定后已被修改。" :
            $"预检阻断：{plan.BlockingConflicts} 个连续性冲突或尚无分镜。";
        return plan;
    }

    private async void Preview_Click(object sender, RoutedEventArgs e) { try { await PreviewAsync(); } catch (Exception ex) { StatusText.Text = $"预检失败：{ex.Message}"; } }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadRunsAsync();
    private async void RefreshRoutes_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private void Options_Click(object sender, RoutedEventArgs e) => ShowRoleRoutes();
    private async void Episode_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || Episode.SelectedItem is not int episode) return;
        try { _lockStatus = await _api.GetStoryboardLockAsync(episode); ShowRoleRoutes(); await PreviewAsync(); }
        catch (Exception ex) { StatusText.Text = $"集数切换失败：{ex.Message}"; }
    }

    private async void Start_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var value = ReadConfiguration();
            var plan = await PreviewAsync();
            if (!plan.Ready) throw new InvalidOperationException($"路由预检未通过：{plan.BlockingConflicts} 个连续性阻断");
            StartButton.IsEnabled = false;
            var run = await _api.StartAutomationAsync(value.Episode, value.Mode, value.Image.ProviderId, value.Image.Model, value.Video.ProviderId, value.Video.Model, value.Voice?.ProviderId, value.Voice?.Model ?? "", value.Quality?.ProviderId, OutputName.Text.Trim(), value.Width, value.Height, 24, "high");
            StatusText.Text = $"自动生产 #{run.Id} 已启动；可关闭窗口，后台仍会继续。";
            await LoadRunsAsync();
        }
        catch (Exception ex) { StatusText.Text = $"启动失败：{ex.Message}"; }
        finally { ShowRoleRoutes(); }
    }

    private async void Cancel_Click(object sender, RoutedEventArgs e) { if (RunGrid.SelectedItem is not AutomationRun run) return; try { await _api.CancelAutomationAsync(run.Id); await LoadRunsAsync(); } catch (Exception ex) { StatusText.Text = $"取消失败：{ex.Message}"; } }
    private void Open_Click(object sender, RoutedEventArgs e) { if (RunGrid.SelectedItem is AutomationRun { OutputPath.Length: > 0 } run && File.Exists(run.OutputPath)) Process.Start(new ProcessStartInfo(run.OutputPath) { UseShellExecute = true }); else StatusText.Text = "选中的运行尚无可打开成片。"; }
    private async void Settings_Click(object sender, RoutedEventArgs e) { new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog(); await LoadAsync(); }
}
