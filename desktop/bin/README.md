# bin/

放 `ffmpeg.exe` 的地方 —— **但装完之后不是这个目录**，先看清楚下面哪一条是你。

只有流水线最后一步「合成」需要 FFmpeg。前面的出图、出视频都不用，
所以没装也能一路跑到视频生成，只是最后拼不成片。

## 该往哪儿放

| 你的情况 | 放这里 |
|---|---|
| **装了安装包**（最常见） | `%APPDATA%\FutureDream\bin\` |
| 解压即用 / 从源码跑 | 就是本目录（`desktop\bin\`） |

装完之后**别再找安装目录里的 bin**：`core\` 被打进了 `app.asar`，
安装目录下的 `resources\bin` 又可能在 Program Files 里写不进去。
`%APPDATA%\FutureDream\bin\` 是唯一任何情况下都可写的位置，应用启动时会自动建好。

不确定的话，打开「设置 → 本机环境」，那里直接印着**当前这台机器该放的绝对路径**，
放完点一下「重新检测」就行，不用重启。

## 探测顺序

1. 「设置」里手填的完整路径
2. `%APPDATA%\FutureDream\bin\ffmpeg.exe`
3. 安装包自带的 `resources\bin\ffmpeg.exe`
4. 本目录（`desktop\bin\ffmpeg.exe`）
5. 系统 PATH

## 从哪儿下

<https://www.gyan.dev/ffmpeg/builds/>，选 `essentials` 版本就够 ——
解压后只需要 `bin\ffmpeg.exe` 这**一个文件**，其余都可以删。

或者 `winget install Gyan.FFmpeg`，装完走上面第 5 条。

> 本目录会被打进安装包（`extraResources`），所以放进来的 ffmpeg 会跟着分发 ——
> 注意 FFmpeg 的许可证要求（LGPL/GPL），对外分发前确认一下。
> 只是自己用的话，放 `%APPDATA%` 那份就行，不涉及分发。
