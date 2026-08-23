# V0.1 开发说明

## 进程架构

1. `AI影视Studio.exe`：WPF 桌面界面与用户交互。
2. `FastAPI`：本地任务、项目数据、AI Gateway 与模型适配。
3. `SQLite`：项目、镜头、资产记忆与任务状态。

客户端默认访问 `http://127.0.0.1:18118/api/v1`。服务不可用时自动进入离线演示模式，界面仍可打开。

## AI Adapter 扩展

新的模型接入需实现 `server/app/adapters/base.py` 中的 `AIAdapter`，随后注册到 `AdapterRegistry`。上层业务只调用统一 Gateway，不直接依赖 GPT、Claude、Qwen、FLUX、Wan 或 Kling。

## 下一阶段

- 将 WPF 页面拆为 MVVM 工作区与可复用控件
- 接入项目创建、剧本保存、分镜编辑的真实 CRUD
- PyInstaller 封装本地服务并由客户端管理生命周期
- 引入后台任务队列、断点续传与失败重试
- 接入 FFmpeg 时间线预览和导出
- 建立 Character / Scene / Prop / Motion Memory 向量检索
- 增加 API 密钥加密存储和模型配置中心
- 补齐 Windows 安装程序、自动更新和崩溃日志

## 从 Claude 版本吸收的设计

- 六阶段可断点流水线：设定集 → 分镜 → 镜头出图 → 视频生成 → 配音音效 → 剪辑合成
- 声明式服务商目录与按能力独立路由
- 连续性关系明确分为 `new-scene`、`cut`、`continuous`
- 连续动作提示词约束、越轴和光照突变检测
- 后续加入开机预检、脱敏请求日志、FFmpeg 实拍验证和 Windows 密钥加密

没有直接复制原 Node/Electron 单体实现；以上能力已适配到当前 FastAPI + WPF 的模块化边界。
