// 場次薪資結算規則(集中管理,方便改價)。金額一律「萬」整數/半數。
// 資料來源:pos_order_items(POS 結帳寫入,已附 _customer=本單犯人)。已移除 purchase_addons 與監獄外抓捕。
// 只計算,不寫入。由 SalarySettlement.jsx 使用。
//
// 拆帳表(獄卒得=計入直接薪資的金額;監獄得靠「營業額 − 直接薪資」自動得出,不逐項計):
//   拍立得 無簽   定價 5萬   獄卒得 3.5萬
//   拍立得 簽繪   定價 8萬   獄卒得 6萬
//   指定監督(集體) 定價 10萬  獄卒得 5萬
//   指名費(指名)   定價 15萬  獄卒得 15萬(全歸,監獄得 0,靠保底成本反映)
//   互動探監      定價 5萬(試營運) 獄卒得 5萬
//   肖像畫        定價 80萬  獄卒得 80萬(當日無底薪)
//
// 計算順序:
//   直接薪資 = 底薪 + 個人服務獎金(獄卒得),不含均分獎金。
//   集體趕稿:淨收入 = 營業額 − 直接薪資總額;均分獎金池 = 淨收入×0.5(上班獄卒均分);監獄留存 = 淨收入×0.5;
//            每位最終薪資 = 直接薪資 + 均分獎金。
//   指名互動:無均分。服務收入 = 指名費 + 拍立得獄卒得;薪資 = max(底薪10, 服務收入);監獄結餘 = 營業額 − 薪資總額(可負)。

export const RATES = {
  base: 10,               // 底薪
  polaroidUnsigned: 3.5,  // 無簽拍立得 獄卒得/張
  polaroidSigned: 6,      // 簽繪拍立得 獄卒得/張
  supervise: 5,           // 指定監督 獄卒得/次
  visit: 5,               // 互動探監 獄卒得/次
  portrait: 80,           // 肖像畫 獄卒得/張(無底薪)
  namedSlot: 15,          // 指名 獄卒得/30 分時段
  poolRate: 0.5,          // 集體場淨收入 → 獎金池 / 監獄留存 各半
}

// 監獄營業額逐項用的「定價」(僅供監獄收支卡分組加總;個別 pos_order_items.amount 已含這些定價)
const PRICE = { entry: 20, supervise: 10 }   // 集體:入場費 20、指定監督 +10

const arr = v => Array.isArray(v) ? v : []
export const w = n => String(Math.round((Number(n) || 0) * 100) / 100)
export const money = n => `${w(n)} 萬`

// 入場費折抵:同一犯人(本場)若同時有『無指名入場』與『拍立得或指名』,其入場費折抵 ENTRY_WAIVE 萬(至多折到 0)。
// custOf(it) 取本單犯人識別(名稱);SessionPOS 與薪資結算共用,確保營業額/薪資一致。
export const ENTRY_WAIVE = 1
export function waivedEntryCustomers(items, custOf) {
  const entryOf = new Set(), paidOf = new Set()
  for (const it of items) {
    const c = custOf(it); if (!c) continue
    if (it.item_type === 'entry') entryOf.add(c)
    else if (it.item_type === 'polaroid' || it.item_type === 'nominate') paidOf.add(c)
  }
  const s = new Set()
  for (const c of entryOf) if (paidOf.has(c)) s.add(c)
  return s
}
// 單一 item 的入場費折抵額(僅 entry 品項、且該犯人符合條件時 > 0)
export function itemEntryWaive(it, waivedSet, custOf) {
  if (it.item_type !== 'entry') return 0
  const c = custOf(it)
  if (!c || !waivedSet.has(c)) return 0
  return Math.min(ENTRY_WAIVE, it.amount || 0)
}

// 拍立得明細列:依「本單犯人」分組,回傳 { name, tag, calc, amount }
function polaroidRows(items, signed, unit) {
  const groups = {}
  for (const r of items) {
    const key = r._customer || r.person_name || '（未指定）'
    groups[key] = (groups[key] || 0) + (r.qty || 0)
  }
  return Object.entries(groups).map(([name, qty]) => ({
    name, tag: signed ? '簽繪' : '空白', calc: `${w(unit)}萬 × ${qty}張`, amount: unit * qty,
  }))
}

