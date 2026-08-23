using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class EditingWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<TimelineClip> _clips = [];
    public EditingWindow(StudioApiClient api) { InitializeComponent(); _api = api; ClipGrid.ItemsSource = _clips; Loaded += async (_, _) => await LoadAsync(); }

    private async Task LoadAsync()
    {
        try { var rows = await _api.GetTimelineAsync(); _clips.Clear(); foreach (var row in rows) _clips.Add(row); StatusText.Text = _clips.Count == 0 ? "时间线为空：可导入本地视频，或将已生成的视频镜头自动组装。" : $"已加载 {_clips.Count} 个真实片段。"; }
        catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; }
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "视频素材|*.mp4;*.mov;*.mkv;*.avi;*.webm|所有文件|*.*", Multiselect = true };
        if (dialog.ShowDialog() != true) return;
        try { foreach (var path in dialog.FileNames) await _api.AddTimelineClipAsync(path, System.IO.Path.GetFileNameWithoutExtension(path)); await LoadAsync(); }
        catch (Exception ex) { StatusText.Text = $"导入失败：{ex.Message}"; }
    }
    private async void Build_Click(object sender, RoutedEventArgs e) { try { var count = await _api.BuildTimelineFromStoryboardAsync(); await LoadAsync(); StatusText.Text = $"已从生成结果组装 {count} 个视频镜头。"; } catch (Exception ex) { StatusText.Text = $"组装失败：{ex.Message}"; } }
    private async void Save_Click(object sender, RoutedEventArgs e) { ClipGrid.CommitEdit(); ClipGrid.CommitEdit(); try { foreach (var clip in _clips) await _api.UpdateTimelineClipAsync(clip); await _api.ReorderTimelineAsync(_clips.Select(x => x.Id)); StatusText.Text = "时间线已持久化保存。"; } catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; } }
    private TimelineClip? Selected => ClipGrid.SelectedItem as TimelineClip;
    private async Task MoveAsync(int delta) { if (Selected is not { } clip) return; var index = _clips.IndexOf(clip); var next = index + delta; if (next < 0 || next >= _clips.Count) return; _clips.Move(index, next); for (var i = 0; i < _clips.Count; i++) _clips[i].Position = i; await _api.ReorderTimelineAsync(_clips.Select(x => x.Id)); ClipGrid.SelectedItem = clip; }
    private async void Up_Click(object sender, RoutedEventArgs e) => await MoveAsync(-1);
    private async void Down_Click(object sender, RoutedEventArgs e) => await MoveAsync(1);
    private async void Delete_Click(object sender, RoutedEventArgs e) { if (Selected is not { } clip) return; await _api.DeleteTimelineClipAsync(clip.Id); _clips.Remove(clip); StatusText.Text = "片段已从时间线删除（源文件保留）。"; }
    private void Open_Click(object sender, RoutedEventArgs e) { if (Selected is { } clip && System.IO.File.Exists(clip.SourcePath)) Process.Start(new ProcessStartInfo(clip.SourcePath) { UseShellExecute = true }); }
    private static string ComboText(ComboBox combo) => (combo.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "";
    private async void Export_Click(object sender, RoutedEventArgs e)
    {
        if (_clips.Count == 0) { StatusText.Text = "请先加入视频片段。"; return; }
        try { await SaveInternalAsync(); var size = ((Resolution.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "1920x1080").Split('x'); var task = await _api.ExportTimelineAsync(1, int.Parse(size[0]), int.Parse(size[1]), int.Parse(ComboText(FrameRate)), (Quality.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "high", OutputName.Text.Trim()); StatusText.Text = $"成片导出任务 #{task.Id} 已进入队列；可在任务窗口查看进度与输出文件。"; }
        catch (Exception ex) { StatusText.Text = $"导出失败：{ex.Message}"; }
    }
    private async Task SaveInternalAsync() { ClipGrid.CommitEdit(); ClipGrid.CommitEdit(); foreach (var clip in _clips) await _api.UpdateTimelineClipAsync(clip); await _api.ReorderTimelineAsync(_clips.Select(x => x.Id)); }
    private void Tasks_Click(object sender, RoutedEventArgs e) => new TaskQueueWindow(_api) { Owner = this }.ShowDialog();
}
