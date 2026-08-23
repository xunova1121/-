using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class TransitionRenderWindow : Window
{
    private readonly StudioApiClient _api;

    public TransitionRenderWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await CheckEngineAsync();
    }

    private async Task CheckEngineAsync()
    {
        try
        {
            var status = await _api.GetMediaCapabilitiesAsync();
            EngineStatus.Text = status.FfmpegAvailable ? $"● FFmpeg 已就绪：{status.FfmpegPath}" : "● 未检测到 FFmpeg：渲染任务会保留并明确标记失败，可配置后重试";
            EngineStatus.Foreground = System.Windows.Media.Brushes.LightGreen;
            if (!status.FfmpegAvailable) EngineStatus.Foreground = System.Windows.Media.Brushes.Orange;
        }
        catch (Exception ex) { Feedback.Text = $"服务检测失败：{ex.Message}"; }
    }

    private static string? PickVideo()
    {
        var dialog = new OpenFileDialog { Filter = "视频文件|*.mp4;*.mov;*.mkv;*.webm;*.avi|所有文件|*.*" };
        return dialog.ShowDialog() == true ? dialog.FileName : null;
    }

    private void PickLeft_Click(object sender, RoutedEventArgs e) { var path = PickVideo(); if (path is not null) LeftPath.Text = path; }
    private void PickRight_Click(object sender, RoutedEventArgs e) { var path = PickVideo(); if (path is not null) RightPath.Text = path; }

    private async void Render_Click(object sender, RoutedEventArgs e)
    {
        if (!File.Exists(LeftPath.Text) || !File.Exists(RightPath.Text)) { Feedback.Text = "请先选择两个有效的视频文件。"; return; }
        if (!double.TryParse(Duration.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) || seconds <= 0 || seconds > 3) { Feedback.Text = "转场时长必须在 0 到 3 秒之间。"; return; }
        var method = (Method.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "dissolve";
        RenderButton.IsEnabled = false;
        try
        {
            var task = await _api.QueueTransitionRenderAsync(LeftPath.Text, RightPath.Text, method, seconds);
            Feedback.Text = $"任务 #{task.Id} 已加入队列。可在任务中心查看结果、错误并重试。";
        }
        catch (Exception ex) { Feedback.Text = $"提交失败：{ex.Message}"; }
        finally { RenderButton.IsEnabled = true; }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
