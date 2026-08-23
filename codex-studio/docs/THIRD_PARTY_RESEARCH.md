# 第三方调研与采用边界

本项目只复用许可清晰的代码或公开接口；许可证不明确时只借鉴产品概念，不复制实现。

| 项目 | 许可证 | 采用内容 |
| --- | --- | --- |
| HKUDS/ViMax | MIT | Agent 化叙事规划、资产生成、装配分层思路 |
| Forget-C/Jellyfish | Apache-2.0 | 资产候选确认、统一异步任务、镜头 readiness 思路 |
| stuttlepress/ComfyUI-Wan-VACE-Video-Joiner | MIT | 双侧上下文帧、替换接缝坏帧、VACE 失败回退思路 |
| AcademySoftwareFoundation/OpenTimelineIO | Apache-2.0 | 后续采用帧精确时间线交换标准 |
| HaD0Yun/CozyClay | 未确认 | 只借鉴虚拟摄影机、人物走位、镜头时间线概念，不复制代码 |
| morphicfilms/frames-to-video | Apache-2.0，已归档 | 只保留多关键帧插值适配思路 |

核心实现均在本项目内重新设计：WPF 原生客户端、FastAPI 模块服务、SQLite 本地数据层。
