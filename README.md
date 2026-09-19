# 宠物医疗工作与学习系统

一个单人、本地优先、证据可追溯的工作与学习项目。它保存不可变原件，以 SQLite 维护来源、版本、定位、引用、冲突、记忆候选、工作/学习记录和用量台账，并通过本机看板与 DSH stdio MCP 提供受控访问。

当前可用于虚构或已脱敏资料。`realCompanyDataApproved` 与外部传输默认关闭；这不是独立诊断、处方或临床决策系统。

## 快速开始

要求 Node.js 24+。

```powershell
npm install
npm run init
npm run verify
npm run dashboard
```

看板只监听 `http://127.0.0.1:3210`。`npm run verify` 会依次运行全量测试、60 条合成检索评估、性能基线、P0 自检、完整性检查和依赖审计。

## 一键接入 DSH Desktop

支持 Windows 10/11 与 DSH Desktop 0.9.x。先安装并启动一次 DSH Desktop，然后完全退出；安装 Node.js 24+ 后，在项目根目录双击：

```text
setup-dsh-desktop.cmd
```

安装器会自动检测 DSH Desktop、Node.js 和用户数据目录，执行锁定依赖安装与 MCP 冒烟测试，并完成以下配置：

- 从当前 Desktop 自带的 `standard` 复制项目专用 `pet-learning` Preset，不改官方 Preset；
- 只加载本项目 `.dsh/skills`，注册 `pet_learning` 本地 stdio MCP，并关闭该 Preset 的网页工具；
- 把当前项目登记到 DSH Desktop 工作区；
- 用可识别的托管配置关闭 Desktop 会话遥测与会话贡献。此项影响当前 Desktop 的所有会话，可用 `-SkipDesktopHardening` 跳过；
- 修改前把已有文件备份到 DSH Desktop 数据目录下的 `harness/pet-learning-backups/`。

安装成功后，在 DSH Desktop 中打开本项目工作区，新建空白会话，并在发送第一条消息前选择“宠物医疗工作与学习”Preset。可用下面的提示词确认 MCP 已接通：

```text
请调用 mcp__pet_learning__list_sources 列出当前项目资料。
```

常用维护命令：

```powershell
# 只诊断，不修改任何文件
npm run desktop:diagnose

# 命令行安装；也可以继续双击 setup-dsh-desktop.cmd
npm run desktop:setup

# 更新项目或 DSH Desktop 后重复执行即可，旧配置会先备份
setup-dsh-desktop.cmd

# 卸载 Preset 和安装器管理的安全配置，默认保留工作区与会话历史
uninstall-dsh-desktop.cmd

# 同时移除无关联会话的工作区登记
uninstall-dsh-desktop.cmd -RemoveWorkspace
```

安装器不会读取或写入模型密钥，不会删除会话历史，也不会把此 Preset 设为其他项目的全局默认值。目标 Preset 与已有用户 Preset 同名时会安全停止；只有明确传入 `-Force` 才会先备份再替换。完整参数可运行 `Get-Help .\scripts\setup-dsh-desktop.ps1 -Detailed` 查看。

## 资料接收与证据

```powershell
# 文件或消息：先保存原件，再显式解析
node src/cli.mjs intake-file --file "C:\path\sample.pdf" --title "示例资料" --source-type document
node src/cli.mjs intake-message --message-id "demo-001" --text "示例消息"
node src/cli.mjs parse --version-id "VER-..."

# 支持 TXT/MD、PDF、DOCX、PPTX、静态 HTML、VTT、转录 JSON
node src/cli.mjs search --query "检验"
node src/cli.mjs create-claim --statement "示例结论" --risk low
node src/cli.mjs cite-claim --claim-id "CLM-..." --block-id "BLK-..." --role supports
node src/cli.mjs verify-citations

# 新版本显式替代旧版本；旧版不会继续冒充现行
node src/cli.mjs intake-file --file "C:\path\v2.pdf" --source-id "SRC-..." --supersedes-version-id "VER-old"
```

原件位于 `sources/<source_id>/<version_id>/original/`，不会覆盖旧版本。解析产物位于 `derived/`，每个引用都绑定 `source_id`、`version_id`、`block_id` 和页/幻灯片/段落/行号/时间范围。

## 网页与多媒体

