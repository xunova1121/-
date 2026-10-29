import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, shippingFee, cartTotal } from '../src/cart.js';

test('小计按单价乘数量，没有小数误差', () => {
  assert.equal(subtotal([{ name: '笔', price: 0.1, qty: 3 }, { name: '本', price: 0.2, qty: 1 }]), 0.5);
});

test('满减：满 100 减 20，正好 100 也算满', () => {
  assert.equal(applyDiscount(99.99), 99.99);
  assert.equal(applyDiscount(100), 80);
  assert.equal(applyDiscount(150), 130);
});

test('运费：满 99 包邮，不足收 8 元', () => {
  assert.equal(shippingFee(98.99), 8);
  assert.equal(shippingFee(99), 0);
});

test('总价：先满减再算运费', () => {
  assert.equal(cartTotal([{ name: '茶叶', price: 50, qty: 2 }]), 88); // 100 → 满减 80 → 不足 99 加运费 8
  assert.equal(cartTotal([{ name: '茶具', price: 120, qty: 1 }]), 100);
  assert.equal(cartTotal([{ name: '茶杯', price: 30, qty: 1 }]), 38);
});

test('数量不是整数时报错', () => {
  assert.throws(() => subtotal([{ name: '笔', price: 1, qty: 1.5 }]), /商品数据不对/);
});
