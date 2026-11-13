# 把 QClaw 默认启用的技能加进贾维斯

日期：2026-10-15（北京时间）。对照的 QClaw 版本：0.2.37.630。

## 一句话

QClaw 默认启用 17 个技能。这次贾维斯的处理是：
- **新加了 8 个内置技能**；
- **合并了 2 个**：Excel 并进原有的 `excel-helper`，人设切换并进新的"另一个 TA"；
- **新加了一个 `install_skill` 工具**；
- **跳过了 9 个**：依赖腾讯服务、QClaw 自己专用、或贾维斯已经有同等功能。

**全部是按用途用贾维斯的工具重写的，没有复制任何原文。** 原计划把 Apache-2.0 / MIT 的两个技能（`qclaw-skill-creator`、`another_them`）连同许可证一起复制进来，但复制这一步被安全权限拦下了。原因大概是：文件来自一个闭源软件的安装目录，要放进公开仓库。我没有绕过，改成按用途重写。要不要放开，见文末"待你决定"。

## 默认启用的是哪 17 个

依据是 `~/.qclaw/openclaw.json` 和 `~/.qclaw/backups` 里的历次配置。详细推断过程写在 `docs/qclaw-inventory.md` 的 2.4 节。

QClaw 主程序是字节码。按 CLAUDE.md "不反编译闭源软件"的规定，没有去读里面写默认配置的代码。所以"这 17 个就是新用户的默认值"是从配置推断的，没有核实。

| 技能 | 做什么 | 许可证 | 依赖 | 贾维斯怎么处理 |
|---|---|---|---|---|
| docx | Word 新建、编辑、读取 | Anthropic 专有 | python-docx、docx-js、LibreOffice | 重写为 **word-document** |
| pdf | PDF 读取、合并拆分、表单、生成 | Anthropic 专有 | pypdf、pdfplumber、reportlab、命令行工具 | 重写为 **pdf-tools** |
| xlsx | 表格新建、编辑、公式重算查错 | Anthropic 专有 | openpyxl、LibreOffice | 合并进已有的 **excel-helper** |
| find-skills | 帮用户找、装技能 | 无 | QClaw 技能市场 | 重写为 **find-skills**（改成在开源仓库里找） |
| qclaw-skill-creator | 教模型写技能 | Apache-2.0（改自 Anthropic 的 skill-creator） | Python 脚本 init_skill.py 等 | 按用途重写为 **skill-creator**（原文复制被拦，见上） |
| another_them（另一个TA） | 把一个人蒸馏成 Agent 人设 | MIT（作者 Huashu 花叔） | QClaw 的 ProSearch 搜索、python3 | 按用途重写为 **persona-creator**（原文复制被拦，见上） |
| persona-switch | 切换 / 恢复预设人设 | 无 | 无 | 合并进 **persona-creator**（切换、恢复默认人设） |
| qclaw-cron-skill | 定时任务、提醒 | 无 | QClaw 的定时任务接口 | 重写为 **scheduled-tasks** |
| qclaw-generate-image | 文生图、图生图 | 无 | QClaw 的生图服务 | 重写为 **image-creator**（用贾维斯的 generate_image） |
| xbrowser | 控制真实浏览器（CDP） | 无 | QClaw 自带的浏览器控制程序 | 重写为 **web-automation**（fetch_url / Playwright MCP / 桌面版操作） |
| email-skill | 收发邮件的总入口，再分发给 QQ 邮箱、IMAP 等子技能 | 无 | QClaw 邮箱服务、IMAP/SMTP 脚本 | 跳过：写邮件已有 email-writer；贾维斯还不能发邮件 |
| qclaw-rules | QClaw 的系统规则（文件编码、Windows 命令行乱码等） | 无 | — | 跳过：QClaw 专用；贾维斯已经处理了 CSV 加 BOM 等问题 |
| qclaw-env | 安装命令行工具和运行环境 | 无 | QClaw 自带的 Python、Node、git | 跳过：贾维斯不引入 Python 运行时，也没有通用命令行 |
| mcporter | 用命令行管理 MCP | 无（OpenClaw 自带的同名技能是 MIT） | mcporter 命令行 | 跳过：贾维斯有 MCP 面板 |
| cloud-upload-backup | 上传文件到腾讯云存储，在 QClaw 小程序里看 | 无 | 腾讯 SMH 云存储 | 跳过：依赖腾讯服务 |
| tencentmap-jsapi-gl-skill | 用腾讯地图生成地图网页 | MIT-0（腾讯） | 腾讯地图开发者密钥 | 跳过：依赖腾讯服务 |
| qclaw-migrator | 迁移 QClaw 数据 | 无（私有） | QClaw / Hermes | 跳过：QClaw 专用 |

## 加了什么

都在 `jarvis/src/agent/skillCatalog.js`，和原来的内置技能放在一起。首次启动时自动装上；已经在用的老用户，下次打开时也会自动装上。