网页抓取默认不可用。先把允许的 HTTPS 主机名或 origin 写入 `config/project.json` 的 `network.approvedServices`；抓取前和每次重定向都会做白名单与公网地址检查。

```powershell
node src/cli.mjs intake-url --url "https://approved.example/page" --permitted-scope "公开页面，允许内部学习存档"

# 不自动调用外部 ASR；挂接人工提供的原始或校订 VTT/JSON
node src/cli.mjs attach-transcript --version-id "VER-media" --file "C:\path\corrected.vtt" --kind corrected --language zh-CN
node src/cli.mjs attach-keyframe --version-id "VER-video" --file "C:\path\frame.png" --time-ms 63000 --description "屏幕显示的流程图"
```

原始与校订转写并存，时间定位回到媒体原件；系统不会把“提供了转写”误报成“已运行 ASR”。

## 版本、记忆与记录

```powershell
node src/cli.mjs create-conflict --title "两个制度版本冲突" --versions "VER-a,VER-b"
node src/cli.mjs resolve-conflict --conflict-id "CNF-..." --resolution "经负责人确认采用 VER-b"
node src/cli.mjs add-concept --name "样本" --aliases "标本,specimen"

# 默认创建候选；确认、撤销和替换都有审计事件
node src/cli.mjs add-memory --category preference --content "先例子后概念"
node src/cli.mjs review-memory --memory-id "MEM-..." --action confirm
node src/cli.mjs list-memories

node src/cli.mjs work-log --date 2026-09-19 --task "完成脱敏资料核对" --progress "已完成"
node src/cli.mjs learning-log --date 2026-09-19 --topic "样本管理" --status learning --review-on 2026-09-26
```

## 队列、治理、备份与删除

```powershell
node src/cli.mjs enqueue-parse --version-id "VER-..."
node src/cli.mjs run-jobs --max-attempts 3
node src/cli.mjs integrity
node src/cli.mjs export-catalog
node src/cli.mjs backup
node src/cli.mjs restore --backup "C:\path\backup" --target "C:\empty-target"

node src/cli.mjs record-usage --metric llm_input_tokens --quantity 1200 --provider approved-provider --cost-minor 8 --currency CNY
node src/cli.mjs usage-summary

# 先预览；真正删除要求同一个 source_id 再确认
node src/cli.mjs delete-impact --source-id "SRC-..."
node src/cli.mjs delete-source --source-id "SRC-..." --confirm-source-id "SRC-..."
```

删除会移除当前项目内的原件、派生物、正文块和引用，保留不含正文的墓碑与审计记录；已存在的备份不会被偷偷删除，影响预览会单独报告。

## DSH 接入

`npm run dsh:safe -- <参数>` 使用精确锁定的 `@deepseek-ai/dsh@0.1.5-rc.2`、独立 `runtime/dsh-home`、只读默认权限、项目内 Skills，以及 `pet_learning` 本地 stdio MCP。展开配置可用 `npm run dsh:config` 查看。

MCP 暴露 `search_evidence`、`list_sources`、`get_evidence_block`、`check_integrity`、`add_memory_candidate`、`add_work_log`、`add_learning_log`。模型不能通过该接口直接确认记忆、删除资料、覆盖已审结论或访问网络。

DSH Desktop 使用上方的一键安装器；`npm run dsh:safe` 是独立终端模式，两者共享同一个本地项目与 MCP 服务，但配置目录互不覆盖。

除非显式设置 `PET_LEARNING_ALLOW_EXTERNAL_MODEL=1`，安全启动器不会向 DSH 传递模型密钥；即使设置该变量，也不代表真实公司资料已经获准外发。

## 已知边界

- `dsh-knowledge@0.4.0` 因 High 级依赖告警和 AGPL 审查保持隔离，未注册到 DSH；当前正式后端是项目自有本地 catalog。
- OCR、自动 ASR、自动视频关键帧和外部 embedding 未启用；需要时必须另做依赖、许可、硬件和数据流验收。
- AGENTS 与 Skills 的文件发现、MCP 协议和持久化已自动测试；真实 DSH 模型会话中的提示词哨兵仍需要获批模型凭据后观察验证。
- 真实公司资料和病例资料仍被配置门禁阻止。P0 兼容报告位于 `governance/p0-compatibility-report.md`。
