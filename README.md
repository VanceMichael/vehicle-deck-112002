# 车辆甲板交班的实装与改签清点的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源的接口。执行 `npm start` 启动来源，默认监听 `127.0.0.1:4100`，可通过环境变量 `PORT` 调整端口。访问根路径可看到来源名和当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/booking` | order 是过渡单，leg 是可换的航次，assets 按 token 表示实物身份。 |
| `/source/ramp` | seq 只在设备内连续。rev 只修订本设备同 seq 的读数。cycle 是一次坡道通行，不是订单或实物键。 |
| `/source/deck` | 覆盖清点以清单的 layer、time 和 slots 为限。covered 里的空位以 absent 明示。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。

## 采集与核对服务

`collector.mjs` 分页轮询三个来源，按来源记录键去重写入 `EventStore`（`event-store.mjs`，JSONL 追加日志，默认在 `DATA_DIR` 下）。核对引擎 `reconcile.mjs` 是无 IO 的纯函数：每次请求重放全部事件得到当前视图，因此坡道修订（同设备同 seq 的更高 rev）、跨交班时刻的补录都会自动重算，历史结论不被就地改写。

启动：先 `npm start`，再 `npm run service`（默认 `127.0.0.1:4200`，可用 `PORT`、`DATA_DIR`、`SOURCE_URL`、`POLL_MS` 调整；设 `POLL_MS=0` 可只手动采集）。

| 路由 | 说明 |
| --- | --- |
| `POST /collect` | 立即从三个来源分页采集一轮 |
| `POST /source-stage?stage=N` | 切换来源回放阶段并采集 |
| `GET /reconcile` | 全量核对视图：过渡单、通行与缺口、移动时间线、甲板舱位、交班、冲突、未知项 |
| `GET /reconcile/order/:order` `/reconcile/asset/:asset` `/reconcile/deck/:leg/:layer` | 单据、实物、甲板的明细视图 |
| `POST /handovers` | 值班员交班确认；`seen` 为舱位→实物主张，`unchecked` 为带着交班的未清项 |
| `GET /handovers` `/discrepancies` `/unknown` | 交班记录（含签收时依据快照）、被补录推翻的差异与冲突、清点之外的未知清单 |
| `POST /discrepancies/:id/ack` | 下一班签收差异：原结论、差异实物、处理责任留档，重复签收返回 409 |
| `GET /events` `/health` | 原始事件日志与健康状态 |

核对口径：

- 实物只按 asset token 与通行关联核对，车牌复用不参与位置推断；同设备 seq 取最高 rev，`floor` 水位线之前的缺口标“不可补”，之后标“待补”。
- 人工清点只在 `covered` 边界内生效，`absent` 明示空位；边界之外且无挂接/清舱证据的位置进入 `/unknown`，不推断在位。
- 候补释放要求实物已证实不再占位**且**手续有效；仅票务改签（rebook）不释放。牵引车可同时持组合单与仅牵引车单，一条通行能被任一授权解释即算手续有效。
- 不变量冲突单列：同一实物被两个当前甲板记作已装好、未核清车辆占用已签收的释放位置、同一实物被两个有效交班重复签收。
- 补录推翻已签收结论时，原交班标记“已被补录推翻”，快照保留当时依据，差异含实物、原结论与最新证据，经下一班 ack 后责任闭环。

`npm test` 覆盖核对引擎规则（`reconcile.test.mjs`）、四阶段端到端回放与重启重放（`service.test.mjs`）和来源接口（`source.test.mjs`）。
