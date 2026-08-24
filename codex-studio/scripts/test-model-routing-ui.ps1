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
    Save-Screen "02-model-pulled-and-selected"

    Invoke-Element $bind
    Start-Sleep -Seconds 1
    $roles = Invoke-RestMethod -Uri "$ApiBase/model-roles"
    $role = $roles | Where-Object { $_.id -eq "script_analysis" }
    if ($role.provider_id -ne "openai" -or $role.model -ne "studio-ui-smoke-chat") {
        throw "UI binding did not persist the exact model id: $($role | ConvertTo-Json -Compress)"
    }
    Save-Screen "03-model-binding-saved"

    Invoke-Element $close
    Start-Sleep -Milliseconds 500
    Invoke-Element (Wait-Element $main "ModelSettingsButton")
    $modelSelector = Wait-Element $root "RoleModelSelector"
    $clear = Wait-Element $root "ClearRoleButton"
    $reopened = $modelSelector.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
    if ($reopened -notmatch "studio-ui-smoke-chat") { throw "Saved role binding was not restored after reopening; value='$reopened'" }

    Invoke-Element $clear
    Start-Sleep -Seconds 1
    $roles = Invoke-RestMethod -Uri "$ApiBase/model-roles"
    $role = $roles | Where-Object { $_.id -eq "script_analysis" }
    if ($role.provider_id -or $role.model) { throw "UI clear binding did not persist" }
    Write-Host "Model routing UI smoke passed: pull -> select -> bind -> close -> reopen -> persist -> clear"
} finally {
    if ($null -ne $stub -and -not $stub.HasExited) { Stop-Process -Id $stub.Id -Force }
}
