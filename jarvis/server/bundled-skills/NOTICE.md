# 随服务器带的技能：来源和许可

`docx`、`pptx`、`xlsx` 三个文件夹原样复制自 Anthropic 的公开仓库 https://github.com/anthropics/skills
（提交 e4bb5d960d87126ff3b3a8af1a104b7db67560ba）。每个文件夹里的 `LICENSE.txt` 是它的许可：Apache License 2.0。文件没有改动。

在未央里的用法（见 `server/bundledSkills.mjs`）：服务器启动时作为“内置”技能装上，安装时把说明（description）
换成中文的“什么时候用”——只在改用户已有的 Word / PPT / Excel、修订批注、复杂公式重算时用；新建文档仍用未央自己的文档工具。
技能里的脚本在服务器的技能运行器（Docker 隔离容器，见 `server/skillRunner.mjs`）里跑，要先装好运行器（deploy/skill-runner/setup.sh）。
