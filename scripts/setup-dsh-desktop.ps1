<#
.SYNOPSIS
将 pet-learning 项目一键接入 DSH Desktop，或安全移除该集成。

.DESCRIPTION
检测 DSH Desktop、Node.js 和用户 Profile，复制官方 standard Preset 后注入项目 Skills
与本地 MCP，登记工作区，并执行 MCP 冒烟测试。重复运行会先备份再更新，且不会修改
官方 Preset、模型密钥或既有会话历史。

.PARAMETER ProjectRoot
项目根目录。默认是本脚本上一级目录。

.PARAMETER DesktopInstallDir
DSH Desktop 安装目录。省略时自动检测进程及常见安装位置。

.PARAMETER DesktopDataDir
DSH Desktop 用户数据目录。默认是 %APPDATA%\dsh-desktop。

.PARAMETER PresetId
生成的自定义 Preset ID，默认 pet-learning。

.PARAMETER SkipNpmInstall
跳过 npm ci；仅适用于依赖已经完整安装的环境。

.PARAMETER SkipWorkspaceRegistration
不修改 DSH Desktop 工作区账本。

.PARAMETER SkipDesktopHardening
不写入全局的会话遥测与会话贡献禁用配置。

.PARAMETER NoLaunch
安装完成后不启动 DSH Desktop。

.PARAMETER Force
允许备份并替换同名的非安装器 Preset；移除仍有关联会话的工作区登记。

.PARAMETER DiagnoseOnly
只输出检测结果，不修改文件。

.PARAMETER Uninstall
移除安装器生成的 Preset 与托管安全配置，默认保留工作区登记。

.PARAMETER RemoveWorkspace
与 -Uninstall 同用，额外移除工作区登记；不会删除项目或会话文件。

.EXAMPLE
.\scripts\setup-dsh-desktop.ps1 -DiagnoseOnly

.EXAMPLE
.\scripts\setup-dsh-desktop.ps1 -NoLaunch

.EXAMPLE
.\scripts\setup-dsh-desktop.ps1 -Uninstall -RemoveWorkspace
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [string]$DesktopInstallDir,
  [string]$DesktopDataDir = (Join-Path $env:APPDATA 'dsh-desktop'),
  [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
  [string]$PresetId = 'pet-learning',
  [switch]$SkipNpmInstall,
  [switch]$SkipWorkspaceRegistration,
  [switch]$SkipDesktopHardening,
  [switch]$NoLaunch,
  [switch]$Force,
  [switch]$DiagnoseOnly,
  [switch]$Uninstall,
  [switch]$RemoveWorkspace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $scriptDirectory }
$InstallerVersion = '1.1.0'
$ManagedBegin = '# >>> pet-learning installer managed begin'
$ManagedEnd = '# <<< pet-learning installer managed end'

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Resolve-FullPath([string]$Path, [string]$Label) {
  if (-not $Path) { throw "$Label 不能为空" }
  try { return [IO.Path]::GetFullPath($Path) } catch { throw "$Label 路径无效: $Path" }
}

function Write-Utf8Atomic([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Backup-ItemSafe([string]$Path, [string]$BackupRoot, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  [IO.Directory]::CreateDirectory($BackupRoot) | Out-Null
  $target = Join-Path $BackupRoot $Name
  if (Test-Path -LiteralPath $target) { $target = "$target-$([guid]::NewGuid().ToString('N').Substring(0, 8))" }
  Copy-Item -LiteralPath $Path -Destination $target -Recurse -Force
  return $target
}

function Find-DesktopInstall([string]$ExplicitPath) {
  $candidates = [Collections.Generic.List[string]]::new()
  if ($ExplicitPath) { $candidates.Add($ExplicitPath) }
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^DSH Desktop$|^dsh-desktop$' }
  foreach ($process in $running) {
    try { if ($process.Path) { $candidates.Add((Split-Path -Parent $process.Path)) } } catch {}
  }
  foreach ($path in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop'),
    (Join-Path $env:ProgramFiles 'DSH Desktop'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop' })
  )) { if ($path) { $candidates.Add($path) } }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    $root = Resolve-FullPath $candidate 'DSH Desktop 安装目录'
    $manifest = Join-Path $root 'resources\app\package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
    try {
      $package = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($package.name -eq 'dsh-desktop') {
        return [pscustomobject]@{ Root = $root; Manifest = $manifest; Version = [string]$package.version }
      }
    } catch {}
  }
  throw '未找到 DSH Desktop。请先安装并至少启动一次，或传入 -DesktopInstallDir。'
}

function Find-Node([string]$DesktopRoot) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) {
    $versionText = (& $systemNode.Source --version).Trim()
    if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+)\.') {
      return [pscustomobject]@{ Path = $systemNode.Source; Version = $versionText; Major = [int]$Matches[1]; Source = 'system' }
    }
  }
  $bundled = Join-Path $DesktopRoot 'resources\app\node_modules\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) {
    $versionText = (& $bundled --version).Trim()
    if ($versionText -match '^v(\d+)\.') {
      return [pscustomobject]@{ Path = $bundled; Version = $versionText; Major = [int]$Matches[1]; Source = 'desktop-bundled' }
    }
  }
  throw '未找到可用 Node.js。请安装 Node.js 24+。'
}

