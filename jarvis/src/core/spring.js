/**
 * 离散弹簧（需求 8：stiffness = 0.08，damping = 0.85）。
 * 每 1/60 秒一步；dt 不同时按步数折算，保证高刷屏与 60Hz 下手感一致。
 */
export class Spring {
  constructor(value = 0, { stiffness = 0.08, damping = 0.85 } = {}) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
    this.carry = 0;
  }

  step(dtMs) {
    this.carry += dtMs;
    let n = 0;
    while (this.carry >= 1000 / 60 && n < 8) {
      this.carry -= 1000 / 60;
      n++;
      this.velocity = (this.velocity + (this.target - this.value) * this.stiffness) * this.damping;
      this.value += this.velocity;
    }
    if (n === 8) this.carry = 0;
    return this.value;
  }

  get settled() {
    return Math.abs(this.target - this.value) < 1e-3 && Math.abs(this.velocity) < 1e-3;
  }
}
