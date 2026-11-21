# samples

- `weiyang-code-sandbox/`：未央代码智能体第一期的练手项目（独立的小 Node 项目，零依赖）。等用户在 GitHub 建好空仓库 `weiyang-code-sandbox` 后，原样推上去作为测试仓库。
  - **故意埋的 bug（只写在这里，别写进练手仓库）**：`src/cart.js` 的 `applyDiscount` 用了 `>`，正好 100 元不满减；改成 `>=` 后 `npm test` 8/8 通过，改前 2 个失败（满减、总价）。
  - 验收：未央拉代码 → 读代码找到原因 → 只改这一处 → `npm run lint` 和 `npm test` 全过 → 推到工作分支（不改 main）→ 回报改了哪个文件、测试输出。
