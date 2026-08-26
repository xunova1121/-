using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class GenerationGalleryWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly int _episode;
    private readonly ObservableCollection<AssetItem> _items = [];
    private IReadOnlyList<AssetItem> _all = [];

    public GenerationGalleryWindow(StudioApiClient api, int episode)
    {
        InitializeComponent();
        _api = api;
        _episode = episode;
        Gallery.ItemsSource = _items;
        Loaded += async (_, _) => await LoadAsync();
    }

    private string Filter => (TypeFilter.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private AssetItem? Selected => Gallery.SelectedItem as AssetItem;

    private async Task LoadAsync(int? selectedId = null)
    {
        try
        {
            _all = (await _api.GetAssetsAsync(episode: _episode)).Where(item => item.SourceKind == "generated" && item.AssetType is "image" or "video" or "voice").ToList();
            ApplyFilter(selectedId);
            StatusText.Text = _all.Count == 0 ? "当前集还没有生成结果。" : $"第 {_episode} 集共有 {_all.Count} 个生成候选；采用结果后，剪辑与连续镜头会优先读取它。";
        }
        catch (Exception ex) { StatusText.Text = $"画廊读取失败：{ex.Message}"; }
    }

    private void ApplyFilter(int? selectedId = null)
    {
        _items.Clear();
        foreach (var item in _all.Where(item => string.IsNullOrWhiteSpace(Filter) || item.AssetType == Filter)) _items.Add(item);
        Gallery.SelectedItem = selectedId is null ? null : _items.FirstOrDefault(item => item.Id == selectedId);
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync(Selected?.Id);
    private void TypeFilter_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) ApplyFilter(); }
    private void Gallery_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        OpenButton.IsEnabled = Selected is { } item && File.Exists(item.LocalPath);
        AdoptButton.IsEnabled = Selected is { ShotId: not null } && Selected.Status != "adopted";
    }
    private void Open_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } item || !File.Exists(item.LocalPath)) { StatusText.Text = "结果文件不存在或尚未完成下载。"; return; }
        Process.Start(new ProcessStartInfo(item.LocalPath) { UseShellExecute = true });
    }
    private async void Adopt_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } item) return;
        AdoptButton.IsEnabled = false;
        try
        {
            var adopted = await _api.AdoptAssetAsync(item.Id);
            await LoadAsync(adopted.Id);
            StatusText.Text = $"✓ 已采用“{adopted.Name}”；其他版本仍保留为候选，可随时切换。";
        }
        catch (Exception ex) { StatusText.Text = $"采用失败：{ex.Message}"; }
    }
}