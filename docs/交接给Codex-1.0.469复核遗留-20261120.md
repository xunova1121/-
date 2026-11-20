# 交接给 Codex：1.0.469 复核遗留（2026-11-20，Claude）

用户要求复核 Codex 的 1.0.467 / 1.0.469，复核后说“交给 codex”。下面四件事原交 Codex 接手；**第 1、2 项用户已于 2026-11-20 实测没问题，不用再做**，Codex 只需做第 3、4 项，做完按惯例统一发版、核验三端，并在本文件末尾记结果。

## 复核结论（已确认，无需再做）

- 同步到 `88fd490`，代码检查通过，全量单测 499 个文件、4429 项全过；对比 `e858ba2` 后，测试只有新增，没有删除或放宽断言。
- 公开 1.0.469：APK v2 证书 `56e3579b…363d6` 与既有发布一致，versionCode 469；服务器包 sha256 与 `jarvis-server-latest.json` 一致，1205 项全 root 属主；1.0.466 的“等任务做完再更新”（`deploy/update.sh` 的 `tasks-busy`）仍在。
- 1.0.467 用 `withAbortSignals` 代替 `AbortSignal.any` 修旧安卓续接，写法正确，有回归。
- DeepSeek 联网引用只认本轮成功回执、过滤内网和带签名的地址；文件问答上传设一小时到期并主动删除；服务器语音不把用户登录令牌转给上游、成员需管理员开通。设计上没有发现问题。

## 待办

1. ~~**DeepSeek 全家桶真实接口核对**~~ —— **已完成：用户 2026-11-20 实测没问题。** 原说明保留备查：
   1.0.469 的联网问答、以图搜图、文件问答、OCR、ASR、TTS（HTTP 与 WebSocket）都没用真实密钥调过。Claude 这边的环境连不上 `api-docs.deepseek.com`，无法逐项核对路径和字段：`deepseek-flash` 模型名，`/v1/files` 的 `purpose`（`user_data` / `text_recognition` / `rich_layout_recognition`）和 `expires_after[...]`，`/v1/tools/ocr|asr|tts` 的请求和返回结构，`safety_check`、`thinking`，`deepseek_web_search` / `deepseek_read_url` 工具类型，以及 `annotations.url_citation` 的偏移。
   请对照官方文档逐项核对。条件允许的话，在用户配好官方密钥后，按“问今天新闻 / 传图找出处 / 传 PDF 提问 / 录音 / 朗读”各跑一次，确认可用并记下实测结果；对不上的直接修。在实测之前，CLAUDE.md 和发布说明里不要写成“已可用”。

2. ~~**网页端流式朗读的鉴权方式**~~ —— **已完成：用户 2026-11-20 实测没问题。** 原说明保留备查：
   `shared/deepseekSpeech.js` 在没有传 `open` 时（浏览器直连），用 `new WebSocket(url, ['tts', 'bearer.' + key])` 把密钥放进子协议头。请确认 DeepSeek 是否支持这种鉴权，以及服务端会不会回同名子协议（不回的话，浏览器会直接断开连接）。如果不支持，网页和桌面端的流式朗读改走服务器或本机网关转发，或者退回整段 WAV。服务器那条路走的是 `Authorization` 头，没有这个问题。

3. **整理 CLAUDE.md 开头**
   约定是“开头只放当前状态，不超过 5 行，旧状态挪到 `docs/交接历史-CLAUDE开头存档.md`”。现在开头同时堆着 1.0.469、1.0.467 和 Claude 的 1.0.466 整段旧说明，有重复。请只保留当前版本、仍未验收、待办三类，旧内容挪到存档。

4. **旧安卓 WebView 的 `AbortSignal.timeout`（此前就有，不是 1.0.469 引入的）**
   `src/ui/sportsCard.js:24` 和 `src/app/voiceDevices.js:66` 直接调用 `AbortSignal.timeout(20000)`，没有可选链也没有兼容写法。缺少这个方法的旧内核会直接抛错（同文件其他几处已经写成 `AbortSignal.timeout?.()`）。请改成 `withAbortSignals([], fn, ms)`，或用同等的兼容写法，并加回归测试。

## 约定提醒

- 先读 `docs/已修问题清单-不许回退.md`，测试只许加不许删；修了的问题加进清单。
- 令牌只填在未央服务器的设置里，不经对话、不进仓库；不碰 `/opt/jarvis/jarvis.env` 和服务器密码。
