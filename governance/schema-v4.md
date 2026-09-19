# Catalog schema v4

v4 补齐多模态与运行治理对象。

| 对象 | 作用 |
| --- | --- |
| source_snapshot | 保存请求 URL、最终 URL、抓取时间、内容类型、许可范围和 HTTP 状态。 |
| transcript_attachment | 把 raw/corrected VTT 或 JSON、哈希和派生 artifact 绑定到媒体版本。 |
| media_keyframe | 保存视频时间点、图片路径/哈希和说明；不声称采样覆盖全部画面。 |
| usage_ledger | 记录页数、媒体/ASR 分钟、token、embedding、rerank、原件与备份字节以及可选实际成本。 |
| source_deletion | 删除后只保留来源墓碑、时间、执行者和执行前影响清单。 |

v3 → v4 使用事务迁移。删除时先把原件与派生目录移入项目内暂存区，再在事务中清除正文/索引/引用并写墓碑；事务失败则将目录移回。现有离线备份不自动删除。
