# Schema v6：受控外部 OCR/ASR

版本 6 增加 `external_processing_run`，用于记录一次外部 OCR 或 ASR 的版本、能力、服务商、模型、请求指纹、状态、派生物、服务商追踪 ID、非敏感响应摘要、错误和完成时间。

API Key 只从当前 CLI 进程环境或项目外的受限凭据文件读取，不进入 SQLite、派生物、审计事件或日志。DSH 子进程会清除凭据形环境变量，因此推荐使用 `setup-siliconflow.ps1` 创建的用户私有凭据文件。相同原件哈希、能力、模型和提示词组成稳定请求指纹；成功请求再次执行时直接返回原有派生物，不重复计费。

## 启用条件

外部处理同时要求：

- `dataPolicy.externalTransmissionAllowed=true`；
- 内部来源额外要求 `realCompanyDataApproved=true`；
- `network.approvedServices` 明确包含 `https://api.siliconflow.cn`；
- `PET_LEARNING_ALLOW_EXTERNAL_PROCESSING=1`；
- `SILICONFLOW_API_KEY` 存在于当前 CLI 进程环境，或 `SILICONFLOW_CREDENTIAL_FILE` 指向项目目录外、最大 4 KiB 的凭据文件。

任一条件缺失都会在读取原件后、网络请求前停止。原件哈希不一致同样停止。

## 定位边界

- 图片 OCR 使用 `image_ocr` 定位。
- PDF OCR 在供应商未给出可靠页级映射时使用 `document_ocr` 和 `pageMapping=not-provided`。
- ASR 在供应商只返回整段文本时使用 `media_transcript` 和 `timing=not-provided`。

上述定位不会被升级成页码或时间戳。需要精确时间定位时，仍应提供 VTT 或带起止毫秒的转录 JSON。