// 依人名彙總次數(指定監督),回傳 { name, calc, amount }
function countRows(items, unit) {
  const groups = {}
  for (const r of items) { const key = r._customer || r.person_name || '（未指定）'; groups[key] = (groups[key] || 0) + 1 }
  return Object.entries(groups).map(([name, qty]) => ({
    name, calc: `${w(unit)}萬 × ${qty}`, amount: unit * qty,
  }))
}

// 單一獄卒今日薪資明細 → 純文字(Discord 播報用)。輸入 calcSettlement 產出的一位 guard + 場次資訊。
// 純文字,分隔沿用「｜」分欄位;每段一行,末行最終薪資。
export function formatGuardPayslip(guard, session = {}) {
  const dateStr = session.session_date ? `（${session.session_date}）` : ''
  const no = (guard.inmate_no != null && guard.inmate_no < 1e9) ? ` · No.${String(guard.inmate_no).padStart(4, '0')}` : ''
  const lines = [
    `今日薪資明細｜${session.title || '本場'}${dateStr}`,
    `${guard.name}${no}`,
  ]
  for (const seg of guard.segments ?? []) {
    lines.push(`· ${seg.title}${seg.note ? `（${seg.note}）` : ''} ${money(seg.amount)}`)
  }
  lines.push(`最終薪資 ${money(guard.final)}`)
  return lines.join('\n')
}

// 伊萊諾斯薪資 + 監獄收支 合併訊息(送到「伊萊諾斯和監獄的收支」頻道)。
// elai 可為 null(伊萊諾斯當日未上班 → 只出監獄收支);result 為 calcSettlement 回傳。金額單位「萬」。
export function formatElaiAndPrisonPayout(elai, result, session = {}) {
  const lines = []
  if (elai) lines.push(formatGuardPayslip(elai, session), '')
  else {
    const dateStr = session.session_date ? `（${session.session_date}）` : ''
    lines.push(`今日薪資明細｜${session.title || '本場'}${dateStr}`, '伊萊諾斯 · No.0001', '· 當日無上班薪資', '')
  }
  lines.push('監獄收支')
  // 營業額來源逐項(對齊畫面「營業額來源」卡:無指名入場/拍立得/指名費/小費…+ 合計)
  lines.push('【營業額來源】')
  if (result.revenueRows?.length) for (const r of result.revenueRows) lines.push(`· ${r.label} ${money(r.amount)}`)
  else lines.push('· （無）')
  lines.push(`· 營業額合計 ${money(result.revenue)}`)
  // 結算逐項(對齊畫面「結算」卡)
  lines.push('【結算】')
  lines.push(`· 獄卒直接薪資${result.tipTotal ? '（含指定小費）' : ''} -${money(result.directTotal)}`)
  lines.push(`· 淨收入（營業額 − 直接薪資） ${money(result.net)}`)
  if (result.pool) lines.push(`· 均分獎金池（淨收 50%${result.tipTotal ? ' + 不指定小費' : ''}，發給獄卒） -${money(result.pool)}`)
  if (result.bonusTotal) lines.push(`· 追加薪資（監獄額外發給獄卒） -${money(result.bonusTotal)}`)
  lines.push(`· 監獄留存 ${money(result.retain)}`)
  return lines.join('\n')
}

