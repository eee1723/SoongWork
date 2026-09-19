# 知识后端依赖风险记录

检查日期：2026-09-19。

候选 `dsh-knowledge@0.4.0` 已下载到隔离的 `runtime/dsh-home/profiles/headless`，但安装命令未完成 bundle 登记，`cordis.patch.yml` 仍为空；因此 DSH 当前不会加载该插件。

`pnpm audit --prod` 报告两条 High，路径均为：

```text
dsh-knowledge > @huggingface/transformers > sharp@0.34.5
```

| Advisory | 范围 | 修复版本 | 当前判断 |
| --- | --- | --- | --- |
| GHSA-f88m-g3jw-g9cj | sharp/libvips，`<0.35.0` | `>=0.35.0` | 上游安全策略已记录临时例外，但仍不等于本项目批准。 |
| GHSA-rgj7-g3m4-5g8c | sharp/libheif，`<0.35.4` | `>=0.35.4` | 上游当前安全说明未列出，必须重新评估。 |

插件同时使用 AGPL-3.0，企业分发或服务化方式需要许可审查。当前处置为 quarantine：不注册、不启动、不导入资料。不得用忽略审计或宽泛允许构建脚本的方式绕过。

已允许的 profile 构建脚本只有 `onnxruntime-node`、`protobufjs`、`sharp`；`tesseract.js` 保持禁止。允许构建仅表示评估所需二进制可安装，不表示依赖已获生产批准。
