using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class ProviderSettingsWindow : Window
{
    private readonly StudioApiClient _api;
    private IReadOnlyList<ProviderConfigStatus> _statuses = [];

    public ProviderSettingsWindow(StudioApiClient api) { InitializeComponent(); _api = api; Loaded += async (_, _) => await ReloadAsync(); }

    private string SelectedProvider => (Provider.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "openai";

    private async Task ReloadAsync()
    {
        try { _statuses = await _api.GetProviderConfigsAsync(); Provider.SelectedIndex = Provider.SelectedIndex < 0 ? 0 : Provider.SelectedIndex; ApplySelection(); }
        catch (Exception ex) { Feedback.Text = $"读取配置失败：{ex.Message}"; }
    }

    private void ApplySelection()
    {
        var item = _statuses.FirstOrDefault(x => x.ProviderId == SelectedProvider);
        if (item is null) return;
        BaseUrl.Text = item.BaseUrl; Model.Text = item.Model;
        Status.Text = item.Configured ? $"已连接配置 · {item.CredentialSource}" : "未配置";
        Status.Foreground = item.Configured ? System.Windows.Media.Brushes.LightGreen : System.Windows.Media.Brushes.Orange;
    }

    private void Provider_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) ApplySelection(); }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(BaseUrl.Text) || string.IsNullOrWhiteSpace(Model.Text)) { Feedback.Text = "Base URL 和模型不能为空"; return; }
        SaveButton.IsEnabled = false;
        try { await _api.SaveProviderConfigAsync(SelectedProvider, BaseUrl.Text.Trim(), Model.Text.Trim(), ApiKey.Password); ApiKey.Clear(); Feedback.Text = "已使用 Windows 加密保存"; await ReloadAsync(); }
        catch (Exception ex) { Feedback.Text = $"保存失败：{ex.Message}"; }
        finally { SaveButton.IsEnabled = true; }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
