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
    named(root, "ComboBox", "RoleProvider")
    named(root, "ComboBox", "RoleModel")
    named(root, "TextBlock", "SelectedRoleSummary")

    code = (ROOT / "client/AI.FilmStudio/ProviderSettingsWindow.xaml.cs").read_text(encoding="utf-8")
    assert "SelectedModelId(RoleModel)" in code
    assert "SaveModelRoleAsync(roleId, provider.ProviderId, modelId)" in code
    assert "UpdateSelectedRoleSummary" in code
    automation = (ROOT / "client/AI.FilmStudio/AutomationWindow.xaml.cs").read_text(encoding="utf-8")
    assert 'RequireRole("keyframe_image"' in automation and 'RequireRole("shot_video"' in automation
    assert "ProviderConfigStatus" not in automation
    print("UI contract passed: readable controls and explicit persistent role-binding actions")


if __name__ == "__main__":
    main()
