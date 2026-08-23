using System.Collections.ObjectModel;
using System.Windows;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class StoryboardWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private readonly ObservableCollection<Shot> _shots = [];

    public StoryboardWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent();
        _api = api;
        _project = project;
        ProjectNameText.Text = $"· {project.Name}";
        ShotGrid.ItemsSource = _shots;
        Loaded += async (_, _) => await LoadAsync();
    }

    private async Task LoadAsync()
    {
        try
        {
            var shots = await _api.GetShotsAsync();
            _shots.Clear();
            foreach (var shot in shots) _shots.Add(shot);
            StatusText.Text = _shots.Count == 0 ? "尚无分镜。请先在剧本工作台保存、解析并生成全量分镜。" : $"已加载 {_shots.Count} 个镜头；表格中的修改可保存回项目。";
        }
        catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; }
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();

    private async void SaveAll_Click(object sender, RoutedEventArgs e)
    {
        ShotGrid.CommitEdit();
        ShotGrid.CommitEdit();
        try
        {
            StatusText.Text = $"正在保存 {_shots.Count} 个镜头…";
            foreach (var shot in _shots) await _api.UpdateShotAsync(shot);
            StatusText.Text = $"已保存 {_shots.Count} 个镜头。关闭再打开仍会保留。";
        }
        catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; }
    }
}
