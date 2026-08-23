using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class PublishWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<TaskItem> _exports = [];
    public PublishWindow(StudioApiClient api) { InitializeComponent(); _api = api; ExportGrid.ItemsSource = _exports; Loaded += async (_, _) => await LoadAsync(); }
    private async Task LoadAsync() { try { var tasks = await _api.GetTasksAsync(); _exports.Clear(); foreach (var task in tasks.Where(x => x.TaskType == "timeline_export")) _exports.Add(task); StatusText.Text = _exports.Count == 0 ? "尚无成片任务，请先在剪辑工作台导出。" : $"共 {_exports.Count} 个成片任务。"; } catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; } }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private TaskItem? Selected => ExportGrid.SelectedItem as TaskItem;
    private void Open_Click(object sender, RoutedEventArgs e) { if (Selected is { OutputPath.Length: > 0 } task && File.Exists(task.OutputPath)) Process.Start(new ProcessStartInfo(task.OutputPath) { UseShellExecute = true }); else StatusText.Text = "请选择已经完成并存在输出文件的任务。"; }
    private void Publish_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { OutputPath.Length: > 0 } task || !File.Exists(task.OutputPath)) { StatusText.Text = "请选择已经完成的成片任务。"; return; }
        var dialog = new SaveFileDialog { Filter = "MP4 成片|*.mp4", FileName = Path.GetFileName(task.OutputPath), AddExtension = true };
        if (dialog.ShowDialog() != true) return;
        try { File.Copy(task.OutputPath, dialog.FileName, true); StatusText.Text = $"发布完成：{dialog.FileName}"; }
        catch (Exception ex) { StatusText.Text = $"发布失败：{ex.Message}"; }
    }
}
