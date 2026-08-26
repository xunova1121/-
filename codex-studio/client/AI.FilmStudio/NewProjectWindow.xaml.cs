using System.Windows;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class NewProjectWindow : Window
{
    private readonly StudioApiClient _api;
    public StudioProject? CreatedProject { get; private set; }

    public NewProjectWindow(StudioApiClient api) { InitializeComponent(); _api = api; }

    private async void Create_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(ProjectName.Text)) { Feedback.Text = "请输入项目名称"; return; }
        if (!int.TryParse(EpisodeCount.Text, out var count) || count is < 1 or > 999) { Feedback.Text = "集数必须是 1 到 999"; return; }
        CreateButton.IsEnabled = false;
        try
        {
            CreatedProject = await _api.CreateProjectAsync(ProjectName.Text.Trim(), Genre.Text.Trim(), count);
            DialogResult = true;
        }
        catch (Exception ex) { Feedback.Text = $"创建失败：{ex.Message}"; CreateButton.IsEnabled = true; }
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) { DialogResult = false; }
}
