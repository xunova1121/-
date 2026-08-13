# bin/

放 `ffmpeg.exe` 的地方。

只有流水线最后一步「合成」需要 FFmpeg。把官方构建里的 `ffmpeg.exe`
直接丢进本目录即可 —— 应用会自动找到，不用配 PATH，也不用装。

探测顺序：

1. 「设置」里手填的完整路径
2. 本目录（`bin\ffmpeg.exe`）
3. 系统 PATH

下载：<https://www.gyan.dev/ffmpeg/builds/>（选 `essentials` 版本就够，解压后
只需要 `bin\ffmpeg.exe` 这一个文件）。

或者直接 `winget install Gyan.FFmpeg`，装完走上面第 3 条。

> 这个目录会被打进安装包（`extraResources`），所以放进来的 ffmpeg
> 会跟着分发 —— 注意 FFmpeg 的许可证要求（LGPL/GPL），对外分发前确认一下。
