using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
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
    private readonly DispatcherTimer _taskRefreshTimer = new() { Interval = TimeSpan.FromSeconds(2) };
    private bool _refreshingTasks;
    private int _modelLoadVersion;
    public GenerationWindow(StudioApiClient api, StudioProject project) { InitializeComponent(); _api = api; _project = project; ProjectText.Text = $"· {project.Name}"; for (var i = 1; i <= project.EpisodeCount; i++) EpisodeSelector.Items.Add(i); EpisodeSelector.SelectedIndex = 0; _taskRefreshTimer.Tick += async (_, _) => await RefreshTasksAsync(false); Loaded += async (_, _) => { await LoadAsync(); _taskRefreshTimer.Start(); }; Closed += (_, _) => _taskRefreshTimer.Stop(); }
    private int Episode => EpisodeSelector.SelectedItem is int value ? value : 1;
    private string SelectedType => (TaskType.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "image";
    private static string ComboText(ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "";
    private static string ComboTag(ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private static string SelectedModelId(ComboBox box) => box.SelectedItem is ProviderModelInfo model ? model.Id.Trim() : box.Text.Trim();
    private async Task LoadAsync()
    {
        try
        {
            _shots = (await _api.GetShotsAsync()).Where(x => x.Episode == Episode).ToList(); _assets = await _api.GetAssetsAsync(episode: Episode); _providers = (await _api.GetProviderConfigsAsync()).Where(p => p.Configured).ToList();
            ShotSelector.ItemsSource = _shots; if (ShotSelector.SelectedIndex < 0 && _shots.Count > 0) ShotSelector.SelectedIndex = 0;
            var boards = await _api.GetReferenceBoardsAsync();
            var approvedReferences = boards.Where(board => board.Status == "approved").SelectMany(board => board.Assets).Where(asset => asset.Approved);
            ReferenceList.ItemsSource = _assets.Where(a => a.AssetType == "image" && string.IsNullOrWhiteSpace(a.EntityKey)).Concat(approvedReferences).GroupBy(a => a.Id).Select(group => group.First()).ToList();
            await RefreshProvidersAsync(); await RefreshTasksAsync();
            UpdateSubmitAvailability();
        }
        catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; }
    }
    private async Task RefreshProvidersAsync()
    {
        var selectedProviderId = (ProviderSelector.SelectedItem as ProviderConfigStatus)?.ProviderId;
        var type = SelectedType;
        var capability = type switch { "image" => "t2i", "video" => "i2v", "voice" => "tts", _ => "" };
        var allowed = _providers.Where(p => p.Capabilities.Contains(capability)).ToList();
        ProviderSelector.ItemsSource = allowed;
        ProviderSelector.SelectedItem = allowed.FirstOrDefault(item => item.ProviderId == selectedProviderId) ?? allowed.FirstOrDefault();
        if (ProviderSelector.SelectedItem is null) { ModelText.ItemsSource = null; ModelText.Text = ""; }
        UpdateSubmitAvailability();
        await Task.CompletedTask;
    }
    private async Task RefreshTasksAsync(bool updateStatus = true)
    {
        if (_refreshingTasks) return;
        _refreshingTasks = true;
        try
        {
            var tasks = (await _api.GetTasksAsync()).Where(t => t.TaskType is "image" or "video" or "voice").ToList();
            var selectedId = (TaskGrid.SelectedItem as TaskItem)?.Id;
            TaskGrid.ItemsSource = tasks;
            TaskGrid.SelectedItem = tasks.FirstOrDefault(item => item.Id == selectedId);
            if (updateStatus) StatusText.Text = tasks.Count == 0 ? "尚无生成任务。选择镜头、服务商和模型后提交。" : $"生成任务 {tasks.Count} 项：进行中 {tasks.Count(t => t.Status is "queued" or "running" or "retry_wait")}，成功 {tasks.Count(t => t.Status == "completed")}，失败 {tasks.Count(t => t.Status == "failed")}。";
        }
        catch (Exception ex) { if (updateStatus) StatusText.Text = $"任务刷新失败：{ex.Message}"; }
        finally { _refreshingTasks = false; }
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshTasksAsync();
    private async void EpisodeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await LoadAsync(); }
    private async void TaskType_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (!IsLoaded) return; await RefreshProvidersAsync(); if (ShotSelector.SelectedItem is Shot shot) PromptText.Text = SelectedType == "voice" ? shot.Dialogue : shot.Prompt; }
    private async void ProviderSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ProviderSelector.SelectedItem is not ProviderConfigStatus provider) return;
        var loadVersion = ++_modelLoadVersion;
        var capability = SelectedType switch { "image" => "t2i", "video" => "i2v", "voice" => "tts", _ => "" };
        ModelText.ItemsSource = null;
        ModelText.Text = provider.Model;
        if (SelectedType == "video")
        {
            ModelText.Text = provider.ProviderId == "metaso" ? "MiniMax-H3" : "wan2.7-i2v-2026-04-25";
            Resolution.ItemsSource = provider.ProviderId == "metaso" ? new[] { "768P", "2K" } : new[] { "720P", "1080P" };
            Resolution.SelectedIndex = 0;
        }
        else
        {
            Resolution.ItemsSource = new[] { "默认" }; Resolution.SelectedIndex = 0;
        }
        StatusText.Text = $"正在读取 {provider.Name} 的可用模型…";
        try
        {
            var result = await _api.GetProviderModelsAsync(provider.ProviderId, capability);
            if (loadVersion != _modelLoadVersion || (ProviderSelector.SelectedItem as ProviderConfigStatus)?.ProviderId != provider.ProviderId) return;
            ModelText.ItemsSource = result.Models;
            var selected = result.Models.FirstOrDefault(item => string.Equals(item.Id, provider.Model, StringComparison.OrdinalIgnoreCase)) ?? result.Models.FirstOrDefault();
            if (selected is not null) ModelText.SelectedItem = selected; else ModelText.Text = provider.Model;
            StatusText.Text = $"{provider.Name}：已加载 {result.Models.Count} 个可用模型" + (string.IsNullOrWhiteSpace(result.Warning) ? "。" : $"；{result.Warning}");
        }
        catch (Exception ex) { if (loadVersion == _modelLoadVersion) StatusText.Text = $"模型目录读取失败：{ex.Message}。可手动输入模型 ID。"; }
        UpdateSubmitAvailability();
        UpdateCostPreview();
    }
    private void ShotSelector_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (ShotSelector.SelectedItem is Shot shot) PromptText.Text = SelectedType == "voice" ? shot.Dialogue : shot.Prompt; }
    private Dictionary<string, object?> Options() => new() { ["duration"] = int.TryParse(ComboText(Duration), out var d) ? d : 5, ["seconds"] = int.TryParse(ComboText(Duration), out var s) ? s : 8, ["ratio"] = ComboText(Ratio), ["resolution"] = ComboText(Resolution), ["reference_mode"] = ComboTag(ReferenceMode), ["size"] = ComboText(Ratio) == "9:16" ? "720x1280" : "1280x720", ["voice"] = "alloy", ["prompt_extend"] = true, ["watermark"] = false };
    private IReadOnlyList<int> References() => ReferenceList.SelectedItems.Cast<AssetItem>().Select(a => a.Id).ToList();
    private async Task QueueAsync(Shot shot, string prompt)
    {
        if (ProviderSelector.SelectedItem is not ProviderConfigStatus provider) throw new InvalidOperationException("没有已配置且支持此能力的模型提供方");
        var modelId = SelectedModelId(ModelText);
        await _api.GenerateShotAsync(shot.Id, SelectedType, provider.ProviderId, prompt, string.IsNullOrWhiteSpace(modelId) ? null : modelId, References(), Options());
    }
    private async void Generate_Click(object sender, RoutedEventArgs e)
    {
        GenerateButton.IsEnabled = false;
        try { if (ShotSelector.SelectedItem is not Shot shot) throw new InvalidOperationException("请先生成全量分镜并选择镜头"); if (string.IsNullOrWhiteSpace(PromptText.Text)) throw new InvalidOperationException("提示词不能为空"); if (!ConfirmPaidSubmission(1)) { StatusText.Text = "已取消提交，未创建付费任务。"; return; } StatusText.Text = $"正在提交镜头 {shot.Number}，请稍候…"; await QueueAsync(shot, PromptText.Text.Trim()); await RefreshTasksAsync(false); StatusText.Text = $"✓ 镜头 {shot.Number} 已进入生成队列；右侧状态会自动刷新。"; }
        catch (Exception ex) { StatusText.Text = $"提交失败：{ex.Message}"; }
        finally { UpdateSubmitAvailability(); }
    }
    private async void Batch_Click(object sender, RoutedEventArgs e)
    {
        BatchButton.IsEnabled = false;
        try { if (_shots.Count == 0) throw new InvalidOperationException("项目没有分镜"); var planned = _shots.Count(shot => !string.IsNullOrWhiteSpace(SelectedType == "voice" ? shot.Dialogue : shot.Prompt)); if (!ConfirmPaidSubmission(planned)) { StatusText.Text = "已取消批量提交，未创建付费任务。"; return; } var count = 0; foreach (var shot in _shots) { var prompt = SelectedType == "voice" ? shot.Dialogue : shot.Prompt; if (string.IsNullOrWhiteSpace(prompt)) continue; StatusText.Text = $"正在提交：{count + 1}/{planned} · 镜头 {shot.Number}"; await QueueAsync(shot, prompt); count++; } await RefreshTasksAsync(false); StatusText.Text = $"✓ 已提交 {count} 个镜头任务；右侧状态会自动刷新。"; }
        catch (Exception ex) { StatusText.Text = $"批量提交失败：{ex.Message}"; }
        finally { UpdateSubmitAvailability(); }
    }
    private async void Settings_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog();
            _providers = (await _api.GetProviderConfigsAsync()).Where(p => p.Configured).ToList();
            await RefreshProvidersAsync();
            StatusText.Text = ProviderSelector.Items.Count == 0 ? $"没有已配置且支持 {SelectedType} 的服务商，请返回模型设置完成连接。" : "模型设置已更新，可以提交生成任务。";
        }
        catch (Exception ex) { StatusText.Text = $"模型设置刷新失败：{ex.Message}"; }
    }

    private void UpdateSubmitAvailability()
    {
        var ready = ShotSelector.SelectedItem is Shot && ProviderSelector.SelectedItem is ProviderConfigStatus;
        GenerateButton.IsEnabled = ready;
        BatchButton.IsEnabled = _shots.Count > 0 && ProviderSelector.SelectedItem is ProviderConfigStatus;
        if (IsLoaded && ProviderSelector.Items.Count == 0) StatusText.Text = $"没有已配置且支持 {SelectedType} 的服务商，请先打开“模型设置”。";
        UpdateCostPreview();
    }

    private void CostInput_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) UpdateCostPreview(); }
    private string BuildCostPreview(int count)
    {
        var provider = ProviderSelector.SelectedItem as ProviderConfigStatus;
        var seconds = SelectedType == "video" && int.TryParse(ComboText(Duration), out var duration) ? duration * count : 0;
        var baseText = $"计划：{count} 次 {SelectedType} 调用 · {provider?.Name ?? "未选择服务商"} · {SelectedModelId(ModelText)}" + (seconds > 0 ? $" · 共 {seconds} 秒视频" : "");
        if (provider?.ProviderId == "metaso" && SelectedType == "video" && seconds > 0)
        {
            var rate = ComboText(Resolution) == "2K" ? 0.15m : 0.09m;
            return $"{baseText} · 参考费用约 ¥{seconds * rate:0.00}（按 ¥{rate:0.00}/秒，实际以服务商账单为准）";
        }
        return baseText + " · 费用以服务商实时账单为准";
    }
    private void UpdateCostPreview()
    {
        if (!IsLoaded || CostPreviewText is null) return;
        var count = Math.Max(1, _shots.Count(shot => !string.IsNullOrWhiteSpace(SelectedType == "voice" ? shot.Dialogue : shot.Prompt)));
        CostPreviewText.Text = "当前镜头：" + BuildCostPreview(1) + (count > 1 ? $"\n批量全部：{BuildCostPreview(count)}" : "");
    }
    private bool ConfirmPaidSubmission(int count)
    {
        if (count <= 0) throw new InvalidOperationException("没有可提交的有效提示词或对白");
        return MessageBox.Show(BuildCostPreview(count) + "\n\n确认后才会创建生成任务。", "确认生成调用", MessageBoxButton.OKCancel, MessageBoxImage.Warning) == MessageBoxResult.OK;
    }

    private TaskItem? SelectedTask => TaskGrid.SelectedItem as TaskItem;
    private void TaskGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var task = SelectedTask;
        OpenResultButton.IsEnabled = task is not null && task.Status == "completed" && File.Exists(task.OutputPath);
        CancelTaskButton.IsEnabled = task?.Status is "queued" or "running" or "retry_wait";
        RetryTaskButton.IsEnabled = task?.Status is "failed" or "canceled";
    }
    private void OpenResult_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedTask is not { } task || !File.Exists(task.OutputPath)) { StatusText.Text = "该任务尚无可打开的结果文件。"; return; }
        Process.Start(new ProcessStartInfo(task.OutputPath) { UseShellExecute = true });
    }
    private async void CancelTask_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedTask is not { } task) return;
        try { await _api.CancelTaskAsync(task.Id); await RefreshTasksAsync(false); StatusText.Text = $"任务 #{task.Id} 已请求取消。"; }
        catch (Exception ex) { StatusText.Text = $"取消失败：{ex.Message}"; }
    }
    private async void RetryTask_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedTask is not { } task) return;
        try { await _api.RetryTaskAsync(task.Id); await RefreshTasksAsync(false); StatusText.Text = $"任务 #{task.Id} 已重新进入队列。"; }
        catch (Exception ex) { StatusText.Text = $"重试失败：{ex.Message}"; }
    }
    private void Gallery_Click(object sender, RoutedEventArgs e) => new GenerationGalleryWindow(_api, Episode) { Owner = this }.ShowDialog();
}