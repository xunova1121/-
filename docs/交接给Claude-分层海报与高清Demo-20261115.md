# 给 Claude：分层图文海报与同稿高清 Demo

用户已明确批准全套方案并要求开发、发版，无需重新问逐项授权。本批不涉及 DSH。先看[执行记录](图文海报与同稿Demo-执行记录-20261115.md)，发布状态以该文末补记及机器验收记录为准；本文件不是 Claude 已审核的证明。

## 为什么改

用户附件《帮我写一个网页.md》是排查证据，不是执行其中历史命令的授权。旧海报主要只有一个文字面板、渐变和两个圆，没有独立图标/卡片API；“重排”只改颜色/比例，无法形成主次。手改SVG也没有同步PPTX/JSON，后续改稿可能丢图标。不能把这些问题归咎为“模型弱”“必须重画底图”或“SVG不能做图标”。

## 入口与实现

- `layeredDesignSchema/Input/Layout`：新稿 `design`，内容起稿或自由 `layers`；起稿输出没有锁定。严格文本/坐标/颜色/资源/快照限制；黑体或宋体，字不省略。标题、栏目、正文、图标、图片独立。
- `layeredDesignSource`：小型可读JSON，素材hash；读一次后复用相同字节。局部 `changes` 及 `source_path+design` 重新构图；默认从旧图层提取原栏目。改稿另存、素材变动拒绝，ZIP使用可重导入相对资源。旧v1海报/大屏继续原模块，不隐式迁移。
- `layeredDesignSvg/Pptx/Html`：同一规范坐标和文本；静态SVG经过原视觉白名单。PPTX原生文字/形状/线段，图标独立矢量对象；不要说“图标每笔都可在Office直接编辑”。HTML桌面使用同源SVG、小屏使用语义文字卡片/重排图表，带真实筛选/详情/快照/图层开关/下载。
- `layeredDesignQuality/Delivery`：原文一致、几何、字形、实际PNG尺寸、真实背景像素对比、视觉回执独立记录。配置了visionLlm只调用一次实际PNG，预扣budget、不联网/不重试；未完成不能记passed。导出/读回与视觉/交互验收分别报告。每份原始图片单独记录scale/upscaled。
- 原 `make_poster`、`create_visual_demo` 只加新稿分支和Schema；`posterRouting/visualSceneRouting/agentSkills/taskContract` 指引新路线，原无字素材、GPT明确直接画字、架构图、纯网页源码和旧渐变边界保持。普通聊天不加载长设计Schema。

最小调用示例：

```json
{"title":"春日见面会","subtitle":"一起把日子过成诗","design":{"layout":"celebration","assets":[{"id":"hero","path":"素材/无字插画.png"}],"sections":[{"title":"活动日期","value":"04.01"},{"title":"活动地点","value":"城市公园"}]}}
```

后续用真实回执的designPath补Demo：

```json
{"source_path":"设计/春日见面会.design.json","changes":[{"id":"title","text":"春日，与美好相见"}]}
```

`make_poster`只交PNG/SVG/PPTX和源稿；`create_visual_demo`在它们之外交HTML/ZIP。正文较多或复杂参考图请按内容设计 `layout=free` 图层，不要又把所有新稿套成几套起稿。

## 重点复核

1. 原字保留与字体真实覆盖不是事实核实；一次视觉/类OCR对照也不保证绝对正确。不能把 `visual:not_checked` 的候选写成“已视觉验收”。快照结构和浏览器交互通过，不意味着视觉模型看过每个状态。
2. 源稿改字/重新构图不得触发生图；只有用户需要新视觉素材才调用原 `generate_image`。不要失败自动换协议、模型或追加付费绘制。
3. 不要放宽SVG为任意HTML、JS、外部图片/字体/URL。原图始终独立原件；不要把最终带错字的PNG作为底图覆盖一遍新字。
4. 程序4K画布、底图真实像素、视觉细节是三个概念；分享不重编码的旧测试必须保留。WeChat真机返回没有在本环境实测，不能因为本批未动原生层便称真机通过。
5. 数据/日期来源、单位和历史快照不自动猜。倒计时样例日期差按明确演示日计算，不推断孕周、健康状况或实际预产期；大屏主视觉是抽象意象，不重引入假中国轮廓。
6. `tests/layeredDesign.test.js`只新增，不删原断言。`e2e/layered-design.mjs`实际渲染三类样例、PPTX转PDF与离线PC/手机交互，并通过原主循环真实执行新工具；替身不是实际GPT服务商。

完整发布继续原三端/原安卓证书/运行清单/CI门禁。用户服务器不用作下载中转或构建机，不改签名、更新仓库、JARVIS命名或数据路径。源码保存提交都带 `[skip ci]`，版本仍由原CI生成。
