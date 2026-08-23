using System.Windows;
using AI.FilmStudio.Services;
namespace AI.FilmStudio;
public partial class ContinuityWindow : Window
{
    private readonly StudioApiClient _api;
    public ContinuityWindow(StudioApiClient api) { InitializeComponent(); _api = api; Loaded += async (_, _) => await AnalyzeAsync(); }
    private async Task AnalyzeAsync() { try { StatusText.Text = "正在读取全量镜头并分析…"; var result = await _api.ProofreadAsync(); ScoreText.Text = result.Score.ToString(); FindingGrid.ItemsSource = result.Findings; StatusText.Text = result.ShotCount == 0 ? "尚无镜头，请先生成分镜。" : result.Findings.Count == 0 ? $"已检查 {result.ShotCount} 个镜头，未发现可判定的轴线/光照冲突。" : $"已检查 {result.ShotCount} 个镜头，发现 {result.Findings.Count} 项风险。"; } catch (Exception ex) { StatusText.Text = $"分析失败：{ex.Message}"; } }
    private async void Analyze_Click(object sender, RoutedEventArgs e) => await AnalyzeAsync();
}
