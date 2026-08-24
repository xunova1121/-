param(
    [Parameter(Mandatory = $true)][int]$DesktopPid,
    [Parameter(Mandatory = $true)][string]$ApiBase
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Save-Screen([string]$Name) {
    $directory = Join-Path (Get-Location) "ui-artifacts"
    New-Item -ItemType Directory -Force $directory | Out-Null
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $directory "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Find-ByAutomationId([System.Windows.Automation.AutomationElement]$Root, [string]$Id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Wait-Element([System.Windows.Automation.AutomationElement]$Root, [string]$Id, [int]$Seconds = 15) {
    for ($i = 0; $i -lt ($Seconds * 4); $i++) {
        $element = Find-ByAutomationId $Root $Id
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 250
    }
    throw "UI element '$Id' was not found"
}

function Invoke-Element([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}

$stub = Start-Process -FilePath "python" -ArgumentList "codex-studio/scripts/model-discovery-stub.py" -PassThru -WindowStyle Hidden
try {
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:18999/v1/models" -TimeoutSec 1
            if ($catalog.data[0].id -eq "studio-ui-smoke-chat") { break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }

    $providerBody = @{ base_url = "http://127.0.0.1:18999/v1"; model = "studio-ui-smoke-chat"; api_key = "ui-smoke-secret" } | ConvertTo-Json
    Invoke-RestMethod -Method Put -Uri "$ApiBase/provider-configs/openai" -ContentType "application/json" -Body $providerBody | Out-Null

    $desktop = Get-Process -Id $DesktopPid
    for ($i = 0; $i -lt 40 -and $desktop.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 250; $desktop.Refresh() }
    if ($desktop.MainWindowHandle -eq 0) { throw "Desktop main window handle is unavailable" }
    $main = [System.Windows.Automation.AutomationElement]::FromHandle($desktop.MainWindowHandle)
    Save-Screen "01-home"

    $projectBody = @{ name = "UI审片验收"; genre = "悬疑"; episode_count = 1 } | ConvertTo-Json
    $project = Invoke-RestMethod -Method Post -Uri "$ApiBase/projects" -ContentType "application/json" -Body $projectBody
    $scriptText = @"
# 场景 1 沙丘 - 黎明
**（0:00-0:12）** **画面：** 黎明前的沙丘安静无声
**细节：** 旅人裹着长袍
**动作：** 旅人缓慢抬头
---
**（0:13-0:25）** **画面：** 风声骤停
**细节：** 旅人手指收紧
"@
    $scriptBody = @{ title = "第一集"; source_name = "ui-review.md"; source_text = $scriptText } | ConvertTo-Json
    Invoke-RestMethod -Method Put -Uri "$ApiBase/projects/$($project.id)/episodes/1/script" -ContentType "application/json" -Body $scriptBody | Out-Null
    Invoke-RestMethod -Method Post -Uri "$ApiBase/projects/$($project.id)/episodes/1/script/parse" | Out-Null
    $storyboardBody = @{ replace_existing = $true } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$ApiBase/projects/$($project.id)/episodes/1/storyboard/generate" -ContentType "application/json" -Body $storyboardBody | Out-Null

    Invoke-Element (Wait-Element $main "ProjectNavButton")
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $selectProject = Wait-Element $root "SelectCurrentProjectButton"
    Start-Sleep -Seconds 1
    Invoke-Element $selectProject
    Start-Sleep -Seconds 1
    Invoke-Element (Wait-Element $main "StoryboardNavButton")
    $storyboardGrid = Wait-Element $root "StoryboardGrid"
    foreach ($header in @('镜号','场景','景别','画面与动作','人物','时长','衔接','状态')) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $header)
        if ($null -eq $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)) { throw "Storyboard header '$header' was not visible" }
    }
    foreach ($forbidden in @('状态前 JSON','状态后 JSON','动作链ID','动作动量')) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $forbidden)
        if ($null -ne $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)) { throw "Internal storyboard field '$forbidden' leaked into the review table" }
    }
    Save-Screen "02-storyboard-review"
    Invoke-Element (Wait-Element $root "StoryboardLockButton")
    $lock = $null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        $lock = Invoke-RestMethod -Uri "$ApiBase/projects/$($project.id)/episodes/1/storyboard-lock"
        if ($lock.status -eq "locked") { break }
    }
    if ($null -eq $lock -or $lock.status -ne "locked" -or $lock.revision -lt 1) { throw "Storyboard lock did not persist through the UI" }
    Save-Screen "02b-storyboard-locked"
    $storyboardWindow = $storyboardGrid
    while ($storyboardWindow.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
        $storyboardWindow = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($storyboardWindow)
        if ($null -eq $storyboardWindow) { throw "Storyboard window ancestor was not found" }
    }
    $storyboardWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    Start-Sleep -Milliseconds 500

    Invoke-Element (Wait-Element $main "ModelSettingsButton")

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $fetch = Wait-Element $root "FetchRoleModelsButton"
    $bind = Wait-Element $root "BindRoleButton"
    $clear = Wait-Element $root "ClearRoleButton"
    $close = Wait-Element $root "CloseRouterButton"
    $modelSelector = Wait-Element $root "RoleModelSelector"

    Invoke-Element $fetch
    $selected = ""
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $value = $modelSelector.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $selected = $value.Current.Value
        } catch { }
        if ($selected -match "studio-ui-smoke-chat") { break }
    }
    if ($selected -notmatch "studio-ui-smoke-chat") { throw "Pulled model was not selected in the role model control; value='$selected'" }
    Save-Screen "03-model-pulled-and-selected"

    Invoke-Element $bind
    Start-Sleep -Seconds 1
    $roles = Invoke-RestMethod -Uri "$ApiBase/model-roles"
    $role = $roles | Where-Object { $_.id -eq "script_analysis" }
    if ($role.provider_id -ne "openai" -or $role.model -ne "studio-ui-smoke-chat") {
        throw "UI binding did not persist the exact model id: $($role | ConvertTo-Json -Compress)"
    }
    Save-Screen "04-model-binding-saved"

    Invoke-Element $close
    Start-Sleep -Milliseconds 500
    Invoke-Element (Wait-Element $main "ModelSettingsButton")
    $modelSelector = Wait-Element $root "RoleModelSelector"
    $clear = Wait-Element $root "ClearRoleButton"
    $reopened = ""
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        try { $reopened = $modelSelector.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
        if ($reopened -match "studio-ui-smoke-chat") { break }
    }
    if ($reopened -notmatch "studio-ui-smoke-chat") { throw "Saved role binding was not restored after reopening; value='$reopened'" }
    Save-Screen "05-model-binding-restored-after-reopen"

    Invoke-Element $clear
    Start-Sleep -Seconds 1
    $roles = Invoke-RestMethod -Uri "$ApiBase/model-roles"
    $role = $roles | Where-Object { $_.id -eq "script_analysis" }
    if ($role.provider_id -or $role.model) { throw "UI clear binding did not persist" }
    Write-Host "Model routing UI smoke passed: pull -> select -> bind -> close -> reopen -> persist -> clear"
} finally {
    if ($null -ne $stub -and -not $stub.HasExited) { Stop-Process -Id $stub.Id -Force }
}
