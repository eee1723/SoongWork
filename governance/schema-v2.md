# Catalog schema v2

v2 在 v1 的来源与审计对象上增加后端无关的证据契约。

| 对象 | 作用 | 关键约束 |
| --- | --- | --- |
| artifact | 某来源版本的一次解析产物 | 记录 parser 名称/版本、派生文件路径与哈希；不覆盖原件。 |
| block | 可检索且可定位的正文块 | 稳定 block_id、version_id、顺序、locator、正文哈希。 |
| block_fts | 可重建的本地检索投影 | FTS5 trigram；少于三字符或无召回时走精确子串兜底。 |
| claim | 待审结论 | 初建固定为 draft，风险与审核状态分离。 |
| citation | 结论到证据块的边 | 保存 version_id、block_id、locator 快照、正文哈希及支持/反驳角色。 |

解析器集合包括 UTF-8 TXT/Markdown/消息、PDF、DOCX、PPTX、静态 HTML、VTT 与转录 JSON，并分别保留物理行、页、段落、幻灯片/备注和时间范围定位。artifact 与 block ID 由版本、解析器和内容确定；同一不可变版本重复处理是幂等的。

引用校验同时检查：原件文件仍存在且 SHA-256 与 source_version 一致、当前块正文与引用 excerpt_hash 一致、locator 未被改变。任一失败都返回 `valid: false`，不猜测替代位置。

v1 → v2 迁移由 `openCatalog` 在事务内执行。程序拒绝打开高于自身支持版本的账本，也拒绝 schema 降级。
