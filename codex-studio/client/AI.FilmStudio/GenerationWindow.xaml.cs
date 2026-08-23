using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class GenerationWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private IReadOnlyList<Shot> _shots = [];
    private IReadOnlyList<ProviderConfigStatus> _providers = [];
    private IReadOnlyList<AssetItem> _assets = [];
    public GenerationWindow(StudioApiClient api, StudioProject project) { InitializeComponent(); _api = api; _project = project; ProjectText.Text = $"· {project.Name}"; for (var i = 1; i <= project.EpisodeCount; i++) EpisodeSelector.Items.Add(i); EpisodeSelector.SelectedIndex = 0; Loaded += async (_, _) => await LoadAsync(); }
    private int Episode => EpisodeSelector.SelectedItem is int value ? value : 1;
    private string SelectedType => (TaskType.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "image";
    private static string ComboText(ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "";
    private async Task LoadAsync()
    {
        try
        {
            _shots = (await _api.GetShotsAsync()).Where(x => x.Episode == Episode).ToList(); _assets = await _api.GetAssetsAsync(episode: Episode); _providers = (await _api.GetProviderConfigsAsync()).Where(p => p.Configured).ToList();
            ShotSelector.ItemsSource = _shots; if (ShotSelector.SelectedIndex < 0 && _shots.Count > 0) ShotSelector.SelectedIndex = 0;
            ReferenceList.ItemsSource = _assets.Where(a => a.AssetType is "image" or "character" or "scene" or "prop").ToList();
            await RefreshProvidersAsync(); await RefreshTasksAsync();
        }
        catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; }
    }
    private async Task RefreshProvidersAsync()
    {
        var type = SelectedType;
        var allowed = _providers.Where(p => type switch { "image" => p.ProviderId == "openai", "video" => p.ProviderId == "dashscope", "voice" => p.ProviderId == "openai", _ => false }).ToList();
        ProviderSelector.ItemsSource = allowed; if (allowed.Count > 0) ProviderSelector.SelectedIndex = 0;
        ModelText.Text = type switch { "image" => "gpt-image-2", "video" => "wan2.7-i2v-2026-04-25", "voice" => "gpt-4o-mini-tts", _ => "" };
        await Task.CompletedTask;
    }
    private async Task RefreshTasksAsync() { var tasks = await _api.GetTasksAsync(); TaskGrid.ItemsSource = tasks.Where(t => t.TaskType is "image" or "video" or "voice").ToList(); StatusText.Text = $"生成任务 {tasks.Count(t => t.TaskType is "image" or "video" or "voice")} 项。完成结果会自动回写资产库和镜头。"; }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshTasksAsync();
    private async void EpisodeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await LoadAsync(); }
    private async void TaskType_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await RefreshProvidersAsync(); }
    private void ShotSelector_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (ShotSelector.SelectedItem is Shot shot) PromptText.Text = SelectedType == "voice" ? shot.Dialogue : shot.Prompt; }
    private Dictionary<string, object?> Options() => new() { ["duration"] = int.TryParse(ComboText(Duration), out var d) ? d : 5, ["seconds"] = int.TryParse(ComboText(Duration), out var s) ? s : 8, ["ratio"] = ComboText(Ratio), ["resolution"] = "720P", ["size"] = ComboText(Ratio) == "9:16" ? "720x1280" : "1280x720", ["voice"] = "alloy", ["prompt_extend"] = true, ["watermark"] = false };
    private IReadOnlyList<int> References() => ReferenceList.SelectedItems.Cast<AssetItem>().Select(a => a.Id).ToList();
    private async Task QueueAsync(Shot shot, string prompt)
    {
        if (ProviderSelector.SelectedItem is not ProviderConfigStatus provider) throw new InvalidOperationException("没有已配置且支持此能力的模型提供方");
        await _api.GenerateShotAsync(shot.Id, SelectedType, provider.ProviderId, prompt, string.IsNullOrWhiteSpace(ModelText.Text) ? null : ModelText.Text.Trim(), References(), Options());
    }
    private async void Generate_Click(object sender, RoutedEventArgs e)
    {
        try { if (ShotSelector.SelectedItem is not Shot shot) throw new InvalidOperationException("请先生成全量分镜并选择镜头"); if (string.IsNullOrWhiteSpace(PromptText.Text)) throw new InvalidOperationException("提示词不能为空"); await QueueAsync(shot, PromptText.Text.Trim()); await RefreshTasksAsync(); }
        catch (Exception ex) { StatusText.Text = $"提交失败：{ex.Message}"; }
    }
    private async void Batch_Click(object sender, RoutedEventArgs e)
    {
        try { if (_shots.Count == 0) throw new InvalidOperationException("项目没有分镜"); var count = 0; foreach (var shot in _shots) { var prompt = SelectedType == "voice" ? shot.Dialogue : shot.Prompt; if (string.IsNullOrWhiteSpace(prompt)) continue; await QueueAsync(shot, prompt); count++; } StatusText.Text = $"已提交 {count} 个镜头任务。"; await RefreshTasksAsync(); }
        catch (Exception ex) { StatusText.Text = $"批量提交失败：{ex.Message}"; }
    }
    private void Settings_Click(object sender, RoutedEventArgs e) => new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog();
}
