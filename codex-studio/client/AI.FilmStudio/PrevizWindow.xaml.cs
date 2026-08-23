using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using AI.FilmStudio.Services;
namespace AI.FilmStudio;
public partial class PrevizWindow : Window
{
    private readonly StudioApiClient _api;
    public PrevizWindow(StudioApiClient api) { InitializeComponent(); _api = api; Loaded += (_, _) => Draw(); SizeChanged += (_, _) => Draw(); }
    private static double Read(TextBox box) => double.TryParse(box.Text, out var value) ? value : 0;
    private void Draw() { if (!IsLoaded || Stage.ActualWidth < 100) return; var cx = Stage.ActualWidth / 2; var cy = Stage.ActualHeight / 2; double Scale(double n) => n * 45; var camX = cx + Scale(Read(CameraX)), camY = cy + Scale(Read(CameraY)); var subX = cx + Scale(Read(SubjectX)), subY = cy + Scale(Read(SubjectY)); Canvas.SetLeft(CameraDot, camX - 12); Canvas.SetTop(CameraDot, camY - 12); Canvas.SetLeft(CameraLabel, camX + 14); Canvas.SetTop(CameraLabel, camY - 10); Canvas.SetLeft(SubjectDot, subX - 15); Canvas.SetTop(SubjectDot, subY - 15); Canvas.SetLeft(SubjectLabel, subX + 18); Canvas.SetTop(SubjectLabel, subY - 10); AxisLine.X1 = camX; AxisLine.Y1 = camY; AxisLine.X2 = cx + Scale(Read(TargetX)); AxisLine.Y2 = cy + Scale(Read(TargetY)); ViewLeft.X1 = camX; ViewLeft.Y1 = camY; ViewLeft.X2 = AxisLine.X2 - 130; ViewLeft.Y2 = AxisLine.Y2; ViewRight.X1 = camX; ViewRight.Y1 = camY; ViewRight.X2 = AxisLine.X2 + 130; ViewRight.Y2 = AxisLine.Y2; }
    private async void Save_Click(object sender, RoutedEventArgs e) { try { Draw(); var result = await _api.SavePrevizAsync(SceneKey.Text.Trim(), Read(CameraX), Read(CameraY), Read(TargetX), Read(TargetY), Read(SubjectX), Read(SubjectY), Read(Lens), Read(Sun)); var version = result.GetProperty("version").GetInt32(); var analysis = result.GetProperty("analysis"); var score = analysis.GetProperty("score").GetInt32(); var fingerprint = result.GetProperty("fingerprint").GetString() ?? ""; StatusText.Text = $"已保存版本 {version} · 构图评分 {score} · 指纹 {fingerprint[..Math.Min(12, fingerprint.Length)]}…"; } catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; } }
}
