using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class StoryboardWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private readonly ObservableCollection<Shot> _shots = [];
    private readonly ObservableCollection<SceneFilterItem> _sceneFilters = [];
    private ICollectionView? _shotView;

    public StoryboardWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent();
        _api = api;
        _project = project;
        ProjectNameText.Text = $"· {project.Name}";
        ShotGrid.ItemsSource = _shots;
        SceneFilterList.ItemsSource = _sceneFilters;
        Loaded += async (_, _) => await LoadAsync();
    }

    private sealed record SceneFilterItem(string Key, string Label)
    {
        public override string ToString() => Label;
    }

    private static string CleanDisplayText(string? value)
    {
        var text = (value ?? "").Trim();
        if (Regex.IsMatch(text, @"^\s*(?:---+|___+|\*\*\*+)\s*$")) return "";
        text = Regex.Replace(text, @"```(?:\w+)?|```", "");
        text = text.Replace("**", "").Replace("__", "").Replace("`", "");
        text = Regex.Replace(text, @"^\s*[#>\-*]+\s*", "");
        text = Regex.Replace(text, @"^\s*[\[\(（]?(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[-–—~至]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[\]\)）]?\s*", "");
        text = Regex.Replace(text, @"^\s*(?:画面|细节|动作|环境|人物|镜头|说明)\s*[:：]\s*", "", RegexOptions.IgnoreCase);
        return Regex.Replace(text, @"\s+", " ").Trim();
    }

    private static bool IsDisplayable(Shot shot) =>
        !string.IsNullOrWhiteSpace(shot.Title) || !string.IsNullOrWhiteSpace(shot.Description) ||
        !string.IsNullOrWhiteSpace(shot.Action) || !string.IsNullOrWhiteSpace(shot.Dialogue);

    private void ApplyFilter()
    {
        if (_shotView is null) return;
        var scene = (SceneFilterList.SelectedItem as SceneFilterItem)?.Key ?? "*";
        var query = (SearchBox.Text ?? "").Trim();
        _shotView.Filter = item =>
        {
            if (item is not Shot shot || !IsDisplayable(shot)) return false;
            if (scene != "*" && !string.Equals(shot.SceneName, scene, StringComparison.OrdinalIgnoreCase)) return false;
            if (string.IsNullOrWhiteSpace(query)) return true;
            var searchable = string.Join(" ", shot.Number, shot.SceneName, shot.Title, shot.Description, shot.Action, shot.Dialogue, shot.CharacterText);
            return searchable.Contains(query, StringComparison.OrdinalIgnoreCase);
        };
        _shotView.Refresh();
        ShotSummaryText.Text = $"当前显示 {_shotView.Cast<object>().Count()} / {_shots.Count(IsDisplayable)} 个镜头";
        if (ShotGrid.SelectedItem is null) ShotGrid.SelectedItem = _shotView.Cast<object>().FirstOrDefault();
    }

    private async Task LoadAsync()
    {
        try
        {
            var shots = await _api.GetShotsAsync();
            _shots.Clear();
            foreach (var shot in shots)
            {
                shot.Title = CleanDisplayText(shot.Title);
                shot.Description = CleanDisplayText(shot.Description);
                shot.Action = CleanDisplayText(shot.Action);
                shot.Dialogue = CleanDisplayText(shot.Dialogue);
                _shots.Add(shot);
            }
            _shotView = CollectionViewSource.GetDefaultView(_shots);
            _sceneFilters.Clear();
            _sceneFilters.Add(new SceneFilterItem("*", $"全部镜头  {_shots.Count(IsDisplayable)}"));
            foreach (var group in _shots.Where(IsDisplayable).GroupBy(item => item.SceneName))
                _sceneFilters.Add(new SceneFilterItem(group.Key, $"{group.Key}  {group.Count()}"));
            SceneFilterList.SelectedIndex = 0;
            ApplyFilter();
            StatusText.Text = _shots.Count == 0 ? "尚无分镜。请先在剧本工作台保存、解析并生成全量分镜。" : "分镜已按场次整理；Markdown、时间码和分隔线仅做展示清洗，点击“保存修改”后写回项目。";
        }
        catch (Exception ex) { StatusText.Text = $"加载失败：{ex.Message}"; }
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();

    private void SearchBox_TextChanged(object sender, TextChangedEventArgs e) => ApplyFilter();

    private void SceneFilter_SelectionChanged(object sender, SelectionChangedEventArgs e) => ApplyFilter();

    private void ShotGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var selected = ShotGrid.SelectedItem is Shot;
        NoSelectionText.Visibility = selected ? Visibility.Collapsed : Visibility.Visible;
        InspectorFields.IsEnabled = selected;
        ContinuityFields.IsEnabled = selected;
        PromptFields.IsEnabled = selected;
    }

    private void Previz_Click(object sender, RoutedEventArgs e) => new PrevizWindow(_api) { Owner = this }.ShowDialog();
    private void Continuity_Click(object sender, RoutedEventArgs e) => new ContinuityWindow(_api) { Owner = this }.ShowDialog();

    private async void SaveAll_Click(object sender, RoutedEventArgs e)
    {
        ShotGrid.CommitEdit();
        ShotGrid.CommitEdit();
        try
        {
            StatusText.Text = $"正在保存 {_shots.Count} 个镜头…";
            foreach (var shot in _shots) await _api.UpdateShotAsync(shot);
            var proofread = await _api.ProofreadAsync();
            StatusText.Text = proofread.StateConflicts == 0
                ? $"已保存 {_shots.Count} 个镜头，故事状态图重新计算通过。"
                : $"已保存；状态图仍有 {proofread.StateConflicts} 个阻断项，请打开“连续性审校”定位。";
        }
        catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; }
    }
}
