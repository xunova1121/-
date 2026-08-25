from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
xaml_path = ROOT / "client" / "AI.FilmStudio" / "PrevizWindow.xaml"
code_path = ROOT / "client" / "AI.FilmStudio" / "PrevizWindow.xaml.cs"

root = ET.parse(xaml_path).getroot()
xml = xaml_path.read_text(encoding="utf-8")
code = code_path.read_text(encoding="utf-8")

required_ids = {
    "PrevizShotList", "NewPrevizShotTitle", "CreatePrevizShotButton", "PrevizBindingStatus",
    "PrevizVersionList", "SaveAndBindPrevizButton", "BindExistingPrevizButton", "RemovePrevizBindingButton",
}
actual_ids = {
    value for element in root.iter() for key, value in element.attrib.items()
    if key.endswith("AutomationId")
}
missing = required_ids - actual_ids
assert not missing, f"Missing previz UI automation ids: {sorted(missing)}"
for label in ("绑定镜头", "＋ 新建镜头", "保存新版本并绑定镜头", "将选中历史版本绑定镜头", "解除当前镜头绑定", "生产门禁"):
    assert label in xml, f"Missing visible previz action: {label}"
for behavior in ("CreateShotAsync", "BindShotPrevizAsync", "RemoveShotPrevizBindingAsync", "GetShotPrevizBindingAsync"):
    assert behavior in code, f"Previz UI is not wired to {behavior}"

print("UI contract passed: create shot -> select -> save/bind -> rebind/remove")

settings_xaml = ROOT / "client" / "AI.FilmStudio" / "ProviderSettingsWindow.xaml"
settings_code = settings_xaml.with_suffix(".xaml.cs")
settings_root = ET.parse(settings_xaml).getroot()
settings_xml = settings_xaml.read_text(encoding="utf-8")
settings_cs = settings_code.read_text(encoding="utf-8")
required_model_ids = {"ProviderSelector", "SaveProviderButton", "FetchModelsButton", "ModelRoleSelector", "AvailableModelSelector", "ConfirmModelBindingButton", "BoundModelRoutes"}
model_ids = {value for element in settings_root.iter() for key, value in element.attrib.items() if key.endswith("AutomationId")}
assert not required_model_ids - model_ids, f"Missing model routing UI ids: {sorted(required_model_ids - model_ids)}"
for label in ("加密保存连接", "拉取可用模型", "功能岗位绑定", "确认绑定此岗位", "当前绑定"):
    assert label in settings_xml, f"Missing visible model-routing action: {label}"
for behavior in ("FetchProviderModelsAsync", "SaveModelRouteAsync", "GetModelRoutesAsync"):
    assert behavior in settings_cs, f"Model routing UI is not wired to {behavior}"
print("UI contract passed: save provider -> fetch models -> select role -> confirm binding")
