; Windows 便携版：一个 EXE，运行时解到临时目录，应用退出后由 NSIS 清理。
; 保留这个脚本是为了在 Linux CI 没有 Wine 时也能交付真正的单文件版本。
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "未来创梦"
OutFile "dist/FutureDream-Portable-0.1.0-x64.exe"
AutoCloseWindow true
ShowInstDetails nevershow

Section "Launch"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /r "dist/win-unpacked/*.*"
  ExecWait '"$PLUGINSDIR\未来创梦.exe"' $0
SectionEnd
