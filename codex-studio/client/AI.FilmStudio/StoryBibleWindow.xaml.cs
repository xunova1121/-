using System.Collections.ObjectModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class StoryBibleWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<BibleEntity> _entities = [];
    private readonly ObservableCollection<ReferencePreview> _references = [];
    private IReadOnlyList<BibleEntity> _all = [];
    public StoryBibleWindow(StudioApiClient api) { InitializeComponent(); _api = api; EntityList.ItemsSource = _entities; ReferenceList.ItemsSource = _references; Loaded += async (_, _) => await LoadAsync(); }
    private string TypeValue => (EntityType.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "character";
    private string FilterValue => (Filter.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    private async Task LoadAsync() { try { _all = await _api.GetBibleAsync(); ApplyFilter(); StatusText.Text = $"已加载 {_all.Count} 个最新设定版本。"; } catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; } }
    private void ApplyFilter() { var selected = EntityList.SelectedItem as BibleEntity; _entities.Clear(); foreach (var item in _all.Where(x => string.IsNullOrWhiteSpace(FilterValue) || x.EntityType == FilterValue)) _entities.Add(item); if (selected is not null) EntityList.SelectedItem = _entities.FirstOrDefault(x => x.Id == selected.Id); }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadAsync();
    private void Filter_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) ApplyFilter(); }
    private void SelectType(string value) { foreach (ComboBoxItem item in EntityType.Items) if (item.Tag?.ToString() == value) { EntityType.SelectedItem = item; break; } }
    private void EntityList_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (EntityList.SelectedItem is not BibleEntity item) return; SelectType(item.EntityType); EntityKey.Text = item.EntityKey; EntityName.Text = item.Name; Frozen.IsChecked = item.State == "frozen"; DataJson.Text = JsonSerializer.Serialize(item.Data, new JsonSerializerOptions { WriteIndented = true }); _references.Clear(); foreach (var path in item.ReferenceAssets) _references.Add(new ReferencePreview(path)); StatusText.Text = $"版本 {item.Version} · 指纹 {item.Fingerprint[..Math.Min(12, item.Fingerprint.Length)]}…"; }
    private void New_Click(object sender, RoutedEventArgs e) { EntityList.SelectedItem = null; EntityKey.Clear(); EntityName.Clear(); DataJson.Text = TypeValue == "character" ? "{\n  \"face\": \"\",\n  \"hair\": \"\",\n  \"body\": \"\",\n  \"costume\": \"\",\n  \"age\": \"\",\n  \"negative\": \"禁止改变脸型、服装和体型\"\n}" : "{}"; _references.Clear(); Frozen.IsChecked = true; }
    private void AddReference_Click(object sender, RoutedEventArgs e) { var dialog = new OpenFileDialog { Multiselect = true, Filter = "参考图像|*.png;*.jpg;*.jpeg;*.webp;*.bmp" }; if (dialog.ShowDialog() == true) foreach (var path in dialog.FileNames) if (_references.All(item => item.Path != path)) _references.Add(new ReferencePreview(path)); }
    private void RemoveReference_Click(object sender, RoutedEventArgs e) { if (ReferenceList.SelectedItem is ReferencePreview item) _references.Remove(item); }
    private async void Save_Click(object sender, RoutedEventArgs e) { try { if (string.IsNullOrWhiteSpace(EntityName.Text) || string.IsNullOrWhiteSpace(EntityKey.Text)) throw new InvalidOperationException("名称和唯一键不能为空"); using var document = JsonDocument.Parse(DataJson.Text); await _api.SaveBibleVersionAsync(TypeValue, EntityKey.Text.Trim(), EntityName.Text.Trim(), document.RootElement.Clone(), _references.Select(item => item.Path).ToList(), Frozen.IsChecked == true); await LoadAsync(); StatusText.Text = "新版本已保存；后续生成任务会自动注入该版本。"; } catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; } }
}

public sealed class ReferencePreview(string path)
{
    public string Path { get; } = path;
    public string Name { get; } = System.IO.Path.GetFileNameWithoutExtension(path);
}