// rates:價目表(price_items.guard_cut)組出的拆帳率覆蓋(settlementRates 產出;值為 null 的鍵落回 RATES 預設)。
// 不帶 rates 時行為與過去完全相同。優惠結帳不影響結算:以張數/時段數 × 拆帳率計,不看實收金額。
export function calcSettlement({ kind, guards, items, rates = null }) {
  const R = { ...RATES }
  for (const [k, v] of Object.entries(rates ?? {})) if (v != null) R[k] = v
  const byGuard = {}
  for (const it of items) { const g = it.target_guard_id; if (!g) continue; (byGuard[g] ??= []).push(it) }
  const custOf = it => it._customer
  const waived = waivedEntryCustomers(items, custOf)
  const waiveTotal = items.reduce((s, it) => s + itemEntryWaive(it, waived, custOf), 0)   // 入場費折抵合計
  // 小費:指定獄卒→全給該獄卒(算營收、進該獄卒直接薪資);不指定→全額進均分獎金池。
  const tipPool = items.filter(x => x.item_type === 'tip' && !x.target_guard_id).reduce((s, x) => s + (x.amount || 0), 0)
  const tipTotalAll = items.filter(x => x.item_type === 'tip').reduce((s, x) => s + (x.amount || 0), 0)
  // 追加薪資:監獄額外發給獄卒(非客人營收)。指定→該獄卒;全體(無 target)→均分。從監獄留存扣除,不計營業額。
  const bonusItems = items.filter(x => x.item_type === 'bonus')
  const bonusByGuard = {}; let bonusAll = 0
  for (const b of bonusItems) { if (b.target_guard_id) bonusByGuard[b.target_guard_id] = (bonusByGuard[b.target_guard_id] || 0) + (b.amount || 0); else bonusAll += (b.amount || 0) }
  const bonusTotal = Object.values(bonusByGuard).reduce((s, v) => s + v, 0) + bonusAll
  const revenue = items.reduce((s, it) => s + (it.amount || 0), 0) - waiveTotal - bonusTotal   // 折抵後營業額(含小費,排除追加薪資)

  const perGuard = guards.map(g => {
    const its = byGuard[g.id] ?? []
    const segments = []   // { title, amount, note?, rows?:[{name,tag?,calc?,amount}] }

    const pol = its.filter(x => x.item_type === 'polaroid')
    const polU = pol.filter(x => !x.with_signature), polS = pol.filter(x => x.with_signature)
    const qtyU = polU.reduce((s, x) => s + (x.qty || 0), 0), qtyS = polS.reduce((s, x) => s + (x.qty || 0), 0)
    const polUAmt = R.polaroidUnsigned * qtyU, polSAmt = R.polaroidSigned * qtyS
    const portraits = its.filter(x => x.item_type === 'portrait')
    const supervises = its.filter(x => x.item_type === 'signup' && x.supervise)
    const visits = its.filter(x => x.item_type === 'visit')
    const noms = its.filter(x => x.item_type === 'nominate')
    const slots = noms.reduce((s, x) => s + arr(x.slot_times).length, 0)

    let direct                                  // 三分支(肖像/指名/集體)必其一賦值

    if (portraits.length > 0) {                 // 肖像畫獄卒:全收,當日無底薪
      const amt = R.portrait * portraits.length
      segments.push({ title: '肖像畫', amount: amt, rows: portraits.map(p => ({ name: p._customer || p.person_name || '（未指定）', amount: R.portrait })) })
      direct = amt
    } else if (kind === 'named') {              // 指名互動:max(底薪, 服務收入)
      let service = 0
      if (slots) { const a = R.namedSlot * slots; segments.push({ title: '指名時段', amount: a, rows: noms.map(x => ({ name: x._customer || '（未指定）', calc: `${w(R.namedSlot)}萬 × ${arr(x.slot_times).length}段`, amount: R.namedSlot * arr(x.slot_times).length })) }); service += a }
      if (qtyU) { segments.push({ title: '拍立得（空白）', amount: polUAmt, rows: polaroidRows(polU, false, R.polaroidUnsigned) }); service += polUAmt }
      if (qtyS) { segments.push({ title: '拍立得（簽繪）', amount: polSAmt, rows: polaroidRows(polS, true, R.polaroidSigned) }); service += polSAmt }
      const floor = Math.max(0, R.base - service)
      if (floor > 0) segments.push({ title: service > 0 ? '底薪補足' : '底薪', amount: floor })
      direct = service + floor
    } else {                                    // 集體趕稿:底薪 + 個人服務獎金
      segments.push({ title: '底薪', amount: R.base })
      direct = R.base
      if (qtyU) { segments.push({ title: '拍立得（空白）', amount: polUAmt, rows: polaroidRows(polU, false, R.polaroidUnsigned) }); direct += polUAmt }
      if (qtyS) { segments.push({ title: '拍立得（簽繪）', amount: polSAmt, rows: polaroidRows(polS, true, R.polaroidSigned) }); direct += polSAmt }
      if (supervises.length) { const a = R.supervise * supervises.length; segments.push({ title: '指定監督', amount: a, rows: countRows(supervises, R.supervise) }); direct += a }
      if (visits.length) { const a = R.visit * visits.length; segments.push({ title: '互動探監', amount: a, rows: visits.map(x => ({ name: `${x.visitor_name || '?'} → ${x.person_name || '?'}`, amount: R.visit })) }); direct += a }
    }
    // 指定小費:全額進該獄卒直接薪資(額外加項,不影響底薪補足)
    const tipDirect = its.filter(x => x.item_type === 'tip')
    const tipDirectAmt = tipDirect.reduce((s, x) => s + (x.amount || 0), 0)
    if (tipDirectAmt) { segments.push({ title: '追加小費', note: '指定', amount: tipDirectAmt, rows: tipDirect.map(t => ({ name: t._customer || '（未指定）', amount: t.amount || 0 })) }); direct += tipDirectAmt }
    return { id: g.id, name: g.name, inmate_no: g.inmate_no, direct, pool: 0, final: direct, segments }
  })

  const directTotal = perGuard.reduce((s, g) => s + g.direct, 0)

  // 監獄營業額逐項(依定價分組加總)
  const nSignup = items.filter(x => x.item_type === 'signup').length
  const nSupervise = items.filter(x => x.item_type === 'signup' && x.supervise).length
  const sumType = t => items.filter(x => x.item_type === t).reduce((s, x) => s + (x.amount || 0), 0)
  const revenueRows = []
  if (kind === 'crunch') {
    if (nSignup) revenueRows.push({ label: '入場費', amount: PRICE.entry * nSignup })
    if (nSupervise) revenueRows.push({ label: '指定監督', amount: PRICE.supervise * nSupervise })
    const v = sumType('visit'); if (v) revenueRows.push({ label: '互動探監', amount: v })
    const p = sumType('polaroid'); if (p) revenueRows.push({ label: '拍立得', amount: p })
    const po = sumType('portrait'); if (po) revenueRows.push({ label: '肖像畫', amount: po })
  } else {
    const nom = sumType('nominate'); if (nom) revenueRows.push({ label: '指名費', amount: nom })
    const e = sumType('entry') - waiveTotal; if (e) revenueRows.push({ label: waiveTotal ? '無指名入場（折抵後）' : '無指名入場', amount: e })
    const p = sumType('polaroid'); if (p) revenueRows.push({ label: '拍立得', amount: p })
    const po = sumType('portrait'); if (po) revenueRows.push({ label: '肖像畫', amount: po })
  }
  if (tipTotalAll) revenueRows.push({ label: '小費', amount: tipTotalAll })

  // 均分獎金:淨收入(不含不指定小費)50% 均分給出勤獄卒、50% 監獄留存。
  // 不指定小費全額進獎金池均分(監獄不留存);指定小費已於上方進該獄卒直接薪資。
  // 追加薪資(監獄發給獄卒):指定→該獄卒;全體→均分。加到最終薪資、從監獄留存扣除。
  const net = revenue - directTotal                            // directTotal 已含指定小費
  const nonTipNet = net - tipPool                              // 不指定小費從 50/50 拆分抽出(全額進池)
  const basePool = nonTipNet > 0 ? nonTipNet * R.poolRate : 0  // 淨收為負時不發獎金(不倒扣獄卒);監獄留存吸收負值
  const pool = basePool + tipPool                             // 均分獎金池 = 淨收 50% + 全額不指定小費
  const perBasePool = guards.length ? basePool / guards.length : 0
  const perTipPool = guards.length ? tipPool / guards.length : 0
  const perBonusAll = guards.length ? bonusAll / guards.length : 0
  const perPool = perBasePool + perTipPool
  const retain = nonTipNet - basePool - bonusTotal            // 監獄留存(不含小費;扣掉追加薪資)
  perGuard.forEach(g => {
    g.pool = perPool; g.final = g.direct + perPool
    if (perBasePool) g.segments.push({ title: '均分獎金', note: `淨收 50% ÷ ${guards.length} 人`, amount: perBasePool })
    if (perTipPool) g.segments.push({ title: '追加小費', note: `均分 ÷ ${guards.length} 人`, amount: perTipPool })
    const bd = bonusByGuard[g.id] || 0
    if (bd) { g.segments.push({ title: '追加薪資', note: '指定', amount: bd }); g.final += bd }
    if (perBonusAll) { g.segments.push({ title: '追加薪資', note: `全體均分 ÷ ${guards.length} 人`, amount: perBonusAll }); g.final += perBonusAll }
  })
  const salaryTotal = perGuard.reduce((s, g) => s + g.final, 0)
  return { kind, revenue, directTotal, net, pool, perPool, retain, salaryTotal, revenueRows, guards: perGuard, tipTotal: tipTotalAll, bonusTotal, waiveTotal }
}
