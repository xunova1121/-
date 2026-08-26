using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class ProviderSettingsWindow : Window
{
    private readonly StudioApiClient _api;
    private IReadOnlyList<ProviderConfigStatus> _statuses = [];
    private IReadOnlyList<ModelRoute> _routes = [];
    public ProviderSettingsWindow(StudioApiClient api) { InitializeComponent(); _api = api; Loaded += async (_, _) => await ReloadAsync(); }
    private string SelectedProvider => (Provider.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "openai";
    private async Task ReloadAsync()
    {
        try { _statuses = await _api.GetProviderConfigsAsync(); _routes = await _api.GetModelRoutesAsync(); Provider.SelectedIndex = Provider.SelectedIndex < 0 ? 0 : Provider.SelectedIndex; Role.ItemsSource = _routes; RouteList.ItemsSource = _routes; if (Role.SelectedIndex < 0) Role.SelectedIndex = 0; ApplySelection(); ApplyRole(); }
        catch (Exception ex) { Feedback.Text = $"读取配置失败：{ex.Message}"; }
    }
    private void ApplySelection() { var item = _statuses.FirstOrDefault(x => x.ProviderId == SelectedProvider); if (item is null) return; BaseUrl.Text = item.BaseUrl; Model.Text = item.Model; Status.Text = item.Configured ? $"● 已保存 · {item.CredentialSource}" : "● 尚未保存密钥"; }
    private void ApplyRole() { if (Role.SelectedItem is ModelRoute route) { RolePurpose.Text = route.Purpose; if (!string.IsNullOrWhiteSpace(route.Model)) AvailableModels.Text = route.Model; } }
    private void Provider_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) ApplySelection(); }
    private void Role_SelectionChanged(object sender, SelectionChangedEventArgs e) => ApplyRole();
    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(BaseUrl.Text) || string.IsNullOrWhiteSpace(Model.Text)) { Feedback.Text = "Base URL 和默认模型不能为空"; return; }
        SaveButton.IsEnabled = false;
        try { await _api.SaveProviderConfigAsync(SelectedProvider, BaseUrl.Text.Trim(), Model.Text.Trim(), ApiKey.Password); ApiKey.Clear(); Feedback.Text = "连接已加密保存，现在可以拉取模型。"; await ReloadAsync(); }
        catch (Exception ex) { Feedback.Text = $"保存失败：{ex.Message}"; } finally { SaveButton.IsEnabled = true; }
    }
    private async void FetchModels_Click(object sender, RoutedEventArgs e)
    {
        FetchButton.IsEnabled = false;
        try { var models = await _api.FetchProviderModelsAsync(SelectedProvider); AvailableModels.ItemsSource = models; AvailableModels.SelectedItem = models.FirstOrDefault(item => item == Model.Text) ?? models.FirstOrDefault(); Feedback.Text = $"已取得 {models.Count} 个可用模型。文本模型可绑定右侧岗位；视频模型在视频生成中心直接选择。"; }
        catch (Exception ex) { Feedback.Text = $"拉取失败：{ex.Message}"; } finally { FetchButton.IsEnabled = true; }
    }
    private async void Bind_Click(object sender, RoutedEventArgs e)
    {
        if (Role.SelectedItem is not ModelRoute role) { RouteFeedback.Text = "请先选择制作岗位"; return; }
        var model = AvailableModels.Text.Trim(); if (string.IsNullOrWhiteSpace(model)) { RouteFeedback.Text = "请先拉取并选择模型"; return; }
        BindButton.IsEnabled = false;
        try { await _api.SaveModelRouteAsync(role.Role, SelectedProvider, model); RouteFeedback.Text = $"已确认：{role.Name} → {SelectedProvider} / {model}"; await ReloadAsync(); }
        catch (Exception ex) { RouteFeedback.Text = $"绑定失败：{ex.Message}"; } finally { BindButton.IsEnabled = true; }
    }
    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
