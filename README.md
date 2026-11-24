# 车辆甲板交班的实装与改签清点的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源接口与采集/交班规则。

演练来源仍默认监听 `127.0.0.1:4100`：

```bash
npm run source
```

采集服务默认监听 `127.0.0.1:4200`，并把状态原子写入 `data/ledger-state.json`：

```bash
npm start
# 另一个终端；来源已启动后，可一步切到第 4 演练阶段并采集：
curl -X POST http://127.0.0.1:4200/collect \
  -H 'content-type: application/json' \
  -d '{"stage":4}'
```

也可以先 `curl -X POST 'http://127.0.0.1:4100/control?stage=4'`，再调用不带 body 的 `POST /collect`。采集器会按 `availableFrom` 顺序重放记录，因此即使首次采集已经是第 4 阶段，HB2 快照仍只使用签收时已出现的证据；ramp-4 更正会在当前重算中推翻原结论。

可用环境变量：`PORT`、`SOURCE_URL`（默认 `http://127.0.0.1:4100`）、`LEDGER_DB`（设为空字符串可只用内存）、`AUTO_COLLECT=1`、`ALLOW_RESET=1`。

## 采集服务接口

| 方法与路由 | 用途 |
| --- | --- |
| `POST /collect` | 分页拉取 booking/ramp/deck 并按来源记录键幂等入库；body 可给 `sourceUrl`、`stage` |
| `GET /reconciliation?leg=午13` | 三本数对照：票务过渡单、坡道通行/缺口、甲板舱位/签收/清点、释放候选和差异 |
| `GET /orders`、`GET /identities` | 过渡单/航次链，以及 token 与车牌标签；车牌不参与身份合并 |
| `GET /view?layer=L2&at=09:00` | 重算甲板在位视图；`at` 可按 `HH:MM` 或 ISO 时间做点内重放 |
| `GET /unknown` | 单列未核清舱位、在船但位置不明实物、回卷后不可补取序列和清点覆盖外位置 |
| `GET/POST /handoffs` | 查看/提交交班；POST 必须给明确 `layer`，可给 `seen`、`empty`、`unchecked`、`openItems`、`canContinueLoading` |
| `GET /handoffs/:id/replay` | 返回不可变签收快照、当时订单/实物/占用理由，以及用最新证据重算后的对照 |
| `GET /findings` | 查看被补录/更正证据推翻的签收、实物差异和下一班处理责任 |
| `POST /findings/:key/acknowledge` | 下一班接收处理责任 |
| `POST /findings/:key/assign` | 指派处理人，body 给 `assignee` |
| `POST /findings/:key/resolve` | 结案，例如 `{"resolution":"ramp_correction_confirmed"}` |
| `GET /release-candidates?leg=午13` | 检查上一处是否已证实不占位、改签时是否未登船、授权是否匹配、是否有未结差异 |
| `POST /releases` | 确认释放；给 `slot:{layer,slot}` 时同时校验目标空位和释放位排他性 |
| `POST /readings`、`POST /deck-events`、`POST /records` | 补录坡道读数、甲板事件或任意来源形状记录 |
| `POST /layouts` | 提供甲板完整舱位表，便于枚举没有出现在清点边界中的未知位置 |

核心规则：

- `order`/过渡单的当前航次由 booking 与 rebook/transfer 时间链计算；是否允许改签不只看票务记录，而会核对改签时刻的坡道和甲板证据。
- 坡道以 `station + seq` 为业务序列键，高 `rev` 修订同一读数；`cycle` 只表示一次通行。所有修订原样保留在证据链中。
- 实物身份只使用 `assets`/`trailer` token 与通行关联；`plate` 仅保存为标签，不参与身份合并，避免车牌复用导致错配。
- 清点只证明其 `layer + time + covered` 边界：`present` 为在位，`absent` 为空位；边界外位置进入未知清单。
- 已生成的 HB2 等签收快照不可变。迟到驶出或更正只改变重算视图并生成/更新 finding；原结论、差异实物和下一班责任仍可重看。
- 有未结冲突、前一位置未证实清空、手续无效或同一实物出现在多个当前甲板结论中时，不能取得可占用舱位的释放许可；已签收给其他过渡单的位置返回 `409`。

### 演练数据的核对路径

第 3 阶段后，`GET /handoffs/HB2/replay` 的冻结快照应显示 `G36` 在 `L2/D3` 计作占用，`D5` 未检查；`GET /unknown` 还会列出坡道 `坡M#72` 回卷缺口和清点覆盖外位置。此时 `GET /release-candidates?leg=午13` 不放行 OT1，因为只有票务改签，物理证据仍显示 G36 在 D3。

采集第 4 阶段的 `ramp-4` 后，同一 replay 会显示原快照不变、按最新证据重算为 `disputed_exit_before_claim`，并产生 key 形如 `SIGNED_LOADING_OVERTURNED_BY_EXIT:L2:D3:G36:HB2` 的下一班处理项。处理并确认坡道更正后，OT1 才满足释放条件；`L1/A1` 已有 `deck-4` 清舱证明，可创建并签收释放：

```bash
curl -X POST http://127.0.0.1:4200/findings/SIGNED_LOADING_OVERTURNED_BY_EXIT%3AL2%3AD3%3AG36%3AHB2/resolve \
  -H 'content-type: application/json' \
  -d '{"resolution":"ramp_correction_confirmed","by":"next-shift"}'

curl -X POST http://127.0.0.1:4200/releases \
  -H 'content-type: application/json' \
  --data-binary '{"leg":"午13","order":"OT1","slot":{"layer":"L1","slot":"A1"},"signedBy":"officer-zhao"}'
```

未结差异未处理时，第二步返回 `422`；若 `A1` 已签收给其他过渡单，返回 `409`。

## 合成来源接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/booking` | order 是过渡单，leg 是可换的航次，assets 按 token 表示实物身份。 |
| `/source/ramp` | seq 只在设备内连续。rev 只修订本设备同 seq 的读数。cycle 是一次坡道通行，不是订单或实物键。 |
| `/source/deck` | 覆盖清点以清单的 layer、time 和 slots 为限。covered 里的空位以 absent 明示。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。
