# Catalog schema v1

当前账本由 `runtime/catalog.sqlite` 承载，原件与 `manifest.json` 才是可人工检查的持久证据。SQLite 不是第三方插件内部数据库，也不存储向量索引。

核心对象：

- `source`：稳定来源身份、项目、类型、标题、来源域和保密级别。
- `source_version`：内容哈希、不可变原件相对路径、处理/审核/有效性三组独立状态。
- `intake_submission`：每次提交均保留；重复内容复用已有版本，但不会吞掉提交事件。
- `audit_event`：记录接收和重复接收。所有时间均为 UTC ISO 8601。

v1 当时有意未包含 artifact/block、claim/citation、backend_mapping、relation 和 memory；这些对象后来已通过 v2–v4 显式事务迁移加入，未修改第三方数据库内部表。

恢复原则：原件目录、manifest、catalog、配置和审计必须形成一致快照。当前实现使用 SQLite backup API 生成在线一致备份，并以文件哈希清单验证空环境恢复，不直接复制运行中的主文件而遗漏 WAL。