function Convert-ToYamlPath([string]$Path) {
  return $Path.Replace('\', '/').Replace("'", "''")
}

function Replace-TopLevelEntry([string[]]$Lines, [string]$Id, [string[]]$Replacement) {
  $start = -1
  for ($index = 0; $index -lt $Lines.Count; $index += 1) {
    if ($Lines[$index] -eq "- id: $Id") { $start = $index; break }
  }
  if ($start -lt 0) { throw "官方 standard preset 中找不到条目: $Id" }
  $end = $Lines.Count
  for ($index = $start + 1; $index -lt $Lines.Count; $index += 1) {
    if ($Lines[$index] -match '^- id:\s') { $end = $index; break }
  }
  $before = if ($start -gt 0) { @($Lines[0..($start - 1)]) } else { @() }
  $after = if ($end -lt $Lines.Count) { @($Lines[$end..($Lines.Count - 1)]) } else { @() }
  return @($before + $Replacement + $after)
}

function Set-ManagedHardening([string]$PatchFile, [string]$BackupRoot, [bool]$Remove) {
  if (-not (Test-Path -LiteralPath $PatchFile -PathType Leaf)) {
    if ($Remove) { return }
    Write-Utf8Atomic $PatchFile "[]`n"
  }
  $content = Get-Content -LiteralPath $PatchFile -Raw -Encoding UTF8
  $pattern = "(?ms)^$([regex]::Escape($ManagedBegin))\r?\n.*?^$([regex]::Escape($ManagedEnd))\r?\n?"
  $without = [regex]::Replace($content, $pattern, '').TrimEnd()
  if ($Remove) {
    if ($without -notmatch '(?m)^\s*(?:-|\[\])') { $without = "$without`r`n[]" }
    Write-Utf8Atomic $PatchFile ($without.TrimEnd() + "`r`n")
    return
  }
  Backup-ItemSafe $PatchFile $BackupRoot 'cordis.patch.yml' | Out-Null
  $without = [regex]::Replace($without, '(?m)^\s*\[\]\s*$', '').TrimEnd()
  $block = @"
$ManagedBegin
- id: session-telemetry-otel
  disabled: true

- id: session-log-deepseek
  disabled: true
$ManagedEnd
"@
  $next = if ($without) { "$without`r`n$block" } else { $block }
  Write-Utf8Atomic $PatchFile ($next.TrimEnd() + "`r`n")
}

function Update-WorkspaceStore([string]$StoreFile, [string]$Root, [string]$BackupRoot, [bool]$Remove) {
  $now = [DateTime]::UtcNow.ToString('o')
  if (Test-Path -LiteralPath $StoreFile -PathType Leaf) {
    $store = Get-Content -LiteralPath $StoreFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($store.unit.name -ne 'workspace' -or [int]$store.unit.version -ne 2) {
      throw "不支持的 DSH workspace 存储格式，已停止修改: $StoreFile"
    }
  } else {
    $store = [pscustomobject]@{
      unit = [pscustomobject]@{ name = 'workspace'; version = 2 }
      global = [pscustomobject]@{ initialized = $true; workspaceIds = @(); archivedSessionIds = @() }
      tables = [pscustomobject]@{ workspaces = [pscustomobject]@{} }
    }
  }
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $match = $null
  foreach ($property in $store.tables.workspaces.PSObject.Properties) {
    try {
      if ([IO.Path]::GetFullPath([string]$property.Value.path).TrimEnd('\', '/') -ieq $normalizedRoot) {
        $match = $property
        break
      }
    } catch {}
  }
  if ($Remove) {
    if (-not $match) { return $false }
    if (@($match.Value.sessionIds).Count -gt 0 -and -not $Force) {
      throw "工作区仍有关联会话，拒绝移除。需要时先归档/迁移会话，或显式使用 -Force。"
    }
    Backup-ItemSafe $StoreFile $BackupRoot 'workspace.json' | Out-Null
    $store.tables.workspaces.PSObject.Properties.Remove($match.Name)
    $store.global.workspaceIds = @($store.global.workspaceIds | Where-Object { $_ -ne $match.Name })
  } else {
    if ($match) { return $false }
    Backup-ItemSafe $StoreFile $BackupRoot 'workspace.json' | Out-Null
    $id = [guid]::NewGuid().ToString()
    $entry = [pscustomobject]@{
      path = $normalizedRoot
      title = Split-Path -Leaf $normalizedRoot
      sessionIds = @()
      createdAt = $now
      updatedAt = $now
    }
    $store.tables.workspaces | Add-Member -NotePropertyName $id -NotePropertyValue $entry
    $store.global.workspaceIds = @($store.global.workspaceIds) + $id
  }
  Write-Utf8Atomic $StoreFile (($store | ConvertTo-Json -Depth 20) + "`r`n")
  return $true
}

$ProjectRoot = Resolve-FullPath $ProjectRoot '项目根目录'
$DesktopDataDir = Resolve-FullPath $DesktopDataDir 'DSH Desktop 数据目录'
$required = @('package.json', 'package-lock.json', 'AGENTS.md', 'src\mcp-server.mjs', '.dsh\skills')
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $relative))) { throw "项目不完整，缺少: $relative" }
}

