# Schema v5：证据驱动学习层

版本 5 在既有来源—版本—派生物—正文块—引用链上增加可迁移的学习层。

## 新表

- `learning_stage`、`learning_lesson`：有序阶段与课节，课程内容带草稿/审核/拒绝状态。
- `lesson_quiz`、`lesson_progress`：服务端保存答案和解释；客户端只读取问题与选项。个人笔记和学习状态持久化在本地 SQLite。
- `lesson_evidence`：可以是 `pending` 的旧来源线索，也可以是绑定当前 `version_id` + `block_id` 的 `resolved` 证据；检查约束阻止两种状态混淆。
- `lesson_external_reference`：HTTPS 参考链接独立保存审核状态和最后核对日期。
- `glossary_entry`、`glossary_evidence`：白话词典及其可选证据映射。
- `learning_issue`、`conflict_brief`：保留待解决问题和冲突教学材料，不自动裁决。
- `learning_import`：记录来源、内容分类、哈希、导入时间和汇总，保证相同课程包幂等。
- `derived_file`：保存 PPTX 内嵌图片等非正文派生文件的路径、哈希和真实定位。

## 安全边界

导入内容必须声明为 `synthetic`、`deidentified` 或 `internal`。`internal` 仅在项目配置明确批准真实公司资料时允许。导入器不会读取或复制旧项目的原件目录；旧课程中的文件名和页码只进入 `pending` 线索。

删除来源时，已解析的课节证据会退回 `pending` 并保留已删除版本提示；词典证据和派生文件会随受控删除流程清理。导出、备份和完整性检查均覆盖 v5 表与派生文件。
