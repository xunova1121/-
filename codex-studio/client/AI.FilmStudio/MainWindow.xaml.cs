using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class MainWindow : Window
{
    private readonly StudioApiClient _api = new();
    private readonly ObservableCollection<Shot> _shots =
    [
        new("001", "远景｜固定", "雪山全景，风雪飘扬", "3.2s", "已生成", "#1C2027"),
        new("002", "中景｜推镜", "李狗蛋出现，步履坚定", "2.8s", "已生成", "#1C2027"),
        new("003", "特写｜固定", "人物面部与情绪特写", "2.6s", "已生成", "#1C2027"),
        new("004", "大全景｜平移", "古寺大门，灯火摇曳", "2.4s", "生成中 65%", "#252019"),
        new("005", "中景｜跟随", "李狗蛋进入古寺", "1.8s", "待生成", "#1C2027"),
        new("006", "近景｜固定", "黑衣人出现，深邃", "1.8s", "待生成", "#1C2027")
    ];

    public MainWindow()
    {
        InitializeComponent();
        ShotList.ItemsSource = _shots;
        Loaded += async (_, _) => await CheckServiceAsync();
    }

    private async Task CheckServiceAsync()
    {
        var healthy = false;
        for (var attempt = 0; attempt < 20 && !healthy; attempt++)
        {
            healthy = await _api.IsHealthyAsync();
            if (!healthy) await Task.Delay(500);
        }
        ServiceDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(healthy ? "#36C979" : "#E0A534"));
        ServiceText.Text = healthy ? "本地服务已连接" : "离线演示模式";
    }

    private async void Workspace_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string key }) return;
        WorkspaceTitle.Text = key switch
        {
            "director" => "导演工作台 · 第1集 雪夜杀局",
            "storyboard" => "分镜工作台 · 第1集 雪夜杀局",
            "generation" => "视频生成中心 · 第1集 雪夜杀局",
            "assets" => "资产管理 · 雪山剑客 第一季",
            "tasks" => "任务队列 · 生成与渲染",
            _ => "剪辑工作台 · 第1集 雪夜杀局"
        };
        if (key == "tasks")
        {
            var window = new TaskQueueWindow(_api) { Owner = this };
            window.ShowDialog();
            await CheckServiceAsync();
        }
    }

    private void TopNav_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string title }) WorkspaceTitle.Text = $"{title} · 雪山剑客 第一季";
    }

    private void EpisodeList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (EpisodeList.SelectedItem is ListBoxItem item)
            WorkspaceTitle.Text = $"剪辑工作台 · {item.Content?.ToString()?.Trim()}";
    }
}
