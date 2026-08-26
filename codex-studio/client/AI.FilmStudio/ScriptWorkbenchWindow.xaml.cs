using System.IO;
using System.IO.Compression;
using System.Windows;
using System.Windows.Controls;
using System.Xml.Linq;
using AI.FilmStudio.Models;
using AI.FilmStudio.Services;
using Microsoft.Win32;

namespace AI.FilmStudio;

public partial class ScriptWorkbenchWindow : Window
{
    private readonly StudioApiClient _api;
    private readonly StudioProject _project;
    private string _sourceName = "";
    private bool _loadingEpisode;
    private string? _directorProvider;
    private string? _directorModel;
    public bool StoryboardChanged { get; private set; }

    public ScriptWorkbenchWindow(StudioApiClient api, StudioProject project)
    {
        InitializeComponent();
        _api = api;
        _project = project;
        ProjectNameText.Text = $"· {project.Name}";
        EpisodeSelector.ItemsSource = Enumerable.Range(1, project.EpisodeCount).Select(i => $"第 {i} 集").ToList();
        EpisodeSelector.SelectedIndex = 0;
        Loaded += async (_, _) => { await LoadDirectorProviderAsync(); await LoadEpisodeAsync(); };
    }

    private int Episode => EpisodeSelector.SelectedIndex + 1;

    private async Task LoadDirectorProviderAsync()
    {
        var priorities = new[] { "anthropic", "deepseek", "qwen", "openai", "ark" };
        var configured = (await _api.GetProviderConfigsAsync()).Where(x => x.Configured && x.Capabilities.Contains("chat")).ToList();
        var bound = (await _api.GetModelRolesAsync()).FirstOrDefault(x => x.Id == "storyboard_design" && x.Available);
        _directorProvider = bound?.ProviderId ?? priorities.FirstOrDefault(id => configured.Any(x => x.ProviderId == id));
        _directorModel = bound?.Model;
        DirectorButton.IsEnabled = _directorProvider is not null;
        if (_directorProvider is null) DirectorResult.Text = "请先在“模型路由中心”配置服务商，并绑定“全量分镜导演”岗位。";
        else if (bound is not null) DirectorResult.Text = $"本次将使用已绑定的全量分镜导演：{bound.ProviderId} / {bound.Model}";
    }

    private async Task LoadEpisodeAsync()
    {
        if (_loadingEpisode || Episode < 1) return;
        _loadingEpisode = true;
        try
        {
            var script = await _api.GetScriptAsync(Episode);
            ScriptEditor.Text = script.SourceText;
            _sourceName = script.SourceName;
            SourceNameText.Text = string.IsNullOrWhiteSpace(_sourceName) ? "尚未导入文件" : _sourceName;
            ParseSummaryText.Text = script.ParseStatus switch
            {
                "director_storyboard" => "AI 生产设计、Story Bible 与状态图已生成",
                "storyboard" => "已解析并生成分镜",
                "parsed" => "剧本已解析",
                "saved" => "已保存，等待解析",
                _ => "尚未保存剧本"
            };
            CharactersText.Text = "人物：解析后显示";
            SceneList.ItemsSource = null;
        }
        catch (Exception ex) { StatusText.Text = $"读取失败：{ex.Message}"; }
        finally { _loadingEpisode = false; }
    }

