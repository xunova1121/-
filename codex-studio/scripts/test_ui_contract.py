"""Fast cross-platform checks for critical model-routing UI affordances."""
from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
NS = {"w": "http://schemas.microsoft.com/winfx/2006/xaml/presentation"}
XAML_NS = "{http://schemas.microsoft.com/winfx/2006/xaml}"


def named(root, tag: str, name: str):
    for item in root.iter(f"{{{NS['w']}}}{tag}"):
        if item.attrib.get(f"{XAML_NS}Name") == name:
            return item
    raise AssertionError(f"missing {tag} {name}")


def main():
    app_text = (ROOT / "client/AI.FilmStudio/App.xaml").read_text(encoding="utf-8")
    assert '<Style TargetType="ComboBox">' in app_text and '<ControlTemplate TargetType="ComboBox">' in app_text
    assert '<Style TargetType="ListBox">' in app_text and 'Value="#0B0E13"' in app_text
    assert '<Color x:Key="Text">#FFFFFF</Color>' in app_text
    assert '<Style TargetType="DataGridRow">' in app_text

    app_code = (ROOT / "client/AI.FilmStudio/App.xaml.cs").read_text(encoding="utf-8")
    assert "FitWindowToWorkArea" in app_code and "SystemParameters.WorkArea" in app_code

    for path in sorted((ROOT / "client/AI.FilmStudio").glob("*Window.xaml")):
        window = ET.parse(path).getroot()
        for button in window.iter(f"{{{NS['w']}}}Button"):
            label = button.attrib.get("Content", "")
            assert any(name in button.attrib for name in ("Click", "Command", "IsCancel", "IsDefault")), f"{path.name}: enabled-looking button has no action: {label}"
        for block in window.iter(f"{{{NS['w']}}}TextBlock"):
            size = block.attrib.get("FontSize")
            assert size is None or float(size) >= 15, f"{path.name}: unreadable explicit font size {size}"

    xaml_path = ROOT / "client/AI.FilmStudio/ProviderSettingsWindow.xaml"
    root = ET.parse(xaml_path).getroot()
    expected_buttons = {
        "FetchRoleButton": "拉取此岗位候选模型",
        "BindRoleButton": "✓ 绑定并保存",
        "ClearRoleButton": "解除当前绑定",
    }
    for name, label in expected_buttons.items():
        button = named(root, "Button", name)
        assert button.attrib.get("Content") == label
        assert button.attrib.get("AutomationProperties.AutomationId")

    scroll_names = {
        item.attrib.get(f"{XAML_NS}Name")
        for scroll in root.iter(f"{{{NS['w']}}}ScrollViewer")
        for item in scroll.iter()
    }
    assert not set(expected_buttons).intersection(scroll_names), "binding actions must stay outside scrolling content"
    role_provider = named(root, "ComboBox", "RoleProvider")
    assert role_provider.attrib.get("DisplayMemberPath") == "RouteDisplayName", "role provider must show provider identity and configuration state"
    named(root, "ComboBox", "RoleModel")
    named(root, "TextBlock", "SelectedRoleSummary")

    code = (ROOT / "client/AI.FilmStudio/ProviderSettingsWindow.xaml.cs").read_text(encoding="utf-8")
    assert "SelectedModelId(RoleModel)" in code
    assert "SaveModelRoleAsync(roleId, provider.ProviderId, modelId)" in code
    assert "UpdateSelectedRoleSummary" in code
    assert "GetProviderModelsAsync(provider.ProviderId, SelectedRole.Capability)" in code, "changing the role provider must refresh that provider's models"
    assert "changeVersion != _roleProviderChangeVersion" in code, "late model responses must not overwrite a newer provider selection"
    automation = (ROOT / "client/AI.FilmStudio/AutomationWindow.xaml.cs").read_text(encoding="utf-8")
    assert 'RequireRole("keyframe_image"' in automation and 'RequireRole("shot_video"' in automation
    assert "ProviderConfigStatus" not in automation

    generation_root = ET.parse(ROOT / "client/AI.FilmStudio/GenerationWindow.xaml").getroot()
    named(generation_root, "Button", "GenerateButton")
    named(generation_root, "Button", "BatchButton")
    named(generation_root, "ComboBox", "ModelText")
    named(generation_root, "Button", "OpenResultButton")
    named(generation_root, "Button", "CancelTaskButton")
    named(generation_root, "Button", "RetryTaskButton")
    generation = (ROOT / "client/AI.FilmStudio/GenerationWindow.xaml.cs").read_text(encoding="utf-8")
    assert "_taskRefreshTimer.Start()" in generation and "_taskRefreshTimer.Stop()" in generation, "generation tasks must refresh while the window is open"
    assert "正在提交镜头" in generation and "已进入生成队列" in generation, "generation submission must provide visible progress and success feedback"
    assert "GetProviderConfigsAsync()" in generation and "模型设置已更新" in generation, "closing model settings must refresh generation providers"
    assert "GetProviderModelsAsync(provider.ProviderId, capability)" in generation, "generation must discover models from the selected provider"
    assert "CancelTaskAsync(task.Id)" in generation and "RetryTaskAsync(task.Id)" in generation, "generation tasks must expose cancel and retry controls"
    named(generation_root, "Button", "GalleryButton")
    gallery_root = ET.parse(ROOT / "client/AI.FilmStudio/GenerationGalleryWindow.xaml").getroot()
    named(gallery_root, "ListBox", "Gallery")
    named(gallery_root, "Button", "AdoptButton")
    gallery = (ROOT / "client/AI.FilmStudio/GenerationGalleryWindow.xaml.cs").read_text(encoding="utf-8")
    assert "AdoptAssetAsync(item.Id)" in gallery, "the review gallery must adopt one candidate without deleting alternatives"

    main_root = ET.parse(ROOT / "client/AI.FilmStudio/MainWindow.xaml").getroot()
    top_nav = named(main_root, "StackPanel", "TopNavigation")
    labels = [button.attrib.get("Content", "") for button in top_nav if button.tag == f"{{{NS['w']}}}Button"]
    assert len(labels) == len(set(labels)), f"duplicate primary navigation labels: {labels}"
    assert labels == ["首页", "项目", "剧本", "分镜", "设定集", "AI生成", "自动生产", "剪辑", "发布"]
    assert not any(item.attrib.get(f"{XAML_NS}Name") == "WorkspaceNavigation" for item in main_root.iter()), "secondary duplicate navigation must not return"

    storyboard_root = ET.parse(ROOT / "client/AI.FilmStudio/StoryboardWindow.xaml").getroot()
    storyboard_text = (ROOT / "client/AI.FilmStudio/StoryboardWindow.xaml").read_text(encoding="utf-8")
    named(storyboard_root, "ListBox", "SceneFilterList")
    named(storyboard_root, "Grid", "ShotInspector")
    named(storyboard_root, "ComboBox", "EpisodeSelector")
    lock_button = named(storyboard_root, "Button", "LockButton")
    assert lock_button.attrib.get("Content") == "锁定设定与分镜"
    assert lock_button.attrib.get("AutomationProperties.AutomationId") == "StoryboardLockButton"
    automation_root = ET.parse(ROOT / "client/AI.FilmStudio/AutomationWindow.xaml").getroot()
    named(automation_root, "TextBlock", "LockStatusText")
    assets_root = ET.parse(ROOT / "client/AI.FilmStudio/AssetManagerWindow.xaml").getroot()
    named(assets_root, "ListBox", "EntityList")
    named(assets_root, "ListBox", "CandidateList")
    named(assets_root, "ComboBox", "ViewRole")
    approve = named(assets_root, "Button", "ApproveButton")
    assert approve.attrib.get("Content") == "✓ 批准当前多视图"
    assert approve.attrib.get("AutomationProperties.AutomationId") == "ApproveReferenceBoardButton"
    assert "状态前 JSON" not in storyboard_text and "状态后 JSON" not in storyboard_text
    assert "动作链ID" not in storyboard_text and "动作动量" not in storyboard_text
    for required in ("镜号", "场景", "景别", "画面与动作", "人物", "时长", "衔接", "状态"):
        assert f'Header="{required}"' in storyboard_text
    print("UI contract passed: single navigation, readable storyboard review, multiview asset approval, lock gate, and persistent role binding")


if __name__ == "__main__":
    main()