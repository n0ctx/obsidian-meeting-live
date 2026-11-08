// What the mock routes have in common: the sentences they speak, and the counters tests read from GET /stats.
export const SENTENCES = [
  "我们今年的收入预计在三点二亿元左右，去年是两亿一千万。",
  "毛利率大概维持在百分之四十二，主要是材料成本下降了。",
  "目前在手订单有一点五亿，其中头部客户占比接近六成。",
  "产能方面，二期产线计划明年三月投产，届时年产能翻倍。",
  "融资这一轮我们希望估值在二十亿，老股东会继续跟投。",
  "竞争对手主要是两家日本企业，他们的价格比我们高百分之二十左右。",
  "团队现在一共一百二十人，研发占了一半以上。",
  "关于上市，我们初步考虑二零二八年申报科创板，但还要看业绩情况。",
]
export const SENTENCE_MS = 4200

/** What each route has seen, so a test can tell a reconnect from a first connection. */
export const stats = { deepgramConnections: 0, keepAlives: 0, binaryFrames: 0, emptyFrames: 0, closeStreams: 0, dashscopeConnections: 0, dashscopeFinishTasks: 0 }