| 技能 | 显示名 | 用到的贾维斯工具 |
|---|---|---|
| word-document | Word 文档 | create_document、write_long_document、edit_office_document、computer_edit_office_document、read_file |
| pdf-tools | PDF 处理 | read_file、run_python（pypdf、fpdf2）、create_document |
| excel-helper（合并） | Excel 表格 | read_file、run_python（openpyxl、pandas）、create_document |
| find-skills | 找技能 | use_skill、web_search、fetch_url、install_skill |
| skill-creator | 技能创建器 | write_file、read_file、install_skill、use_skill |
| persona-creator | 另一个 TA（人物视角） | web_search、fetch_url、deep_research、install_skill、core_memory_update |
| scheduled-tasks | 定时任务 | schedule_task、list_schedules、cancel_schedule |
| image-creator | 生成图片 | generate_image、write_file、preview、create_document |
| web-automation | 网页操作 | fetch_url、web_search、Playwright MCP、computer_open / look / click / screenshot、show_image |

每个技能都能用"/技能名"点名，例如 `/word-document 写个国庆放假通知`。

**顺带改的三处：**
1. **新工具 `install_skill`：** 把工作区里的技能文件夹，或 GitHub 上的技能地址装成技能，同名的会覆盖升级。每次安装都会弹窗请用户确认，因为装进来的说明以后会被照做。"技能创建器"和"另一个 TA"靠它把做好的技能真正装上。
2. **内置技能自动升级：** 以前内置技能装过就不再变，所以合并后的 `excel-helper` 老用户拿不到。现在规则是：
   - 还是内置来源的，说明有更新时自动升级，启用 / 停用状态不变；
   - 用户自己装的同名技能不动；
   - 用户卸载过的不会装回来。
3. **去掉重复项：** 技能面板"推荐"里原来有一个要从 GitHub 下载的"技能创建器"，现在内置了，就去掉了。已经从 GitHub 装过的用户，保留他们装的那份。

## 跳过的腾讯服务，国内有什么替代

- **腾讯云存储备份（cloud-upload-backup）：** 贾维斯已经能把记忆、对话、技能加密同步到用户自己的阿里云 OSS。要备份单个文件，桌面版可以直接存到百度网盘、坚果云等客户端的同步文件夹。贾维斯目前不支持 WebDAV。
- **腾讯地图生成地图网页（tencentmap-jsapi-gl-skill）：** 贾维斯的 MCP 预设里有高德地图，查地点、路线、天气可以用它，需要高德开放平台 Key，而且要在桌面版或完整版里运行。要做地图网页，可以让贾维斯用高德 JSAPI 写，需要用户自己申请高德开发者密钥。
- 不在默认名单、但也装在 QClaw 里的腾讯文档、腾讯会议、腾讯问卷、微信支付等，依赖各自的账号和接口，本次一律没加。

## 测试

- **新测试：** `jarvis/tests/qclawSkills.test.js` 共 9 项，测的是：
  - 每个新技能的名字、显示名、描述正确；
  - 说明里提到的工具都真实存在；
  - 不含 QClaw 专用路径和命令；
  - 首次启动能装上，能被"/技能名"点名，能用 use_skill 读到说明；
  - 内置技能的自动升级和卸载规则；
  - install_skill 从工作区安装，含附件、确认弹窗、覆盖升级、缺 SKILL.md 时报错。
- **原计划里的"许可证文件在"：** 这次没有复制任何原文，所以不需要带许可证文件，这项测试没有写。
- **全部单元测试：** 522 项通过（含云端同时做的 4 个提交），1 项跳过（原来就有的 Windows 专属项）。
- **构建：** `npm run build` 成功。
- **改了一项老测试的时限：** `tests/agent.test.js` 的"生成 Word / PPT / Excel 文件"单独跑要 2～3 秒，全部测试一起跑时电脑忙，偶尔超过默认 5 秒。我把这一项的时限放宽到 20 秒，测试内容没动。
- **没测过：** 这些技能在真实大模型下效果怎么样，没试过。测试只证明能装上、能点名、说明能读到。

## 待你决定

**要不要放开复制原文。** `qclaw-skill-creator`（Apache-2.0）和 `another_them`（MIT）按许可证本来允许复制，只要保留许可证文件、注明出处和改动。复制这一步被 Claude Code 的安全权限拦下了。

想要原文版，有两种办法：
- 在 Claude Code 的权限设置里放开这类操作，我再按原计划复制，带上 LICENSE 文件和出处；
- 找到这两个技能在 GitHub 上的原始开源仓库，从原仓库安装，不经过 QClaw 的安装目录。

现在这两个重写版已经能用。没有原文里的附带脚本，比如字幕清洗、人设质检的 Python 脚本，对应的检查步骤写进了说明里，让模型自己做。
