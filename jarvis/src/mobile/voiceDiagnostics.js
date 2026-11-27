/** 只记录阶段与错误，不保存录音、识别内容或密钥。 */
export function recordVoiceEvent(stage, detail = '', storage) {
  try { storage ??= globalThis.localStorage; const entries = JSON.parse(storage?.getItem('jarvis.voiceDiagnostics.v1') || '[]'); entries.push({ time:Date.now(), stage, detail:String(detail).replace(/sk-[A-Za-z0-9_-]+/g,'[已隐藏密钥]').replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').slice(0,180) }); storage?.setItem('jarvis.voiceDiagnostics.v1',JSON.stringify(entries.slice(-12))); } catch {}
}
export function readVoiceEvents(storage) {
  try { storage ??= globalThis.localStorage; const events = JSON.parse(storage?.getItem('jarvis.voiceDiagnostics.v1') || '[]'); return Array.isArray(events) ? events.slice(-12) : []; } catch { return []; }
}
