using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class ProviderSettingsWindow : Window
{
    private readonly StudioApiClient _api;
    private IReadOnlyList<ProviderConfigStatus> _statuses = [];
    private IReadOnlyList<ModelRoleBinding> _roles = [];
    private bool _loading;

    public ProviderSettingsWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await ReloadAsync();
    }

    private ProviderConfigStatus? SelectedProvider => Provider.SelectedItem as ProviderConfigStatus;
    private ModelRoleBinding? SelectedRole => RoleList.SelectedItem as ModelRoleBinding;

    private async Task ReloadAsync(string? providerId = null, string? roleId = null)
    {
        _loading = true;
        try
        {
            var statusesTask = _api.GetProviderConfigsAsync();
            var rolesTask = _api.GetModelRolesAsync();
            await Task.WhenAll(statusesTask, rolesTask);
            _statuses = statusesTask.Result;
            _roles = rolesTask.Result;
            Provider.ItemsSource = _statuses;
            Provider.SelectedItem = _statuses.FirstOrDefault(x => x.ProviderId == providerId) ?? _statuses.FirstOrDefault();
            RoleList.ItemsSource = _roles;
            RoleList.SelectedItem = _roles.FirstOrDefault(x => x.Id == roleId) ?? _roles.FirstOrDefault();
            ApplyProviderSelection();
            ApplyRoleSelection();
        }
        catch (Exception ex) { Feedback.Text = $"读取配置失败：{ex.Message}"; }
        finally { _loading = false; }
    }

    private void ApplyProviderSelection()
    {
        var item = SelectedProvider;
        if (item is null) return;
        BaseUrl.Text = item.BaseUrl;
        Model.ItemsSource = null;
        Model.Text = item.Model;
        Status.Text = item.Configured ? $"已连接\n{item.CredentialSource}" : "未配置";
        Status.Foreground = item.Configured ? System.Windows.Media.Brushes.LightGreen : System.Windows.Media.Brushes.Orange;
        Feedback.Text = "";
    }

    private void ApplyRoleSelection()
    {
        var role = SelectedRole;
        if (role is null) return;
        RoleName.Text = role.Name;
        RoleDescription.Text = role.Description;
        RoleRequirement.Text = $"所需能力：{role.Capability} · 当前：{role.BindingLabel}";
        var candidates = _statuses.Where(x => x.Capabilities.Contains(role.Capability)).ToList();
        RoleProvider.ItemsSource = candidates;
        RoleProvider.SelectedItem = candidates.FirstOrDefault(x => x.ProviderId == role.ProviderId) ?? candidates.FirstOrDefault(x => x.Configured) ?? candidates.FirstOrDefault();
        RoleModel.ItemsSource = null;
        RoleModel.Text = role.Model;
        RoleFeedback.Text = role.Available ? "当前绑定可用" : string.IsNullOrWhiteSpace(role.ProviderId) ? "请选择服务商并绑定具体模型" : "绑定已保存，但服务商密钥尚未配置";
    }

    private void Provider_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded && !_loading) ApplyProviderSelection(); }
    private void RoleList_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded && !_loading) ApplyRoleSelection(); }
    private void RoleProvider_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || RoleProvider.SelectedItem is not ProviderConfigStatus provider) return;
        RoleModel.ItemsSource = null;
        if (SelectedRole?.ProviderId == provider.ProviderId) RoleModel.Text = SelectedRole.Model;
        else RoleModel.Text = provider.Model;
    }

    private async Task FetchAsync(ComboBox target, string providerId, string? capability, TextBlock feedback)
    {
        var current = target.Text;
        var result = await _api.GetProviderModelsAsync(providerId, capability);
        target.ItemsSource = result.Models;
        if (!string.IsNullOrWhiteSpace(current)) target.Text = current;
        else if (result.Models.Count > 0) target.SelectedIndex = 0;
        var source = result.Source == "remote" ? "服务商实时返回" : "内置兼容目录";
        feedback.Text = $"{source} · {result.Models.Count} 个模型" + (string.IsNullOrWhiteSpace(result.Warning) ? "" : $"\n{result.Warning}");
    }

    private async void FetchModels_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedProvider is null) return;
        FetchButton.IsEnabled = false;
        try { await FetchAsync(Model, SelectedProvider.ProviderId, null, Feedback); }
        catch (Exception ex) { Feedback.Text = $"拉取失败：{ex.Message}"; }
        finally { FetchButton.IsEnabled = true; }
    }

    private async void FetchRoleModels_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedRole is null || RoleProvider.SelectedItem is not ProviderConfigStatus provider) return;
        FetchRoleButton.IsEnabled = false;
        try { await FetchAsync(RoleModel, provider.ProviderId, SelectedRole.Capability, RoleFeedback); }
        catch (Exception ex) { RoleFeedback.Text = $"拉取失败：{ex.Message}"; }
        finally { FetchRoleButton.IsEnabled = true; }
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedProvider is null || string.IsNullOrWhiteSpace(BaseUrl.Text) || string.IsNullOrWhiteSpace(Model.Text)) { Feedback.Text = "Base URL 和默认模型不能为空"; return; }
        SaveButton.IsEnabled = false;
        try
        {
            var id = SelectedProvider.ProviderId;
            await _api.SaveProviderConfigAsync(id, BaseUrl.Text.Trim(), Model.Text.Trim(), ApiKey.Password);
            ApiKey.Clear();
            await ReloadAsync(id, SelectedRole?.Id);
            Feedback.Text = "已使用 Windows 加密保存";
        }
        catch (Exception ex) { Feedback.Text = $"保存失败：{ex.Message}"; }
        finally { SaveButton.IsEnabled = true; }
    }

    private async void BindRole_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedRole is null || RoleProvider.SelectedItem is not ProviderConfigStatus provider || string.IsNullOrWhiteSpace(RoleModel.Text)) { RoleFeedback.Text = "请选择服务商和具体模型"; return; }
        BindRoleButton.IsEnabled = false;
        try
        {
            var roleId = SelectedRole.Id;
            await _api.SaveModelRoleAsync(roleId, provider.ProviderId, RoleModel.Text.Trim());
            await ReloadAsync(SelectedProvider?.ProviderId, roleId);
            RoleFeedback.Text = "岗位绑定已保存，相关功能将使用该模型";
        }
        catch (Exception ex) { RoleFeedback.Text = $"绑定失败：{ex.Message}"; }
        finally { BindRoleButton.IsEnabled = true; }
    }

    private async void ClearRole_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedRole is null) return;
        ClearRoleButton.IsEnabled = false;
        try
        {
            var roleId = SelectedRole.Id;
            await _api.DeleteModelRoleAsync(roleId);
            await ReloadAsync(SelectedProvider?.ProviderId, roleId);
            RoleFeedback.Text = "岗位绑定已清除";
        }
        catch (Exception ex) { RoleFeedback.Text = $"清除失败：{ex.Message}"; }
        finally { ClearRoleButton.IsEnabled = true; }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
