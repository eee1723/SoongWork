<#
.SYNOPSIS
批量接收、解析学习资料；可显式启用已获授权的 SiliconFlow OCR/ASR。

.EXAMPLE
.\scripts\import-learning-materials.ps1 -SourceDir 'Z:\EEE_Project\mimi-learning\reference'

.EXAMPLE
.\scripts\import-learning-materials.ps1 -SourceDir 'Z:\EEE_Project\mimi-learning\reference' -ExternalMedia
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDir,
  [ValidateSet('internal', 'confidential', 'deidentified', 'synthetic', 'public')]
  [string]$Confidentiality = 'internal',
  [string]$SourceDomain = 'training_materials',
  [switch]$NoRecurse,
  [switch]$ExternalMedia
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Get-Command node -ErrorAction Stop
$resolvedSource = [IO.Path]::GetFullPath($SourceDir)
if (-not (Test-Path -LiteralPath $resolvedSource -PathType Container)) { throw "资料目录不存在: $resolvedSource" }

Write-Host "项目：$projectRoot" -ForegroundColor Cyan
Write-Host "资料：$resolvedSource" -ForegroundColor Cyan
Write-Host "递归：$(-not $NoRecurse)；外部 OCR/ASR：$([bool]$ExternalMedia)" -ForegroundColor Cyan
if ($ExternalMedia) {
  Write-Host '注意：图片、扫描 PDF、PPT 内嵌图片和音频可能完整发送给 SiliconFlow。项目门禁仍会在未授权时阻止请求。' -ForegroundColor Yellow
}

Push-Location $projectRoot
try {
  $arguments = @(
    (Join-Path $projectRoot 'src\cli.mjs'), 'import-directory',
    '--source-dir', $resolvedSource,
    '--recursive', $((-not $NoRecurse).ToString().ToLowerInvariant()),
    '--external-media', $ExternalMedia.ToString().ToLowerInvariant(),
    '--confidentiality', $Confidentiality,
    '--source-domain', $SourceDomain
  )
  & $node.Source @arguments
  $exitCode = $LASTEXITCODE
} finally { Pop-Location }

if ($exitCode -eq 2) { throw '批量导入已完成，但至少一个文件失败。请查看输出中的 reportRelativePath。' }
if ($exitCode -ne 0) { throw "批量导入失败，退出码 $exitCode" }
Write-Host '批量导入完成。可以运行 npm run dashboard 查看结果。' -ForegroundColor Green
