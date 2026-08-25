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
            var routes = (await _api.GetModelRoutesAsync()).Where(item => !string.IsNullOrWhiteSpace(item.Model)).ToList();
            var selected = (Role.SelectedItem as ModelRoute)?.Role;
            Role.ItemsSource = routes;
            Role.SelectedItem = routes.FirstOrDefault(item => item.Role == selected) ?? routes.FirstOrDefault();
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
        if (Role.SelectedItem is not ModelRoute role) { FeedbackText.Text = "请先在“模型”中拉取模型并确认岗位绑定"; return; }
        try
        {
            await _api.CreateRoleTaskAsync(role.Role, $"为当前项目执行“{role.Name}”。必须输出合法 JSON，不要使用 Markdown 代码围栏。");
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
