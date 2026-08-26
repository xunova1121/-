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
    private int _roleProviderChangeVersion;

    public ProviderSettingsWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await ReloadAsync();
    }

    private ProviderConfigStatus? SelectedProvider => Provider.SelectedItem as ProviderConfigStatus;
    private ModelRoleBinding? SelectedRole => RoleList.SelectedItem as ModelRoleBinding;

    private static string SelectedModelId(ComboBox combo) =>
        combo.SelectedItem is ProviderModelInfo model ? model.Id.Trim() : combo.Text.Trim();

    private static void SelectModel(ComboBox combo, IReadOnlyList<ProviderModelInfo> models, string? modelId)
    {
        combo.ItemsSource = models;
        var value = (modelId ?? "").Trim();
        var exact = models.FirstOrDefault(item => string.Equals(item.Id, value, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) combo.SelectedItem = exact;
        else if (!string.IsNullOrWhiteSpace(value)) combo.Text = value;
        else if (models.Count > 0) combo.SelectedIndex = 0;
        else combo.Text = "";
    }

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
        RoleFeedback.Text = role.Available ? $"✓ 已生效：{role.BindingLabel}" : string.IsNullOrWhiteSpace(role.ProviderId) ? "尚未绑定：请选择服务商，拉取候选模型后点击“绑定并保存”" : $"已保存 {role.BindingLabel}，但服务商密钥尚未配置";
        UpdateSelectedRoleSummary();
    }

    private void Provider_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded && !_loading) ApplyProviderSelection(); }
    private void RoleList_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded && !_loading) ApplyRoleSelection(); }
    private async void RoleProvider_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || RoleProvider.SelectedItem is not ProviderConfigStatus provider) return;
        var changeVersion = ++_roleProviderChangeVersion;
        RoleModel.ItemsSource = null;
        var savedModel = SelectedRole?.ProviderId == provider.ProviderId ? SelectedRole.Model : provider.Model;
        RoleModel.Text = savedModel;
        RoleFeedback.Text = $"已选择 {provider.Name}；正在读取该服务商可用于“{SelectedRole?.Name}”的模型…";
        UpdateSelectedRoleSummary();
        if (SelectedRole is null) return;
        try
        {
            var result = await _api.GetProviderModelsAsync(provider.ProviderId, SelectedRole.Capability);
            if (changeVersion != _roleProviderChangeVersion || (RoleProvider.SelectedItem as ProviderConfigStatus)?.ProviderId != provider.ProviderId) return;
            SelectModel(RoleModel, result.Models, savedModel);
            var source = result.Source == "remote" ? "服务商实时返回" : "内置兼容目录";
            RoleFeedback.Text = $"已选择 {provider.Name} · {source} · {result.Models.Count} 个候选模型" + (string.IsNullOrWhiteSpace(result.Warning) ? "" : $"\n{result.Warning}");
            UpdateSelectedRoleSummary();
        }
        catch (Exception ex)
        {
            RoleFeedback.Text = $"{provider.Name} 模型读取失败：{ex.Message}。仍可手动输入模型 ID 后绑定。";
        }
    }

    private void RoleModel_SelectionChanged(object sender, SelectionChangedEventArgs e) => UpdateSelectedRoleSummary();
    private void RoleModel_DropDownClosed(object? sender, EventArgs e) => UpdateSelectedRoleSummary();
    private void RoleModel_KeyUp(object sender, System.Windows.Input.KeyEventArgs e) => UpdateSelectedRoleSummary();

    private void UpdateSelectedRoleSummary()
    {
        if (SelectedRole is null)
        {
            SelectedRoleSummary.Text = "当前选择：尚未选择岗位";
            BindRoleButton.IsEnabled = false;
            ClearRoleButton.IsEnabled = false;
            return;
        }
        var provider = RoleProvider.SelectedItem as ProviderConfigStatus;
        var modelId = SelectedModelId(RoleModel);
        SelectedRoleSummary.Text = string.IsNullOrWhiteSpace(modelId)
            ? $"准备绑定：{SelectedRole.Name} → 请先拉取并选择模型"
            : $"准备绑定：{SelectedRole.Name} → {provider?.Name ?? "未选择服务商"} / {modelId}";
        BindRoleButton.IsEnabled = provider is not null && !string.IsNullOrWhiteSpace(modelId);
        ClearRoleButton.IsEnabled = !string.IsNullOrWhiteSpace(SelectedRole.ProviderId);
    }

    private async Task FetchAsync(ComboBox target, string providerId, string? capability, TextBlock feedback)
    {
        var current = SelectedModelId(target);
        var result = await _api.GetProviderModelsAsync(providerId, capability);
        SelectModel(target, result.Models, current);
        var source = result.Source == "remote" ? "服务商实时返回" : "内置兼容目录";
        var selected = SelectedModelId(target);
        feedback.Text = $"{source} · {result.Models.Count} 个模型" + (string.IsNullOrWhiteSpace(selected) ? "" : $" · 已选择 {selected}") + (string.IsNullOrWhiteSpace(result.Warning) ? "" : $"\n{result.Warning}");
        if (ReferenceEquals(target, RoleModel)) UpdateSelectedRoleSummary();
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
        var modelId = SelectedModelId(Model);
        if (SelectedProvider is null || string.IsNullOrWhiteSpace(BaseUrl.Text) || string.IsNullOrWhiteSpace(modelId)) { Feedback.Text = "Base URL 和默认模型不能为空"; return; }
        SaveButton.IsEnabled = false;
        try
        {
            var id = SelectedProvider.ProviderId;
            await _api.SaveProviderConfigAsync(id, BaseUrl.Text.Trim(), modelId, ApiKey.Password);
            ApiKey.Clear();
            await ReloadAsync(id, SelectedRole?.Id);
            Feedback.Text = "已使用 Windows 加密保存";
        }
        catch (Exception ex) { Feedback.Text = $"保存失败：{ex.Message}"; }
        finally { SaveButton.IsEnabled = true; }
    }

    private async void BindRole_Click(object sender, RoutedEventArgs e)
    {
        var modelId = SelectedModelId(RoleModel);
        if (SelectedRole is null || RoleProvider.SelectedItem is not ProviderConfigStatus provider || string.IsNullOrWhiteSpace(modelId)) { RoleFeedback.Text = "请选择服务商和具体模型"; return; }
        BindRoleButton.IsEnabled = false;
        try
        {
            var roleId = SelectedRole.Id;
            await _api.SaveModelRoleAsync(roleId, provider.ProviderId, modelId);
            await ReloadAsync(SelectedProvider?.ProviderId, roleId);
            RoleFeedback.Text = $"✓ 绑定成功：{SelectedRole?.Name} → {provider.Name} / {modelId}。相关功能立即按此路由执行。";
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