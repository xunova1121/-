# AI影视Studio V0.1

面向 AI 短剧、网剧、动画与微电影的一体化 Windows 桌面生产工作站。

## 当前完成范围

- C# WPF / .NET 8 桌面客户端骨架
- 导演、剧本、分镜、制作、剪辑、资产、任务工作区切换
- 参考设计图实现的深色剪辑工作台
- 项目、分镜、资产、校对、任务队列 API
- FastAPI + SQLite 本地服务
- 可替换的 AI Adapter 接口和 Mock Adapter
- Swagger 接口文档与健康检查
- 后端自动化测试
- 项目、镜头、任务真实 CRUD
- 六阶段断点续跑 checkpoint
- Windows 打包时内置本地服务 EXE
- GitHub Actions 自动生成 Windows x64 成品包
- 版本化 Story Bible（世界、角色、场景、道具、风格）
- 全量分镜 Episode Lock，未通过连续性门禁不得进入批量生成
- 镜间动作、道具、环境、机位连续性契约
- 多维质量评分与“只重做失败环节”的自动修复计划
- 空间预演数据模型：虚拟摄影机、焦段、人物走位、地标与太阳光位
- 智能转场决策：VACE 双侧上下文补缝、首尾帧桥接、RIFE 与 FFmpeg 回退链
- 一键生成整集八阶段自动化执行图
- 持久化后台任务执行器：优先级、租约、指数退避重试、取消与崩溃恢复
- 可操作的桌面任务中心：创建、刷新、取消、重试与结果状态

## 目录

```text
AI-Film-Studio/
├── client/AI.FilmStudio/       # WPF 客户端
├── server/                     # FastAPI 本地服务
├── scripts/                    # Windows 启动/打包脚本
└── docs/                       # 开发说明
```

## Windows 开发运行

前置环境：Windows 10/11、.NET 8 SDK、Python 3.11+。

```powershell
./scripts/start-dev.ps1
```

也可分别启动：

```powershell
cd server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 18118

cd ../client/AI.FilmStudio
dotnet run
```

接口文档：`http://127.0.0.1:18118/docs`

## 成品包使用

1. 必须先完整解压 ZIP，不能直接在压缩包预览中运行。
2. 双击根目录的 `AI-Film-Studio.exe`；不要单独移动 EXE，旁边的 DLL 与 `service` 目录是运行必需文件。
3. 如果启动失败，查看 `%LOCALAPPDATA%\AI-Film-Studio\logs\desktop.log` 与同目录服务日志。

## 打包 EXE

```powershell
./scripts/package-win.ps1
```

输出目录：`dist/AI影视Studio/`。桌面客户端发布为自包含 win-x64 EXE，本地 FastAPI 服务使用 PyInstaller 封装为独立进程；打包流水线会对服务 EXE 执行健康检查冒烟测试。
