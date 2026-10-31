# 股票行情接口约定（Codex实现，Claude持仓调用）

状态：代码已接入，定向49项通过；已在当前执行环境取得腾讯真实日K，并在人为注入腾讯HTTP503后取得新浪真实回执。国内用户服务器连通性及真实模型持仓多轮调用未验收。沿用工具名get_stock_kline，不改holdings.js。

## 请求

沿用code（明确六位代码或sh/sz/bj前缀）、start/end（YYYY-MM-DD）、limit（1～120）、adjustment（none/qfq/hfq）。持仓按原始现金成本算盈亏时使用adjustment=none，复权价格不能直接与未复权成本混算。

## 回执新增字段

在原JSON回执的symbol/source/sourceUrl/adjustment/fetchedAt/bars/极值与范围基础上增加以下顶层字段，不移除旧字段：

| 字段 | 类型/含义 |
|---|---|
| latestClose | number或null，返回范围内最新已结束交易日的收盘价，不能拿盘中日K最后价冒充收盘 |
| previousClose | number或null，latestClose前一条可取得日K记录的收盘价；两项必须来自同一来源和同一复权口径 |
| priceDate | YYYY-MM-DD或null，对应latestClose |
| previousPriceDate | YYYY-MM-DD或null，对应previousClose；没有真实记录时不能猜日期或补0 |
| priceState | 明确已结束日K或缺少可用记录；不称实时成交价 |
| holdingCompatible | 是否为未复权且有可用收盘价；有价格不等于适合与任何持仓成本混算 |
| marketTimeZone | Asia/Shanghai |

当日收盘采用保守15:05北京时间切点，之前忽略当日仍可能变化的日K；最新条目可能仍在bars中，但不能拿它冒充latestClose。limit=1时腾讯内部至少取3条供前收盘/盘中退回，实际bars仍按用户limit返回。各收盘字段来自同一份来源结果，不混两家。

bars仍是调用者所请求范围/条数的原有行情，不把这些字段冒称全市场实时最新价；历史范围请求返回的是该范围的最新已结束日K。休市/停牌/新股或来源覆盖不足可能没有上一条，必须说明缺项，不能编造。

## 给持仓工具的映射

holding_profit.price=latestClose；prevClose=previousClose（缺失时省略，只算总盈亏）；priceDate=priceDate。模型必须使用实际工具结果，不能自己填今天日期、用推荐价当成本，或混用两家来源的两项收盘价。持仓成交、更正、T+1及盈亏实现继续由Claude维护。

Codex负责来源失败切换、日期/复权/覆盖与盘中说明、字段和实际网络验证。保留取消及预算上抛；纯来源失败不能说没有该股票或从未持仓。

当前未复权为腾讯→新浪；qfq/hfq仍只走腾讯，失败就明确失败，不能换用未复权新浪冒充已复权。后续若补复权备用源，必须核实其协议和口径。定向测试覆盖limit=1、历史范围/盘中/缺前收盘、复权与成本不兼容、503换源、预算上抛，并回归原systemQuality与Claude的holdings测试；没有改这些旧断言。私有执行记录/tmp/weiyang-stock-contract-live.json，不是用户服务器/用户实际持仓验收。
