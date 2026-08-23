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
    private readonly ObservableCollection<Shot> _shots = [];
    private readonly ObservableCollection<StudioProject> _projects = [];

    public MainWindow()
    {
        InitializeComponent();
        ShotList.ItemsSource = _shots;
        ProjectSelector.ItemsSource = _projects;
        Loaded += async (_, _) => await InitializeWorkspaceAsync();
    }

    private async Task<bool> CheckServiceAsync()
    {
        var healthy = false;
        for (var attempt = 0; attempt < 20 && !healthy; attempt++)
        {
            healthy = await _api.IsHealthyAsync();
            if (!healthy) await Task.Delay(500);
        }
        ServiceDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(healthy ? "#36C979" : "#E0A534"));
        ServiceText.Text = healthy ? "本地服务已连接" : "本地服务启动失败";
        return healthy;
    }

    private async Task InitializeWorkspaceAsync()
    {
        if (!await CheckServiceAsync()) return;
        await LoadProjectsAsync(true);
    }

    private async Task LoadProjectsAsync(bool promptWhenEmpty = false)
    {
        var selected = _api.CurrentProjectId;
        var projects = await _api.GetProjectsAsync();
        _projects.Clear();
        foreach (var project in projects.Where(item => item.Id != "demo")) _projects.Add(project);
        var next = _projects.FirstOrDefault(item => item.Id == selected) ?? _projects.FirstOrDefault();
        if (next is null && promptWhenEmpty)
        {
            var dialog = new NewProjectWindow(_api) { Owner = this };
            if (dialog.ShowDialog() == true && dialog.CreatedProject is not null)
            {
                _projects.Insert(0, dialog.CreatedProject);
                next = dialog.CreatedProject;
            }
        }
        if (next is not null) ProjectSelector.SelectedItem = next;
        else { CurrentProjectName.Text = "尚未创建项目"; CurrentProjectMeta.Text = "点击“新建项目”开始"; _shots.Clear(); }
    }

    private async Task SelectProjectAsync(StudioProject project)
    {
        _api.SelectProject(project.Id);
        CurrentProjectName.Text = project.Name;
        CurrentProjectMeta.Text = project.Summary;
        ActiveProjectText.Text = project.Name + "⌄";
        WorkspaceTitle.Text = $"剪辑工作台 · {project.Name}";
        var shots = await _api.GetShotsAsync();
        var summary = await _api.GetProjectSummaryAsync();
        _shots.Clear();
        foreach (var shot in shots) _shots.Add(shot);
        EpisodeList.Items.Clear();
        for (var episode = 1; episode <= project.EpisodeCount; episode++)
            EpisodeList.Items.Add(new ListBoxItem { Content = $"第 {episode} 集", IsSelected = episode == 1 });
        CharacterCountText.Text = summary.Characters.ToString();
        SceneCountText.Text = summary.Scenes.ToString();
        PropCountText.Text = summary.Props.ToString();
        ShotCountText.Text = summary.Shots.ToString();
        EmptyShotsText.Visibility = _shots.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void Workspace_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string key }) return;
        WorkspaceTitle.Text = key switch
        {
            "director" => "导演工作台 · 第1集 雪夜杀局",
            "storyboard" => "分镜工作台 · 第1集 雪夜杀局",
            "generation" => "视频生成中心 · 第1集 雪夜杀局",
            "assets" => $"资产管理 · {CurrentProjectName.Text}",
            "tasks" => "任务队列 · 生成与渲染",
            _ => "剪辑工作台 · 第1集 雪夜杀局"
        };
        if (key is "director" or "storyboard")
        {
            var project = ProjectSelector.SelectedItem as StudioProject;
            if (project is null) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
            if (key == "director") new ScriptWorkbenchWindow(_api, project) { Owner = this }.ShowDialog();
            else new StoryboardWindow(_api, project) { Owner = this }.ShowDialog();
            await SelectProjectAsync(project);
            return;
        }
        if (key == "tasks")
        {
            if (string.IsNullOrWhiteSpace(_api.CurrentProjectId)) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
            var window = new TaskQueueWindow(_api) { Owner = this };
            window.ShowDialog();
            await CheckServiceAsync();
        }
    }

    private async void TopNav_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string title }) return;
        WorkspaceTitle.Text = $"{title} · {CurrentProjectName.Text}";
        if (title is not ("剧本" or "分镜")) return;
        if (ProjectSelector.SelectedItem is not StudioProject project) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
        if (title == "剧本") new ScriptWorkbenchWindow(_api, project) { Owner = this }.ShowDialog();
        else new StoryboardWindow(_api, project) { Owner = this }.ShowDialog();
        await SelectProjectAsync(project);
    }

    private void EpisodeList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (WorkspaceTitle is null) return;
        if (EpisodeList.SelectedItem is ListBoxItem item)
            WorkspaceTitle.Text = $"剪辑工作台 · {item.Content?.ToString()?.Trim()}";
    }

    private void GenerateTransition_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_api.CurrentProjectId)) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
        new TransitionRenderWindow(_api) { Owner = this }.ShowDialog();
    }

    private async void ProjectSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ProjectSelector.SelectedItem is not StudioProject project) return;
        try { await SelectProjectAsync(project); }
        catch (Exception ex) { ServiceText.Text = $"项目读取失败：{ex.Message}"; }
    }

    private async void NewProject_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new NewProjectWindow(_api) { Owner = this };
        if (dialog.ShowDialog() == true) await LoadProjectsAsync();
    }

    private void ProviderSettings_Click(object sender, RoutedEventArgs e) => new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog();

    private async void RefreshProject_Click(object sender, RoutedEventArgs e)
    {
        if (ProjectSelector.SelectedItem is StudioProject project) await SelectProjectAsync(project);
    }
}
