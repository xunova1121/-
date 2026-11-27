/**
 * 购物车金额计算（单位：元，内部按“分”计算，避免小数误差）
 *
 * 规则：
 *   - 商品小计 = 单价 × 数量
 *   - 满减：小计满 threshold 元（含正好等于）减 off 元，只减一次
 *   - 运费：满减后金额不足 freeShippingAt 元收 shipping 元运费
 */
const toCents = (yuan) => Math.round(Number(yuan) * 100);
const toYuan = (cents) => cents / 100;

export function subtotal(items = []) {
  let cents = 0;
  for (const item of items) {
    if (!(item.price >= 0) || !Number.isInteger(item.qty) || item.qty < 0) throw new Error(`商品数据不对：${item.name ?? '未命名'}`);
    cents += toCents(item.price) * item.qty;
  }
  return toYuan(cents);
}

export function applyDiscount(amount, { threshold = 100, off = 20 } = {}) {
  const cents = toCents(amount);
  return toYuan(cents > toCents(threshold) ? cents - toCents(off) : cents);
}

export function shippingFee(amount, { freeShippingAt = 99, shipping = 8 } = {}) {
  return toCents(amount) >= toCents(freeShippingAt) ? 0 : shipping;
}

export function cartTotal(items, options = {}) {
  const afterDiscount = applyDiscount(subtotal(items), options);
  return toYuan(toCents(afterDiscount) + toCents(shippingFee(afterDiscount, options)));
}
