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
    public AssetManagerWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent(); _api = api; ProjectText.Text = $"· {project.Name}"; AssetGrid.ItemsSource = _assets;
        Loaded += async (_, _) => await LoadAsync();
    }
    private string Filter => (TypeFilter.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private async Task LoadAsync()
    {
        try { var items = await _api.GetAssetsAsync(string.IsNullOrWhiteSpace(Filter) ? null : Filter); _assets.Clear(); foreach (var item in items) _assets.Add(item); StatusText.Text = $"共 {_assets.Count} 个真实资产；文件已复制到项目目录。"; }
        catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; }
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private async void TypeFilter_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await LoadAsync(); }
    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Multiselect = true, Filter = "媒体与参考资产|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.mp4;*.mov;*.mkv;*.wav;*.mp3;*.m4a;*.srt;*.ass|所有文件|*.*" };
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
            await LoadAsync();
        }
        catch (Exception ex) { StatusText.Text = $"导入失败：{ex.Message}"; }
    }
    private void Open_Click(object sender, RoutedEventArgs e)
    {
        if (AssetGrid.SelectedItem is not AssetItem item || !File.Exists(item.LocalPath)) { StatusText.Text = "请选择存在的资产文件"; return; }
        Process.Start(new ProcessStartInfo(item.LocalPath) { UseShellExecute = true });
    }
    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (AssetGrid.SelectedItem is not AssetItem item) return;
        if (MessageBox.Show($"删除资产“{item.Name}”及项目副本？", "确认删除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        try { await _api.DeleteAssetAsync(item.Id, true); await LoadAsync(); } catch (Exception ex) { StatusText.Text = $"删除失败：{ex.Message}"; }
    }
}
