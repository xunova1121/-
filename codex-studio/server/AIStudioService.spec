# -*- mode: python ; coding: utf-8 -*-
a = Analysis(['run_service.py'], pathex=[], binaries=[], datas=[], hiddenimports=['uvicorn.logging','uvicorn.loops.auto','uvicorn.protocols.http.auto','uvicorn.protocols.websockets.auto','uvicorn.lifespan.on'], hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='AIStudioService', debug=False, bootloader_ignore_signals=False, strip=False, upx=True, console=False)

