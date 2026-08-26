using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class VideoGenerationWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly List<string> _references = [];
    private bool _hasBinding;

    public VideoGenerationWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await LoadShotsAsync();
    }

    private async Task LoadShotsAsync()
    {
        try
        {
            var shots = await _api.GetShotsAsync();
            ShotSelector.ItemsSource = shots;
            if (shots.Count > 0) ShotSelector.SelectedIndex = 0;
            else BindingStatus.Text = "项目中没有镜头，请先在分镜工作台创建并锁定镜头。";
        }
        catch (Exception ex) { Feedback.Text = $"镜头读取失败：{ex.Message}"; }
    }

    private async void ShotSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ShotSelector.SelectedItem is not Shot shot) return;
        Prompt.Text = string.IsNullOrWhiteSpace(shot.Prompt) ? $"{shot.Title}。{shot.Description}" : shot.Prompt;
        SubmitButton.IsEnabled = false;
        try
        {
            var binding = await _api.GetShotPrevizBindingAsync(shot.Id);
            _hasBinding = binding is not null;
            BindingStatus.Text = binding is null ? "未绑定空间预演，暂不能生成。请先到空间预演台绑定此镜头。" : $"✓ 已锁定 {binding.SceneKey} / 布局 v{binding.LayoutVersion}，空间约束会自动注入。";
        }
        catch (Exception ex) { _hasBinding = false; BindingStatus.Text = $"预演核验失败：{ex.Message}"; }
        SubmitButton.IsEnabled = _hasBinding;
    }

    private static string? PickOne()
    {
        var dialog = new OpenFileDialog { Filter = "图片|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件|*.*", CheckFileExists = true };
        return dialog.ShowDialog() == true ? dialog.FileName : null;
    }

    private void BrowseFirst_Click(object sender, RoutedEventArgs e) { var path = PickOne(); if (path is not null) FirstFrame.Text = path; }
    private void BrowseLast_Click(object sender, RoutedEventArgs e) { var path = PickOne(); if (path is not null) LastFrame.Text = path; }
    private void BrowseReferences_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "图片|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件|*.*", CheckFileExists = true, Multiselect = true };
        if (dialog.ShowDialog() != true) return;
        _references.Clear();
        _references.AddRange(dialog.FileNames);
        ReferenceImages.Text = string.Join(Environment.NewLine, _references.Select(Path.GetFileName));
    }

    private async void Submit_Click(object sender, RoutedEventArgs e)
    {
        if (ShotSelector.SelectedItem is not Shot shot) { Feedback.Text = "请选择镜头"; return; }
        if (!_hasBinding) { Feedback.Text = "此镜头必须先绑定空间预演版本"; return; }
        if (string.IsNullOrWhiteSpace(Prompt.Text)) { Feedback.Text = "视频提示词不能为空"; return; }
        if (_references.Count + (string.IsNullOrWhiteSpace(FirstFrame.Text) ? 0 : 1) + (string.IsNullOrWhiteSpace(LastFrame.Text) ? 0 : 1) > 9) { Feedback.Text = "首帧、尾帧和参考图合计不能超过 9 张"; return; }
        var duration = int.Parse(((Duration.SelectedItem as ComboBoxItem)?.Tag?.ToString()) ?? "5");
        var resolution = (Resolution.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "768P";
        var ratio = (AspectRatio.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "16:9";
        SubmitButton.IsEnabled = false;
        Feedback.Text = "正在提交并冻结本次镜头约束…";
        try
        {
            var task = await _api.QueueShotVideoAsync(shot.Id, Prompt.Text.Trim(), FirstFrame.Text.Trim(), LastFrame.Text.Trim(), _references, duration, resolution, ratio);
            Feedback.Text = $"✓ 任务 #{task.Id} 已进入真实生成队列。可关闭窗口并到“任务队列”查看轮询、取消与成片路径。";
        }
        catch (Exception ex) { Feedback.Text = ex.Message; }
        finally { SubmitButton.IsEnabled = _hasBinding; }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
