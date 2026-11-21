/** 系统回声消除后的持续近端声音门控；不能确认 AEC 时保留手动打断。 */
export class BargeGate {
  constructor({ holdMs = 180, floor = .035, now = () => performance.now() } = {}) {
    Object.assign(this,{holdMs,floor,now}); this.reset();
  }
  reset() { this.started = null; this.last = -Infinity; this.noise = .008; }
  feed(rms) {
    const at = this.now(), threshold = Math.max(this.floor,this.noise*3);
    if (rms < threshold) { this.started = null; this.noise = this.noise*.98 + rms*.02; return false; }
    if (this.started === null) this.started = at;
    if (at-this.started < this.holdMs) return false;
    this.last = at; return true;
  }
  get recent() { return this.now()-this.last < 800; }
}