Write-Step '检测 DSH Desktop 与运行环境'
$desktop = Find-DesktopInstall $DesktopInstallDir
$node = Find-Node $desktop.Root
$desktopApp = Join-Path $desktop.Root 'resources\app'
$mcpPackage = Join-Path $desktopApp 'node_modules\@deepseek-ai\dsh-mcp-client\package.json'
if (-not (Test-Path -LiteralPath $mcpPackage -PathType Leaf)) { throw '当前 DSH Desktop 未包含 @deepseek-ai/dsh-mcp-client。请升级 Desktop。' }
if ($node.Major -lt 24) { throw "Node.js 版本过低: $($node.Version)，需要 24+。" }
$harnessHome = Join-Path $DesktopDataDir 'harness'
$webProfile = Join-Path $harnessHome 'profiles\web\package.json'
if (-not (Test-Path -LiteralPath $webProfile -PathType Leaf)) {
  throw "DSH Desktop 尚未初始化：请先启动一次后关闭，再重新运行。未找到 $webProfile"
}
Write-Ok "DSH Desktop $($desktop.Version): $($desktop.Root)"
Write-Ok "Node $($node.Version) ($($node.Source)): $($node.Path)"
Write-Ok "项目: $ProjectRoot"

$presetRoot = Join-Path $harnessHome '.agent-presets'
$presetTarget = Join-Path $presetRoot $PresetId
$presetSource = Join-Path $desktopApp 'node_modules\@deepseek-ai\dsh-agent-presets\presets\standard'
$workspaceStore = Join-Path $harnessHome 'storages\workspace.json'
$profilePatch = Join-Path $harnessHome 'profiles\web\cordis.patch.yml'
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $harnessHome "pet-learning-backups\$timestamp"
$runningDesktop = @(
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '^DSH Desktop$|^dsh-desktop$' } |
    Where-Object {
      try { (Split-Path -Parent $_.Path) -ieq $desktop.Root } catch { $false }
    }
).Count -gt 0

