using System.Windows;
using System.Windows.Controls;
using System.Diagnostics;
using System.IO;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class TaskQueueWindow : Window
{
    private readonly StudioApiClient _api;
    private IReadOnlyList<ProviderConfigStatus> _providers = [];

    public TaskQueueWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        try
        {
            _providers = (await _api.GetProviderConfigsAsync()).Where(item => item.Configured).ToList();
            RefreshProviderChoices();
            var tasks = await _api.GetTasksAsync();
            TaskGrid.ItemsSource = tasks;
            var active = tasks.Count(item => item.Status is "queued" or "running" or "retry_wait");
            var completed = tasks.Count(item => item.Status == "completed");
            SummaryText.Text = $"共 {tasks.Count} 项 · 活跃 {active} · 已完成 {completed} · 数据已持久化";
            FeedbackText.Text = $"最后刷新：{DateTime.Now:HH:mm:ss}";
        }
        catch (Exception ex)
        {
            FeedbackText.Text = $"无法连接本地服务：{ex.Message}";
        }
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshAsync();

    private void TaskType_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) RefreshProviderChoices(); }

    private void RefreshProviderChoices()
    {
        var type = (TaskType.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "llm";
        var capability = type switch { "image" => "t2i", "video" => "i2v", "voice" => "tts", _ => "chat" };
        var selected = (Provider.SelectedItem as ProviderConfigStatus)?.ProviderId;
        var available = _providers.Where(item => item.Capabilities.Contains(capability)).ToList();
        Provider.ItemsSource = available;
        Provider.SelectedItem = available.FirstOrDefault(item => item.ProviderId == selected) ?? available.FirstOrDefault();
    }

    private async void Create_Click(object sender, RoutedEventArgs e)
    {
        var type = (TaskType.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "video";
        if (Provider.SelectedItem is not ProviderConfigStatus provider) { FeedbackText.Text = "请先在主界面的“模型”中配置支持当前任务类型的提供方"; return; }
        try
        {
            await _api.CreateTaskAsync(type, provider.ProviderId, $"为当前影视项目执行 {type} 制作任务。输出应结构化、具体且可直接进入下一制作环节。");
            await Task.Delay(350);
            await RefreshAsync();
        }
        catch (Exception ex) { FeedbackText.Text = $"创建失败：{ex.Message}"; }
    }

    private async void Cancel_Click(object sender, RoutedEventArgs e)
    {
        if (TaskGrid.SelectedItem is not TaskItem task) { FeedbackText.Text = "请先选择任务"; return; }
        try { await _api.CancelTaskAsync(task.Id); await RefreshAsync(); }
        catch (Exception ex) { FeedbackText.Text = $"取消失败：{ex.Message}"; }
    }

    private async void Retry_Click(object sender, RoutedEventArgs e)
    {
        if (TaskGrid.SelectedItem is not TaskItem task) { FeedbackText.Text = "请先选择任务"; return; }
        try { await _api.RetryTaskAsync(task.Id); await RefreshAsync(); }
        catch (Exception ex) { FeedbackText.Text = $"重试失败：{ex.Message}"; }
    }

    private void OpenOutput_Click(object sender, RoutedEventArgs e)
    {
        if (TaskGrid.SelectedItem is not TaskItem task || string.IsNullOrWhiteSpace(task.OutputPath)) { FeedbackText.Text = "选中任务没有可打开的输出文件"; return; }
        if (!File.Exists(task.OutputPath)) { FeedbackText.Text = "输出文件不存在，可能已被移动或清理"; return; }
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{task.OutputPath}\"") { UseShellExecute = true });
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
