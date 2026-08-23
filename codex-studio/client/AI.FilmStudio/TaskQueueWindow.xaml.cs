using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class TaskQueueWindow : Window
{
    private readonly StudioApiClient _api;

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

    private async void Create_Click(object sender, RoutedEventArgs e)
    {
        var type = (TaskType.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "video";
        try
        {
            await _api.CreateDemoTaskAsync(type);
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

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
