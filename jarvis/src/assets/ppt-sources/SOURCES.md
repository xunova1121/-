# 精选可编辑样板：来源与范围

## 用户追加的两种版式

`reference-technical`（清蓝红 · 技术建设方案，10 页）与 `reference-roadshow`（蓝绿 · 行业路演，11 页）来自用户提供材料的通用版式结构参考，由 `scripts/make-ppt-reference-templates.mjs` 重新绘制。它们不标为 MIT 上游作品，也不是原 PDF 的无损转换。

两套均为原生 PPT 文本框、形状、表格式单元和连接线；内容统一改成【填写…】。图、地图、截图和视频换成原生占位框；没有嵌入原文件、品牌标识、真实数据或外部视频链接。用户可在 PowerPoint / WPS 里直接改字、插图、复制页面。配套 POTX 在生成目录中供下载；双击 POTX 新建演示文件，普通 PPTX 可直接编辑。

预览覆盖全部 21 页；连同下述四套共 6 套、41 页真实渲染。模板库先展示这两套，再展示四套开源版式适配样板。不能把“重建版式”描述成“保留了原 PDF 中一切内容与效果”。

## 四套开源版式适配

2026-11-05 核对上游许可证。四套文件由未央制作，是**开源通用版式的适配样板**，不是第三方模板原文件，也不是已经填好用户资料的成品。原生文本框、形状均可编辑；演示数据明确标为示例。安装包内保留 MIT 许可，每份 PPTX 每页备注也附完整许可。

来源：[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)，固定提交 `f3633771fe699d327f02ae86393831bbcf5169f7`。许可：[MIT](https://github.com/hugohe3/ppt-master/blob/f3633771fe699d327f02ae86393831bbcf5169f7/LICENSE)，Copyright (c) 2025–2026 Hugo He。

参考的通用文件（位于 `skills/ppt-master/templates/`）：

- `layouts/presentation_core/templates/10_hero_statement.svg`：重点句与留白。
- `layouts/presentation_core/templates/11_editorial_split.svg`：编辑式左右分栏。
- `layouts/presentation_core/templates/13_kpi_dashboard.svg`：指标区和证据区分开。
- `layouts/report_core/templates/01_cover.svg`：封面标题层次。
- `styles/mbb-consulting/templates/design_spec.md`、`styles/investor-pitch/templates/design_spec.md`、`styles/product-launch/templates/design_spec.md`、`styles/creative-pitch/templates/design_spec.md`：内容组织建议。

未使用该仓库 `brands/`、品牌标识、公司报告、第三方照片和嵌入素材。当前四套是同一套五页结构的四种视觉适配：墨青咨询、钴蓝发布、曜金路演、雾紫提案；不宣称来自四家不同模板商。

制作：`node scripts/make-ppt-sources.mjs`。原生 PPTX 经 LibreOffice 转 PDF，再用 pdftoppm 导出全部 20 页真实预览。清单 `catalog.json` 包含版本固定来源、文件大小和 SHA-256。重新生成后需要更新清单和逐页视觉检查；预览不能单独替换为效果图。

在线筛选时未纳入：

- [SlidesCarnival](https://www.slidescarnival.com/terms-of-use)：制作演示可用不等于允许把原模板文件整包再分发。
- [PresentationGO](https://www.presentationgo.com/presentation/modern-business-powerpoint-template/)：页面限制模板再分发。
- metaimagine/ai-pptx：代码 MIT，但 `ppt_template/ALL FROM WPS` 标注模板源自 WPS；未把代码许可当成第三方素材再分发许可。

原有 16 个生成方案保持原行为；新样板作为单独的可编辑源文件导入。导入仅保存文件并填入草稿，用户补充要求后才调用模型。没有实测真实模型完成样板编辑，也没有做安卓、Windows 真机验收。