if ($DiagnoseOnly) {
  Write-Step '诊断结果（未修改任何文件）'
  Write-Host "Preset source : $presetSource"
  Write-Host "Preset target : $presetTarget"
  Write-Host "Workspace DB  : $workspaceStore"
  Write-Host "Profile patch : $profilePatch"
  Write-Host "Desktop running: $runningDesktop"
  Write-Host "Preset installed: $(Test-Path -LiteralPath $presetTarget)"
  exit 0
}

if ($Uninstall) {
  Write-Step "移除 $PresetId 集成"
  if ($runningDesktop) { throw '请先完全退出 DSH Desktop，再运行卸载；避免运行中的服务覆盖配置。' }
  $manifestFile = Join-Path $presetTarget '.pet-learning-installer.json'
  if (Test-Path -LiteralPath $presetTarget) {
    if (-not (Test-Path -LiteralPath $manifestFile) -and -not $Force) {
      throw "目标 Preset 不是本安装器创建的，拒绝移除。需要时显式使用 -Force。"
    }
    [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    Move-Item -LiteralPath $presetTarget -Destination (Join-Path $backupRoot "removed-$PresetId")
    Write-Ok "Preset 已移入可恢复备份: $backupRoot"
  } else { Write-Warn 'Preset 不存在，无需移除。' }
  if (-not $SkipDesktopHardening) {
    Set-ManagedHardening $profilePatch $backupRoot $true
    Write-Ok '已移除安装器管理的 Desktop 遥测禁用配置。'
  }
  if ($RemoveWorkspace) {
    $changed = Update-WorkspaceStore $workspaceStore $ProjectRoot $backupRoot $true
    if ($changed) { Write-Ok '已移除项目工作区登记。' } else { Write-Warn '项目工作区未登记。' }
  }
  exit 0
}

if ($runningDesktop) {
  throw '请先完全退出 DSH Desktop，再运行安装器；Preset、Profile 与工作区配置只在 Desktop 关闭时更新。'
}

if (-not $SkipNpmInstall) {
  Write-Step '安装锁定的项目依赖'
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { throw '未找到 npm。请安装 Node.js 24+（包含 npm），或在已安装依赖时使用 -SkipNpmInstall。' }
  Push-Location $ProjectRoot
  try {
    & $npm.Source ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE" }
  } finally { Pop-Location }
  Write-Ok 'npm 依赖安装完成。'
} elseif (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\@modelcontextprotocol\sdk'))) {
  throw '已跳过 npm 安装，但 MCP 运行依赖不存在。请先运行 npm ci。'
}

Write-Step '初始化本地目录并加载安全入门课程'
Push-Location $ProjectRoot
try {
  & $node.Path (Join-Path $ProjectRoot 'src\cli.mjs') init
  if ($LASTEXITCODE -ne 0) { throw "项目初始化失败，退出码 $LASTEXITCODE" }
  & $node.Path (Join-Path $ProjectRoot 'src\cli.mjs') learning-seed
  if ($LASTEXITCODE -ne 0) { throw "入门课程加载失败，退出码 $LASTEXITCODE" }
} finally { Pop-Location }
Write-Ok '目录、目录库和纯合成入门课程已就绪。'

Write-Step "生成项目专用 Preset: $PresetId"
if (-not (Test-Path -LiteralPath $presetSource -PathType Container)) { throw "找不到官方 standard preset: $presetSource" }
if (Test-Path -LiteralPath $presetTarget) {
  $existingManifest = Join-Path $presetTarget '.pet-learning-installer.json'
  if (-not (Test-Path -LiteralPath $existingManifest) -and -not $Force) {
    throw "Preset '$PresetId' 已存在且不属于本安装器。请换 -PresetId，或检查后显式使用 -Force。"
  }
  Backup-ItemSafe $presetTarget $backupRoot "preset-$PresetId" | Out-Null
  Remove-Item -LiteralPath $presetTarget -Recurse -Force
}
[IO.Directory]::CreateDirectory($presetRoot) | Out-Null
Copy-Item -LiteralPath $presetSource -Destination $presetTarget -Recurse

$yamlFile = Join-Path $presetTarget 'agent.cordis.yml'
$lines = @(Get-Content -LiteralPath $yamlFile -Encoding UTF8)
$skillPath = Convert-ToYamlPath (Join-Path $ProjectRoot '.dsh\skills')
$nodePath = Convert-ToYamlPath $node.Path
$serverPath = Convert-ToYamlPath (Join-Path $ProjectRoot 'src\mcp-server.mjs')
$yamlRoot = Convert-ToYamlPath $ProjectRoot
$skillBlock = @(
  '- id: skill-filesystem',
  "  name: '@deepseek-ai/dsh-skill-filesystem'",
  '  config:',
  '    includeDefaultRoots: false',
  '    customSkillDirs:',
  "      - '$skillPath'",
  ''
)
$webBlock = @(
  '- id: tool-web',
  "  name: '@deepseek-ai/dsh-tool-web'",
  '  disabled: true',
  ''
)
$lines = Replace-TopLevelEntry $lines 'skill-filesystem' $skillBlock
$lines = Replace-TopLevelEntry $lines 'tool-web' $webBlock
$mcpBlock = @(
  '',
  '# pet-learning installer: project-scoped local evidence tools',
  '- id: mcp-pet-learning',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: pet_learning',
  '    transport: stdio',
  "    command: '$nodePath'",
  '    args:',
  "      - '$serverPath'",
  "    cwd: '$yamlRoot'",
  '    env:',
  "      PET_LEARNING_ROOT: '$yamlRoot'",
  '    failOnStartupError: true',
  ''
)
Write-Utf8Atomic $yamlFile ((@($lines + $mcpBlock) -join "`r`n").TrimEnd() + "`r`n")
$presetMeta = @"
name: 宠物医疗工作与学习
description: 本地优先的宠物医疗证据检索、候选记忆与工作学习记录；网络工具关闭。
order: 90
"@
Write-Utf8Atomic (Join-Path $presetTarget 'preset.yml') ($presetMeta.TrimEnd() + "`r`n")
$installManifest = [ordered]@{
  schemaVersion = 1
  installerVersion = $InstallerVersion
  presetId = $PresetId
  projectRoot = $ProjectRoot
  desktopVersion = $desktop.Version
  nodePath = $node.Path
  installedAt = [DateTime]::UtcNow.ToString('o')
}
Write-Utf8Atomic (Join-Path $presetTarget '.pet-learning-installer.json') (($installManifest | ConvertTo-Json -Depth 5) + "`r`n")
Write-Ok "Preset 已写入: $presetTarget"

if (-not $SkipDesktopHardening) {
  Write-Step '应用 DSH Desktop 安全基线'
  Set-ManagedHardening $profilePatch $backupRoot $false
  Write-Ok '已关闭 DSH Desktop 会话遥测与会话贡献（影响此 Desktop 的所有会话）。'
}

if (-not $SkipWorkspaceRegistration) {
  Write-Step '登记项目工作区'
  $changed = Update-WorkspaceStore $workspaceStore $ProjectRoot $backupRoot $false
  if ($changed) { Write-Ok "已登记工作区: $ProjectRoot" } else { Write-Ok '工作区已经存在，未重复创建。' }
}

Write-Step '执行本地 MCP 冒烟测试'
Push-Location $ProjectRoot
try {
  & $node.Path --test test\mcp.test.mjs
  if ($LASTEXITCODE -ne 0) { throw "MCP 测试失败，退出码 $LASTEXITCODE" }
} finally { Pop-Location }
Write-Ok 'MCP 工具发现、检索和候选记忆写入测试通过。'

if (-not $NoLaunch -and -not $runningDesktop) {
  $executable = Join-Path $desktop.Root 'DSH Desktop.exe'
  if (Test-Path -LiteralPath $executable) {
    Start-Process -FilePath $executable
    Write-Ok '已启动 DSH Desktop。'
  }
}

Write-Host "`n配置完成。" -ForegroundColor Green
Write-Host "1. 在 DSH Desktop 中选择工作区：$ProjectRoot"
Write-Host "2. 新建空白会话，并在发送第一条消息前选择 Preset：$PresetId"
Write-Host '3. 测试提示词：请调用 mcp__pet_learning__list_learning_path 列出学习路径。'
if (Test-Path -LiteralPath $backupRoot) { Write-Host "本次备份：$backupRoot" }
