using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;

namespace AI.FilmStudio;

public partial class PrevizWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly ObservableCollection<PrevizSubject> _subjects = [];
    private const double Scale = 48;
    private string? _dragTarget;
    private bool _suppress;

    public PrevizWindow(StudioApiClient api)
    {
        InitializeComponent();
        _api = api;
        SubjectGrid.ItemsSource = _subjects;
        _subjects.Add(new PrevizSubject { EntityKey = "主角", Position = new PrevizPoint { X = 0, Y = 0 } });
        Loaded += async (_, _) => { Redraw(); await LoadShotsAsync(); await LoadVersionsAsync(); };
        SizeChanged += (_, _) => Redraw();
    }

    private static double Read(TextBox box, double fallback = 0) => double.TryParse(box.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : fallback;
    private Point Screen(double x, double y) => new(Stage.ActualWidth / 2 + x * Scale, Stage.ActualHeight / 2 - y * Scale);
    private PrevizPoint World(Point point) => new() { X = Math.Round((point.X - Stage.ActualWidth / 2) / Scale, 2), Y = Math.Round((Stage.ActualHeight / 2 - point.Y) / Scale, 2) };

    private void AddLine(Point a, Point b, Brush brush, double thickness = 1, DoubleCollection? dash = null)
    {
        Stage.Children.Add(new Line { X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Stroke = brush, StrokeThickness = thickness, StrokeDashArray = dash });
    }

    private void AddMarker(Point point, Brush brush, string label, string tag, double size = 24)
    {
        var marker = new Ellipse { Width = size, Height = size, Fill = brush, Stroke = Brushes.White, StrokeThickness = 1, Tag = tag, Cursor = Cursors.Hand };
        marker.MouseLeftButtonDown += Marker_MouseLeftButtonDown;
        Canvas.SetLeft(marker, point.X - size / 2); Canvas.SetTop(marker, point.Y - size / 2); Stage.Children.Add(marker);
        var text = new TextBlock { Text = label, Foreground = Brushes.White, Background = new SolidColorBrush(Color.FromArgb(190, 16, 19, 24)), Padding = new Thickness(4, 2, 4, 2), IsHitTestVisible = false };
        Canvas.SetLeft(text, point.X + size / 2 + 4); Canvas.SetTop(text, point.Y - 11); Stage.Children.Add(text);
    }

    private void Redraw()
    {
        if (!IsLoaded || Stage.ActualWidth < 120 || _suppress) return;
        Stage.Children.Clear();
        var center = Screen(0, 0);
        for (var x = center.X % Scale; x < Stage.ActualWidth; x += Scale) AddLine(new Point(x, 0), new Point(x, Stage.ActualHeight), new SolidColorBrush(Color.FromRgb(37, 42, 50)));
        for (var y = center.Y % Scale; y < Stage.ActualHeight; y += Scale) AddLine(new Point(0, y), new Point(Stage.ActualWidth, y), new SolidColorBrush(Color.FromRgb(37, 42, 50)));

        var cameraWorld = new PrevizPoint { X = Read(CameraX), Y = Read(CameraY, -5) };
        var targetWorld = new PrevizPoint { X = Read(TargetX), Y = Read(TargetY) };
        var camera = Screen(cameraWorld.X, cameraWorld.Y); var target = Screen(targetWorld.X, targetWorld.Y);
        var dx = targetWorld.X - cameraWorld.X; var dy = targetWorld.Y - cameraWorld.Y;
        var angle = Math.Atan2(dy, dx); var fov = 2 * Math.Atan(36.0 / (2 * Math.Max(8, Read(Lens, 35))));
        foreach (var side in new[] { -1.0, 1.0 })
        {
            var ray = angle + side * fov / 2; var end = Screen(cameraWorld.X + Math.Cos(ray) * 7, cameraWorld.Y + Math.Sin(ray) * 7);
            AddLine(camera, end, new SolidColorBrush(Color.FromRgb(118, 87, 232)), 2);
        }
        AddLine(camera, target, new SolidColorBrush(Color.FromRgb(80, 150, 230)), 1, new DoubleCollection { 4, 3 });

        if (_subjects.Count >= 2) AddLine(Screen(_subjects[0].Position.X, _subjects[0].Position.Y), Screen(_subjects[1].Position.X, _subjects[1].Position.Y), new SolidColorBrush(Color.FromRgb(224, 165, 52)), 2, new DoubleCollection { 6, 4 });
        else if (_subjects.Count == 1) AddLine(target, Screen(_subjects[0].Position.X, _subjects[0].Position.Y), new SolidColorBrush(Color.FromRgb(224, 165, 52)), 2, new DoubleCollection { 6, 4 });

        AddMarker(camera, new SolidColorBrush(Color.FromRgb(118, 87, 232)), "机位", "camera");
        AddMarker(target, new SolidColorBrush(Color.FromRgb(80, 150, 230)), "目标", "target", 20);
        for (var i = 0; i < _subjects.Count; i++) AddMarker(Screen(_subjects[i].Position.X, _subjects[i].Position.Y), new SolidColorBrush(Color.FromRgb(54, 201, 121)), _subjects[i].EntityKey, $"subject:{i}", 28);
    }

    private void Marker_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _dragTarget = (sender as FrameworkElement)?.Tag?.ToString();
        if (_dragTarget is not null) Stage.CaptureMouse();
        e.Handled = true;
    }

    private void Stage_MouseMove(object sender, MouseEventArgs e)
    {
        if (_dragTarget is null || e.LeftButton != MouseButtonState.Pressed) return;
        var point = World(e.GetPosition(Stage)); _suppress = true;
        if (_dragTarget == "camera") { CameraX.Text = point.X.ToString("0.##", CultureInfo.InvariantCulture); CameraY.Text = point.Y.ToString("0.##", CultureInfo.InvariantCulture); }
        else if (_dragTarget == "target") { TargetX.Text = point.X.ToString("0.##", CultureInfo.InvariantCulture); TargetY.Text = point.Y.ToString("0.##", CultureInfo.InvariantCulture); }
        else if (_dragTarget.StartsWith("subject:") && int.TryParse(_dragTarget[8..], out var index) && index < _subjects.Count) { _subjects[index].Position.X = point.X; _subjects[index].Position.Y = point.Y; SubjectGrid.Items.Refresh(); }
        _suppress = false; Redraw();
    }

    private void EndDrag() { _dragTarget = null; Stage.ReleaseMouseCapture(); }
    private void Stage_MouseLeftButtonUp(object sender, MouseButtonEventArgs e) => EndDrag();
    private void Stage_MouseLeave(object sender, MouseEventArgs e) { if (e.LeftButton != MouseButtonState.Pressed) EndDrag(); }
    private void Field_TextChanged(object sender, TextChangedEventArgs e) => Redraw();
    private void SubjectGrid_CellEditEnding(object sender, DataGridCellEditEndingEventArgs e) => Dispatcher.BeginInvoke(new Action(Redraw));
    private void AddSubject_Click(object sender, RoutedEventArgs e) { _subjects.Add(new PrevizSubject { EntityKey = $"角色{_subjects.Count + 1}", Position = new PrevizPoint { X = _subjects.Count, Y = 0 } }); Redraw(); }
    private void RemoveSubject_Click(object sender, RoutedEventArgs e) { if (SubjectGrid.SelectedItem is PrevizSubject subject) _subjects.Remove(subject); else if (_subjects.Count > 0) _subjects.RemoveAt(_subjects.Count - 1); Redraw(); }

    private async Task LoadVersionsAsync()
    {
        try { var versions = await _api.GetPrevizLayoutsAsync(SceneKey.Text.Trim()); VersionList.ItemsSource = versions; if (versions.Count > 0) VersionList.SelectedIndex = 0; else StatusText.Text = "该场景还没有预演版本，可直接拖拽布置后保存。"; }
        catch (Exception ex) { StatusText.Text = $"读取版本失败：{ex.Message}"; }
    }

    private async Task LoadShotsAsync()
    {
        try
        {
            var shots = await _api.GetShotsAsync();
            ShotList.ItemsSource = shots;
            if (shots.Count > 0) ShotList.SelectedIndex = 0;
            else BindingText.Text = "当前项目还没有镜头，请先创建全量分镜。";
        }
        catch (Exception ex) { BindingText.Text = $"读取镜头失败：{ex.Message}"; }
    }

    private async void CreateShot_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var title = NewShotTitle.Text.Trim();
            if (string.IsNullOrWhiteSpace(title)) throw new InvalidOperationException("请输入新镜头标题");
            var current = (ShotList.ItemsSource as IEnumerable<Shot>)?.ToList() ?? [];
            var next = current.Select(item => int.TryParse(item.Number, out var number) ? number : 0).DefaultIfEmpty().Max() + 1;
            var created = await _api.CreateShotAsync(next.ToString("000"), title, title);
            await LoadShotsAsync();
            ShotList.SelectedItem = (ShotList.ItemsSource as IEnumerable<Shot>)?.FirstOrDefault(item => item.Id == created.Id);
            NewShotTitle.Clear();
            BindingText.Text = $"已新建镜头 {created.Number}，请完成空间布置后保存并绑定。";
        }
        catch (Exception ex) { BindingText.Text = $"新建镜头失败：{ex.Message}"; }
    }

    private async Task LoadBindingAsync()
    {
        if (ShotList.SelectedItem is not Shot shot) return;
        try
        {
            var binding = await _api.GetShotPrevizBindingAsync(shot.Id);
            BindingText.Text = binding is null
                ? $"镜头 {shot.Number} 尚未绑定，不能进入正式图片/视频生产。"
                : $"已绑定：{binding.SceneKey} v{binding.LayoutVersion} · {binding.Status} · 指纹 {binding.Fingerprint[..Math.Min(10, binding.Fingerprint.Length)]}…";
        }
        catch (Exception ex) { BindingText.Text = $"读取绑定失败：{ex.Message}"; }
    }

    private async void ShotList_SelectionChanged(object sender, SelectionChangedEventArgs e) => await LoadBindingAsync();

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadVersionsAsync();
    private void VersionList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (VersionList.SelectedItem is not PrevizLayoutVersion version) return;
        _suppress = true; SceneKey.Text = version.SceneKey; CameraX.Text = version.Camera.Position.X.ToString(CultureInfo.InvariantCulture); CameraY.Text = version.Camera.Position.Y.ToString(CultureInfo.InvariantCulture); TargetX.Text = version.Camera.Target.X.ToString(CultureInfo.InvariantCulture); TargetY.Text = version.Camera.Target.Y.ToString(CultureInfo.InvariantCulture); Lens.Text = version.Camera.LensMm.ToString(CultureInfo.InvariantCulture); Sun.Text = (version.SunBearingDeg ?? -45).ToString(CultureInfo.InvariantCulture);
        _subjects.Clear(); foreach (var subject in version.Subjects) _subjects.Add(subject); _suppress = false; Redraw();
        StatusText.Text = $"已载入 {version.SceneKey} v{version.Version} · 指纹 {version.Fingerprint[..Math.Min(12, version.Fingerprint.Length)]}…";
    }

    private async Task BindSelectedAsync(PrevizLayoutVersion version)
    {
        if (ShotList.SelectedItem is not Shot shot) throw new InvalidOperationException("请先选择要绑定的镜头");
        var binding = await _api.BindShotPrevizAsync(shot.Id, version.Id);
        BindingText.Text = $"已绑定：镜头 {shot.Number} → {binding.SceneKey} v{binding.LayoutVersion}。生成任务将强制携带该空间约束。";
    }

    private async void BindExisting_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (VersionList.SelectedItem is not PrevizLayoutVersion version) throw new InvalidOperationException("请先选择一个历史版本");
            await BindSelectedAsync(version);
            StatusText.Text = "现有预演版本已绑定到当前镜头。";
        }
        catch (Exception ex) { StatusText.Text = $"绑定失败：{ex.Message}"; }
    }

    private async void RemoveBinding_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (ShotList.SelectedItem is not Shot shot) throw new InvalidOperationException("请先选择镜头");
            await _api.RemoveShotPrevizBindingAsync(shot.Id);
            BindingText.Text = $"镜头 {shot.Number} 已解除绑定，正式生成已被门禁阻止。";
        }
        catch (Exception ex) { StatusText.Text = $"解除失败：{ex.Message}"; }
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (ShotList.SelectedItem is not Shot) throw new InvalidOperationException("请先选择或新建镜头");
            if (string.IsNullOrWhiteSpace(SceneKey.Text)) throw new InvalidOperationException("场景键不能为空");
            if (_subjects.Count == 0) throw new InvalidOperationException("至少布置一个人物");
            var saved = await _api.SavePrevizAsync(SceneKey.Text.Trim(), Read(CameraX), Read(CameraY), Read(TargetX), Read(TargetY), Math.Clamp(Read(Lens, 35), 8, 300), Read(Sun, -45), _subjects.ToList());
            await BindSelectedAsync(saved);
            var score = saved.Analysis.TryGetProperty("score", out var scoreNode) ? scoreNode.GetInt32() : 0;
            var messages = new List<string>(); if (saved.Analysis.TryGetProperty("findings", out var findings)) foreach (var item in findings.EnumerateArray()) if (item.TryGetProperty("message", out var message)) messages.Add(message.GetString() ?? "");
            StatusText.Text = $"已保存并绑定 v{saved.Version} · 构图 {score} 分" + (messages.Count > 0 ? " · " + string.Join("；", messages) : " · 无阻断发现");
            await LoadVersionsAsync();
        }
        catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; }
    }
}
