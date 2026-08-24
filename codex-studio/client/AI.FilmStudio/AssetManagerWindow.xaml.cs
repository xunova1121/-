using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class AssetManagerWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<AssetItem> _assets = [];
    private readonly ObservableCollection<ReferenceBoard> _boards = [];

    public AssetManagerWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent();
        _api = api;
        ProjectText.Text = $"· {project.Name}";
        AssetGrid.ItemsSource = _assets;
        EntityList.ItemsSource = _boards;
        Loaded += async (_, _) => await LoadAsync();
    }

    private string Filter => (TypeFilter.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private ReferenceBoard? Board => EntityList.SelectedItem as ReferenceBoard;
    private static string Role(ComboBox combo) => (combo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "front";

    private async Task LoadAsync()
    {
        var selectedKey = Board?.EntityKey;
        try
        {
            var boards = await _api.GetReferenceBoardsAsync();
            _boards.Clear();
            foreach (var item in boards) _boards.Add(item);
            EntityList.SelectedItem = _boards.FirstOrDefault(item => item.EntityKey == selectedKey) ?? _boards.FirstOrDefault();
            await LoadAssetsAsync();
            StatusText.Text = _boards.Count == 0 ? "请先在剧本工作台解析剧本并建立 Story Bible。" : $"共 {_boards.Count} 个设定对象；批准版本会写入分镜锁定快照。";
        }
        catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; }
    }

    private async Task LoadAssetsAsync()
    {
        var items = await _api.GetAssetsAsync(string.IsNullOrWhiteSpace(Filter) ? null : Filter);
        _assets.Clear();
        foreach (var item in items) _assets.Add(item);
    }

    private void ShowBoard()
    {
        var board = Board;
        CandidateList.ItemsSource = board?.Assets;
        ImportViewButton.IsEnabled = board is not null;
        ApproveButton.IsEnabled = board?.ReadyToApprove == true;
        RevokeButton.IsEnabled = board?.Status is "approved" or "stale";
        if (board is null)
        {
            BoardTitle.Text = "2. 选择左侧对象";
            RequirementText.Text = "人物需正面、侧面、全身；场景需全景、反向；道具需正面、细节。";
            ApprovalStatusText.Text = "尚未选择";
            return;
        }
        BoardTitle.Text = $"2. {board.TypeText} · {board.Name} · Bible V{board.BibleVersion}";
        RequirementText.Text = $"必需视图：{board.RequiredText}。同一视图的旧候选会保留，批准时采用最新候选。";
        ApprovalStatusText.Text = $"{board.StatusText} · {board.IssueText}";
        ApprovalStatusText.Foreground = new System.Windows.Media.SolidColorBrush((System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(board.Status == "approved" ? "#75E6A4" : "#FFD166"));
    }

    private void EntityList_SelectionChanged(object sender, SelectionChangedEventArgs e) => ShowBoard();
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private async void TypeFilter_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await LoadAssetsAsync(); }

    private void ReferenceMode_Click(object sender, RoutedEventArgs e)
    {
        ReferencePanel.Visibility = Visibility.Visible; AllAssetsPanel.Visibility = Visibility.Collapsed;
        ReferenceModeButton.Style = (Style)FindResource("ActiveNavButton"); AllAssetsModeButton.Style = (Style)FindResource("NavButton");
    }

    private void AllAssetsMode_Click(object sender, RoutedEventArgs e)
    {
        ReferencePanel.Visibility = Visibility.Collapsed; AllAssetsPanel.Visibility = Visibility.Visible;
        ReferenceModeButton.Style = (Style)FindResource("NavButton"); AllAssetsModeButton.Style = (Style)FindResource("ActiveNavButton");
    }

    private async void ImportView_Click(object sender, RoutedEventArgs e)
    {
        if (Board is not { } board) return;
        var dialog = new OpenFileDialog { Multiselect = true, Filter = "参考图片|*.png;*.jpg;*.jpeg;*.webp;*.bmp" };
        if (dialog.ShowDialog(this) != true) return;
        try
        {
            var assetType = board.EntityType == "location" ? "scene" : board.EntityType;
            foreach (var path in dialog.FileNames)
                await _api.ImportAssetAsync(path, assetType, Path.GetFileNameWithoutExtension(path), entityType: board.EntityType, entityKey: board.EntityKey, viewRole: Role(ViewRole));
            await LoadAsync();
            StatusText.Text = $"已导入 {dialog.FileNames.Length} 个“{(ViewRole.SelectedItem as ComboBoxItem)?.Content}”候选；补齐必需视图后即可批准。";
        }
        catch (Exception ex) { StatusText.Text = $"导入失败：{ex.Message}"; }
    }

    private async void Approve_Click(object sender, RoutedEventArgs e)
    {
        if (Board is not { } board) return;
        try
        {
            var selected = CandidateList.SelectedItems.Cast<AssetItem>().Select(item => item.Id).ToList();
            var result = await _api.ApproveReferenceBoardAsync(board.EntityType, board.EntityKey, selected);
            await LoadAsync();
            StatusText.Text = $"已批准“{result.Name}”多视图资产 R{result.Revision}；分镜需重新锁定后才能进入正式生产。";
        }
        catch (Exception ex) { StatusText.Text = $"批准失败：{ex.Message}"; }
    }

    private async void Revoke_Click(object sender, RoutedEventArgs e)
    {
        if (Board is not { } board) return;
        try { await _api.RevokeReferenceBoardAsync(board.EntityType, board.EntityKey); await LoadAsync(); StatusText.Text = $"已撤销“{board.Name}”批准版本；正式生产已被阻断。"; }
        catch (Exception ex) { StatusText.Text = $"撤销失败：{ex.Message}"; }
    }

    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Multiselect = true, Filter = "媒体资产|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.mp4;*.mov;*.mkv;*.wav;*.mp3;*.m4a;*.srt;*.ass|所有文件|*.*" };
        if (dialog.ShowDialog(this) != true) return;
        try
        {
            foreach (var path in dialog.FileNames)
            {
                var ext = Path.GetExtension(path).ToLowerInvariant();
                var selectedType = (ImportType.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "auto";
                var type = selectedType != "auto" ? selectedType : new[] { ".mp4", ".mov", ".mkv" }.Contains(ext) ? "video" : new[] { ".wav", ".mp3", ".m4a" }.Contains(ext) ? "voice" : new[] { ".srt", ".ass" }.Contains(ext) ? "subtitle" : "image";
                await _api.ImportAssetAsync(path, type, Path.GetFileNameWithoutExtension(path));
            }
            await LoadAssetsAsync();
        }
        catch (Exception ex) { StatusText.Text = $"导入失败：{ex.Message}"; }
    }

    private AssetItem? SelectedAsset => ReferencePanel.Visibility == Visibility.Visible ? CandidateList.SelectedItem as AssetItem : AssetGrid.SelectedItem as AssetItem;

    private void Open_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedAsset is not { } item || !File.Exists(item.LocalPath)) { StatusText.Text = "请选择存在的资产文件"; return; }
        Process.Start(new ProcessStartInfo(item.LocalPath) { UseShellExecute = true });
    }

    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedAsset is not { } item) { StatusText.Text = "请先选择一个候选或生产素材"; return; }
        var consequence = item.Approved ? "该文件已被批准，删除后会立即使一致性门禁失效。" : "";
        if (MessageBox.Show($"删除“{item.Name}”及项目副本？{consequence}", "确认删除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        try { await _api.DeleteAssetAsync(item.Id, true); await LoadAsync(); }
        catch (Exception ex) { StatusText.Text = $"删除失败：{ex.Message}"; }
    }
}
