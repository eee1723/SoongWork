# Catalog schema v3

v3 在证据契约上增加长期工作状态：`source_relation`、`conflict_group/member`、`processing_job`、`backend_mapping`、`concept`、`term_alias`、`knowledge_relation`、`memory_item`、`work_log` 与 `learning_log`。

处理状态、审核状态和有效性仍相互独立。关系与概念默认 `draft`；记忆默认候选，确认、撤销和替换保留来源及审计；任务使用 project/version/parser-set 幂等键并持久记录重试次数和错误。

v2 → v3 在一个 SQLite 事务内迁移。现有原件、block 和 citation 标识不改变。
