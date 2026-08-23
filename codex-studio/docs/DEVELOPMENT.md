# V1.0 开发说明

## 进程架构

1. `AI影视Studio.exe`：WPF 桌面界面与用户交互。
2. `FastAPI`：本地任务、项目数据、AI Gateway 与模型适配。
3. `SQLite`：项目、镜头、资产记忆与任务状态。

正式客户端每次启动为内置服务分配独立回环端口，并使用版本号与随机实例 ID 完成握手；不会连接到残留旧服务。开发模式默认访问 `http://127.0.0.1:18118/api/v1`。

## AI Adapter 扩展

新的模型接入需实现 `server/app/adapters/base.py` 中的 `AIAdapter`，随后注册到 `AdapterRegistry`。上层业务只调用统一 Gateway，不直接依赖 GPT、Claude、Qwen、FLUX、Wan 或 Kling。

## 后续工程化方向

- 将 WPF 页面拆为 MVVM 工作区与可复用控件
- 建立 Character / Scene / Prop / Motion Memory 向量检索
- 补齐 Windows 安装程序、自动更新和崩溃日志

## 从 Claude 版本吸收的设计

- 六阶段可断点流水线：设定集 → 分镜 → 镜头出图 → 视频生成 → 配音音效 → 剪辑合成
- 声明式服务商目录与按能力独立路由
- 连续性关系明确分为 `new-scene`、`cut`、`continuous`
- 连续动作提示词约束、越轴和光照突变检测
- 后续加入开机预检、脱敏请求日志、FFmpeg 实拍验证和 Windows 密钥加密

没有直接复制原 Node/Electron 单体实现；以上能力已适配到当前 FastAPI + WPF 的模块化边界。
