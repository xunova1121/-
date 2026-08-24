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
    private string _activeWorkspaceKey = "home";

    public MainWindow()
    {
        InitializeComponent();
        ShotList.ItemsSource = _shots;
        ProjectSelector.ItemsSource = _projects;
        Loaded += async (_, _) => await InitializeWorkspaceAsync();
    }

    private Style NavStyle => (Style)FindResource("NavButton");
    private Style ActiveNavStyle => (Style)FindResource("ActiveNavButton");

    private static Button? TaggedButton(Panel panel, string tag) => panel.Children.OfType<Button>().FirstOrDefault(button => string.Equals(button.Tag?.ToString(), tag, StringComparison.OrdinalIgnoreCase));

    private void SetGroupActive(Panel panel, string? tag)
    {
        foreach (var button in panel.Children.OfType<Button>()) button.Style = NavStyle;
        var active = string.IsNullOrWhiteSpace(tag) ? null : TaggedButton(panel, tag);
        if (active is not null) active.Style = ActiveNavStyle;
    }

    private void ShowHome()
    {
        _activeWorkspaceKey = "home";
        HomeDashboard.Visibility = Visibility.Visible;
        WorkspaceShell.Visibility = Visibility.Collapsed;
        SetGroupActive(TopNavigation, "首页");
        SetGroupActive(WorkspaceNavigation, null);
    }

    private void ShowWorkspace(string key)
    {
        _activeWorkspaceKey = key;
        HomeDashboard.Visibility = Visibility.Collapsed;
        WorkspaceShell.Visibility = Visibility.Visible;
        SetGroupActive(WorkspaceNavigation, key);
        var top = key switch { "director" => "剧本", "storyboard" => "分镜", "editing" => "剪辑", "assets" => "项目", _ => "制作" };
        SetGroupActive(TopNavigation, top);
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
        HomeServiceText.Text = healthy ? "已连接" : "启动失败";
        HomeServiceText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(healthy ? "#57D98B" : "#F2B84B"));
        return healthy;
    }

    private async Task InitializeWorkspaceAsync()
    {
        if (!await CheckServiceAsync()) return;
        await LoadProjectsAsync(false);
        ShowHome();
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
        HomeProjectName.Text = project.Name;
        HomeProjectMeta.Text = project.Summary;
        HomeShotCount.Text = $"{summary.Shots} 镜";
        HomeBibleCount.Text = $"{summary.Characters + summary.Scenes + summary.Props} 项";
        HomeWelcomeText.Text = $"{project.Name} 已载入。按剧本 → 全量分镜 → 设定集 → AI生成 → 剪辑导出的顺序制作。";
        EmptyShotsText.Visibility = _shots.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void Workspace_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string key }) return;
        ShowWorkspace(key);
        WorkspaceTitle.Text = key switch
        {
            "director" => $"导演工作台 · {CurrentProjectName.Text}",
            "storyboard" => $"分镜工作台 · {CurrentProjectName.Text}",
            "generation" => $"视频生成中心 · {CurrentProjectName.Text}",
            "bible" => $"Story Bible · {CurrentProjectName.Text}",
            "automation" => $"一键自动生产 · {CurrentProjectName.Text}",
            "editing" => $"剪辑与导出 · {CurrentProjectName.Text}",
            "assets" => $"资产管理 · {CurrentProjectName.Text}",
            "tasks" => "任务队列 · 生成与渲染",
            _ => $"剪辑工作台 · {CurrentProjectName.Text}"
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
        if (key is "generation" or "editing" or "assets" or "bible" or "automation")
        {
            if (ProjectSelector.SelectedItem is not StudioProject) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
            var selected = (StudioProject)ProjectSelector.SelectedItem;
            if (key == "generation") new GenerationWindow(_api, selected) { Owner = this }.ShowDialog();
            else if (key == "editing") new EditingWindow(_api, selected) { Owner = this }.ShowDialog();
            else if (key == "assets") new AssetManagerWindow(_api, selected) { Owner = this }.ShowDialog();
            else if (key == "bible") new StoryBibleWindow(_api) { Owner = this }.ShowDialog();
            else new AutomationWindow(_api, selected) { Owner = this }.ShowDialog();
            if (ProjectSelector.SelectedItem is StudioProject active) await SelectProjectAsync(active);
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
        if (title == "首页") { ShowHome(); return; }
        if (title == "项目") { SetGroupActive(TopNavigation, "项目"); SetGroupActive(WorkspaceNavigation, null); new ProjectManagerWindow(_api) { Owner = this }.ShowDialog(); await LoadProjectsAsync(); ShowHome(); return; }
        if (ProjectSelector.SelectedItem is not StudioProject project) { MessageBox.Show("请先创建项目", "AI影视Studio"); return; }
        var key = title switch { "剧本" => "director", "分镜" => "storyboard", "制作" => "generation", "剪辑" => "editing", _ => "publish" };
        ShowWorkspace(key);
        WorkspaceTitle.Text = $"{title} · {CurrentProjectName.Text}";
        if (title == "剧本") new ScriptWorkbenchWindow(_api, project) { Owner = this }.ShowDialog();
        else if (title == "分镜") new StoryboardWindow(_api, project) { Owner = this }.ShowDialog();
        else if (title == "制作") new GenerationWindow(_api, project) { Owner = this }.ShowDialog();
        else if (title == "剪辑") new EditingWindow(_api, project) { Owner = this }.ShowDialog();
        else if (title == "发布") { SetGroupActive(TopNavigation, "发布"); SetGroupActive(WorkspaceNavigation, null); new PublishWindow(_api) { Owner = this }.ShowDialog(); }
        else return;
        await SelectProjectAsync(project);
    }

    private void EpisodeList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (WorkspaceTitle is null || _activeWorkspaceKey != "editing") return;
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

    private void ProviderSettings_Click(object sender, RoutedEventArgs e)
    {
        ModelSettingsButton.Style = ActiveNavStyle;
        try { new ProviderSettingsWindow(_api) { Owner = this }.ShowDialog(); }
        finally { ModelSettingsButton.Style = NavStyle; }
    }

    private async void ProjectManager_Click(object sender, RoutedEventArgs e)
    {
        SetGroupActive(TopNavigation, "项目");
        new ProjectManagerWindow(_api) { Owner = this }.ShowDialog();
        await LoadProjectsAsync();
        ShowHome();
    }

    private async void RefreshProject_Click(object sender, RoutedEventArgs e)
    {
        if (ProjectSelector.SelectedItem is StudioProject project) await SelectProjectAsync(project);
    }
}