    private async void EpisodeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (IsLoaded) await LoadEpisodeAsync();
    }

    private void Import_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "支持的剧本|*.txt;*.md;*.docx|文本文件|*.txt;*.md|Word 文档|*.docx" };
        if (dialog.ShowDialog(this) != true) return;
        try
        {
            ScriptEditor.Text = ReadScript(dialog.FileName);
            _sourceName = Path.GetFileName(dialog.FileName);
            SourceNameText.Text = _sourceName;
            StatusText.Text = $"已导入 {_sourceName}，请保存或直接解析。";
        }
        catch (Exception ex) { MessageBox.Show($"导入失败：{ex.Message}", "AI影视Studio", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private static string ReadScript(string path)
    {
        if (!path.EndsWith(".docx", StringComparison.OrdinalIgnoreCase)) return File.ReadAllText(path);
        using var archive = ZipFile.OpenRead(path);
        var entry = archive.GetEntry("word/document.xml") ?? throw new InvalidDataException("DOCX 中缺少 document.xml");
        using var stream = entry.Open();
        var doc = XDocument.Load(stream);
        XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        return string.Join(Environment.NewLine, doc.Descendants(w + "p").Select(p => string.Concat(p.Descendants(w + "t").Select(t => t.Value))).Where(line => !string.IsNullOrWhiteSpace(line)));
    }

    private async Task SaveAsync()
    {
        if (string.IsNullOrWhiteSpace(ScriptEditor.Text)) throw new InvalidOperationException("剧本文本不能为空");
        StatusText.Text = "正在保存…";
        await _api.SaveScriptAsync(Episode, $"第 {Episode} 集", _sourceName, ScriptEditor.Text);
        StatusText.Text = $"第 {Episode} 集已保存到项目数据库。";
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        try { await SaveAsync(); }
        catch (Exception ex) { StatusText.Text = $"保存失败：{ex.Message}"; }
    }

    private async Task<ScriptParseResult> ParseAsync()
    {
        await SaveAsync();
        StatusText.Text = "正在解析场景、人物和对白…";
        var result = await _api.ParseScriptAsync(Episode);
        ParseSummaryText.Text = $"{result.SceneCount} 个场景 · {result.CharacterCount} 个人物";
        CharactersText.Text = "人物：" + (result.Characters.Count == 0 ? "未检测到带姓名对白的人物" : string.Join("、", result.Characters));
        SceneList.ItemsSource = result.Scenes;
        StatusText.Text = "解析完成。请核对场景顺序，然后生成全量分镜。";
        return result;
    }

    private async void Parse_Click(object sender, RoutedEventArgs e)
    {
        try { await ParseAsync(); }
        catch (Exception ex) { StatusText.Text = $"解析失败：{ex.Message}"; }
    }

    private async void Director_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_directorProvider is null) throw new InvalidOperationException("尚未配置可用的导演模型");
            if (string.IsNullOrWhiteSpace(ScriptEditor.Text)) throw new InvalidOperationException("剧本文本不能为空");
            DirectorButton.IsEnabled = false;
            await SaveAsync();
            DirectorResult.Text = "导演模型正在通读完整剧本，并生成场次、全量分镜、冻结 Story Bible 与逐镜状态图…";
            var result = await _api.GenerateDirectorPackageAsync(Episode, _directorProvider, _directorModel, true);
            StoryboardChanged = true;
            ParseSummaryText.Text = $"{result.SceneCount} 个场景 · {result.ShotCount} 个镜头 · {result.BibleCount} 项冻结设定";
            var warnings = result.Warnings.Count == 0 ? "状态图检查通过，无阻断项。" : string.Join(Environment.NewLine, result.Warnings.Select(x => "• " + x));
            DirectorResult.Text = $"{result.Provider} · {result.Model}\n\n一句话梗概：{result.Logline}\n\n{warnings}";
            StatusText.Text = result.BlockingStateConflicts == 0
                ? "AI 全量生产设计已落库；可进入分镜工作台逐镜核对。"
                : $"已生成，但状态图发现 {result.BlockingStateConflicts} 个阻断镜头；修正前不会启动批量生产。";
        }
        catch (Exception ex) { DirectorResult.Text = $"分析失败：{ex.Message}"; }
        finally { DirectorButton.IsEnabled = _directorProvider is not null; }
    }

    private async void Generate_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var parsed = await ParseAsync();
            if (parsed.SceneCount == 0) throw new InvalidOperationException("没有可生成分镜的场景");
            var result = await _api.GenerateStoryboardAsync(Episode, true);
            StoryboardChanged = true;
            ParseSummaryText.Text = $"{parsed.SceneCount} 个场景 · 已生成 {result.ShotCount} 个镜头";
            StatusText.Text = $"离线草稿分镜完成：{result.ShotCount} 个镜头。它不包含 AI Story Bible 和状态图，请优先使用 AI 全量生产设计。";
        }
        catch (Exception ex) { StatusText.Text = $"生成失败：{ex.Message}"; }
    }
}
