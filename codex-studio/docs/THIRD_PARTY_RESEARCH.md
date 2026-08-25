# 第三方调研与采用边界

本项目只复用许可清晰的代码或公开接口；许可证不明确时只借鉴产品概念，不复制实现。

| 项目 | 许可证 | 采用内容 |
| --- | --- | --- |
| HKUDS/ViMax | MIT | Agent 化叙事规划、资产生成、装配分层思路 |
| Forget-C/Jellyfish | Apache-2.0 | 资产候选确认、统一异步任务、镜头 readiness 思路 |
| stuttlepress/ComfyUI-Wan-VACE-Video-Joiner | MIT | 双侧上下文帧、替换接缝坏帧、VACE 失败回退思路 |
| AcademySoftwareFoundation/OpenTimelineIO | Apache-2.0 | 借鉴媒体引用、文件存在性门禁和可移植产物清单思想；本版本未复制代码或引入运行时依赖，后续再实现 OTIO 交换 |
| wonderunit/shot-generator-models | MIT | 借鉴角色、物体、灯光和相机同台布置的 Shot Generator 产品模型，不复制资源或代码 |
| alibaba/lumenx | MIT | 借鉴项目上下文贯穿剧本、分镜、资产、视频与导出的流水线原则；本项目独立实现镜头—预演版本生产契约 |
| BerriAI/litellm | MIT（`enterprise/` 除外） | 只借鉴统一模型目录、能力路由与请求记录的网关分层思想，不复制源码、不引入依赖 |
| Blender Storypencil | GPL-3.0 | 只借鉴场景—镜头—故事板的工作流与机位预演体验，不复制代码、不形成运行时依赖 |
| HaD0Yun/CozyClay | 未确认 | 只借鉴虚拟摄影机、人物走位、镜头时间线概念，不复制代码 |
| morphicfilms/frames-to-video | Apache-2.0，已归档 | 只保留多关键帧插值适配思路 |
| joaofernandes/comfystudio | MIT | 桌面 AI 视频工作站、项目级任务与导出编排思路 |
| SaladTechnologies/comfyui-api | MIT | 长耗时 ComfyUI 工作流的队列、状态与回调边界 |
| itsjwill/vanta | MIT | 程序化时间线、可组合转场与渲染管线思路 |
| VelornLabs/velorn | GPL-3.0 | 只观察本地工作站和工具调用体验，不复制代码 |
| mikehalleen/the-halleen-machine | AGPL-3.0 | 只观察批处理和资产管理体验，不复制代码 |

核心实现均在本项目内重新设计：WPF 原生客户端、FastAPI 模块服务、SQLite 本地数据层。
