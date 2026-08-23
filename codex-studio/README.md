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

## 打包 EXE

```powershell
./scripts/package-win.ps1
```

输出目录：`dist/AI影视Studio/`。当前 V0.1 将 WPF 客户端发布为自包含 win-x64 EXE；本地服务仍以源码方式随包启动，下一阶段可使用 PyInstaller 封装为独立服务进程。
