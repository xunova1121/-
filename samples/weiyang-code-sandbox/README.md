# weiyang-code-sandbox

未央（WEIYANG AI）代码智能体的**练手仓库**：一个很小的 Node 项目，用来验收“拉代码 → 读代码 → 改 → 跑代码检查和测试 → 推工作分支”这一整圈。

- 不依赖任何第三方包，只要 Node 20 及以上。
- `npm run lint`：代码检查（语法、源码不留 console.log）。
- `npm test`：单元测试（Node 自带的 `node:test`）。

## 目录
- `src/cart.js`：购物车金额（小计、满减、运费、总价），按“分”计算避免小数误差。
- `src/date.js`：按北京时间算日期、相差天数、孕周。
- `test/`：单元测试。

## 规矩
- 改代码后必须跑 `npm run lint` 和 `npm test`，都通过才算完成。
- 不许删除或跳过测试来让测试通过。
- 不直接改 `main`，在工作分支上改。

许可：MIT
