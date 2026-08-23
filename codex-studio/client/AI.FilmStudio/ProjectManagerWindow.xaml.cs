using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class ProjectManagerWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<StudioProject> _projects = [];
    public ProjectManagerWindow(StudioApiClient api) { InitializeComponent(); _api = api; ProjectList.ItemsSource = _projects; Loaded += async (_, _) => await LoadAsync(); }
    private async Task LoadAsync() { try { var items = await _api.GetProjectsAsync(); _projects.Clear(); foreach (var item in items.Where(x => x.Id != "demo")) _projects.Add(item); ProjectList.SelectedItem = _projects.FirstOrDefault(x => x.Id == _api.CurrentProjectId) ?? _projects.FirstOrDefault(); StatusText.Text = $"共 {_projects.Count} 个真实工程"; } catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; } }
    private void ProjectList_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (ProjectList.SelectedItem is not StudioProject item) return; ProjectName.Text = item.Name; Genre.Text = item.Genre; EpisodeCount.Text = item.EpisodeCount.ToString(); Feedback.Text = item.Id == _api.CurrentProjectId ? "当前正在使用此工程" : ""; }
    private async void New_Click(object sender, RoutedEventArgs e) { var dialog = new NewProjectWindow(_api) { Owner = this }; if (dialog.ShowDialog() == true) await LoadAsync(); }
    private async void Save_Click(object sender, RoutedEventArgs e) { try { if (ProjectList.SelectedItem is not StudioProject item) throw new InvalidOperationException("请先选择项目"); if (!int.TryParse(EpisodeCount.Text, out var count) || count < 1) throw new InvalidOperationException("计划集数必须是正整数"); var saved = await _api.UpdateProjectAsync(item.Id, ProjectName.Text.Trim(), Genre.Text.Trim(), count); var index = _projects.IndexOf(item); _projects[index] = saved; ProjectList.SelectedItem = saved; Feedback.Text = "工程信息已保存"; } catch (Exception ex) { Feedback.Text = $"保存失败：{ex.Message}"; } }
    private void Select_Click(object sender, RoutedEventArgs e) { if (ProjectList.SelectedItem is not StudioProject item) return; _api.SelectProject(item.Id); DialogResult = true; }
    private async void Delete_Click(object sender, RoutedEventArgs e) { if (ProjectList.SelectedItem is not StudioProject item) return; if (MessageBox.Show($"确认移除工程“{item.Name}”？\n\n数据库记录将删除，磁盘媒体文件会保留以便恢复。", "移除工程", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return; try { await _api.DeleteProjectAsync(item.Id); await LoadAsync(); Feedback.Text = "工程已移除，媒体文件仍保留在本机。"; } catch (Exception ex) { Feedback.Text = $"移除失败：{ex.Message}"; } }
}
