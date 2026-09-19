<#
.SYNOPSIS
在当前 Windows 用户范围内安全配置 SiliconFlow 凭据文件，或检查/移除该配置。

.DESCRIPTION
密钥通过安全输入读取，保存到项目目录之外的 %APPDATA%\pet-learning\secrets，文件 ACL
仅授予当前用户。脚本不会打印密钥、修改项目外传许可或调用网络。
#>
[CmdletBinding()]
param(
  [switch]$DiagnoseOnly,
  [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$secretDirectory = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'pet-learning\secrets'))
$secretFile = Join-Path $secretDirectory 'siliconflow.key'

function Write-Status([string]$Label, [bool]$Ok, [string]$Detail) {
  $mark = if ($Ok) { '[OK]' } else { '[NEEDS ACTION]' }
  $color = if ($Ok) { 'Green' } else { 'Yellow' }
  Write-Host "$mark $Label - $Detail" -ForegroundColor $color
}

if ($Remove) {
  $managed = [Environment]::GetEnvironmentVariable('SILICONFLOW_CREDENTIAL_FILE', 'User')
  if ($managed -and ([IO.Path]::GetFullPath($managed) -ieq $secretFile) -and (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    Remove-Item -LiteralPath $secretFile -Force
    Write-Host "已删除托管凭据文件：$secretFile" -ForegroundColor Green
  }
  [Environment]::SetEnvironmentVariable('SILICONFLOW_CREDENTIAL_FILE', $null, 'User')
  [Environment]::SetEnvironmentVariable('PET_LEARNING_ALLOW_EXTERNAL_PROCESSING', $null, 'User')
  Write-Host '已移除当前 Windows 用户的 SiliconFlow 外部处理环境配置。请重启终端和 DSH Desktop。' -ForegroundColor Green
  exit 0
}

$config = Get-Content -LiteralPath (Join-Path $projectRoot 'config\project.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$userCredentialFile = [Environment]::GetEnvironmentVariable('SILICONFLOW_CREDENTIAL_FILE', 'User')
$userExternalFlag = [Environment]::GetEnvironmentVariable('PET_LEARNING_ALLOW_EXTERNAL_PROCESSING', 'User')

if ($DiagnoseOnly) {
  Write-Status '凭据文件环境变量' ([bool]$userCredentialFile) $(if ($userCredentialFile) { $userCredentialFile } else { '未设置' })
  Write-Status '凭据文件存在' ($userCredentialFile -and (Test-Path -LiteralPath $userCredentialFile -PathType Leaf)) '只检查存在性，不读取或显示密钥'
  Write-Status '本机显式开关' ($userExternalFlag -eq '1') "PET_LEARNING_ALLOW_EXTERNAL_PROCESSING=$userExternalFlag"
  Write-Status '项目外传许可' ([bool]$config.dataPolicy.externalTransmissionAllowed) "externalTransmissionAllowed=$($config.dataPolicy.externalTransmissionAllowed)"
  $approved = @($config.network.approvedServices) -contains 'https://api.siliconflow.cn'
  Write-Status 'SiliconFlow 域名白名单' $approved 'https://api.siliconflow.cn'
  Write-Status '内部资料许可' ([bool]$config.dataPolicy.realCompanyDataApproved) "realCompanyDataApproved=$($config.dataPolicy.realCompanyDataApproved)"
  exit 0
}

$secure = Read-Host '请输入 SiliconFlow API Key（输入不会显示）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if (-not $plain -or $plain.Trim().Length -lt 8) { throw 'API Key 为空或过短' }
  [IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
  [IO.File]::WriteAllText($secretFile, $plain.Trim(), [Text.UTF8Encoding]::new($false))
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $plain = $null
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$account = [Security.Principal.NTAccount]::new($identity)
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($account)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  $account, [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
))
Set-Acl -LiteralPath $secretFile -AclObject $acl

[Environment]::SetEnvironmentVariable('SILICONFLOW_CREDENTIAL_FILE', $secretFile, 'User')
[Environment]::SetEnvironmentVariable('PET_LEARNING_ALLOW_EXTERNAL_PROCESSING', '1', 'User')

Write-Host "凭据已保存到项目外部并限制为当前用户访问：$secretFile" -ForegroundColor Green
Write-Host '已设置当前 Windows 用户的外部处理开关；请完全重启终端和 DSH Desktop。' -ForegroundColor Green
if (-not $config.dataPolicy.externalTransmissionAllowed) {
  Write-Host '项目 externalTransmissionAllowed 仍为 false；确认获得外传许可后再手工修改 config/project.json。' -ForegroundColor Yellow
}
if (-not (@($config.network.approvedServices) -contains 'https://api.siliconflow.cn')) {
  Write-Host '项目尚未把 https://api.siliconflow.cn 加入 network.approvedServices。' -ForegroundColor Yellow
}
