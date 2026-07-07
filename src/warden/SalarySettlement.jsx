import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { SESSION_KIND_LABEL, DEFAULT_SESSION_KIND } from '../sessionKind'
import { calcSettlement, money, formatElaiAndPrisonPayout, formatGuardPayslip } from './salaryRules'
import { fetchPriceRows, settlementRates } from '../prices'
import { sendSalaryBroadcast, zhSalaryError } from '../salaryApi'

// 伊萊諾斯(典獄長本人)以收監編號 0001 辨識;其薪資與監獄留存皆留在身上,不對外發放。
const ELAI_INMATE_NO = 1
const TEN_K = 10000                                     // 「萬」→ 原始 Gil 換算(結算用萬、驗算用完整 Gil)
const gilFmt = n => `${Math.round(Number(n) || 0).toLocaleString('en-US')} Gil`   // 原始 Gil 千分位顯示

// 場次薪資結算(僅典獄長,唯讀):讀 pos_order_items,依 salaryRules 逐筆算每位獄卒薪資與監獄收支。
// 只計算顯示,不寫入。金額「萬」整數。已移除 purchase_addons 與監獄外抓捕。
// 資料來源(分開查詢再 JS 合併):上班獄卒 ← session_guards + profiles;品項 ← pos_order_items。

// 金額欄:固定寬右對齊(不同位數對齊成一直排)
const Amt = ({ v, neg = false, strong = false }) => (
  <span className={`pay-amt${neg ? ' neg' : ''}${strong ? ' strong' : ''}`}>{money(v)}</span>
)

export default function SalarySettlement({ currentSession, embedded = false, posVersion = 0 }) {
  const [allSessions, setAllSessions] = useState([])
  const [sid, setSid] = useState(currentSession || '')
  const [guards, setGuards] = useState([])   // [{id, name}]
  const [items, setItems] = useState([])     // pos_order_items
  const [loading, setLoading] = useState(false)
  const [gil, setGil] = useState('')          // 費用驗算:典獄長身上原有金額(萬)
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState(null)
  const [sendingGuard, setSendingGuard] = useState(null) // 發送中的獄卒 id | '_all' | null
  const [priceRows, setPriceRows] = useState(null)   // 價目表(guard_cut 拆帳設定;未載/未建表落回內建預設)

  useEffect(() => { fetchPriceRows().then(setPriceRows) }, [posVersion])   // POS 異動時一併刷新拆帳設定

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('sessions').select('id, title, session_date, kind').order('created_at', { ascending: false })
      setAllSessions(data ?? [])
      setSid(prev => prev || currentSession || (data?.[0]?.id ?? ''))
    })()
  }, [currentSession])

  // 內嵌於進行中場次時,永遠跟隨當前場次(不顯示自己的選單)
  useEffect(() => { if (embedded && currentSession) setSid(currentSession) }, [embedded, currentSession])

  const sessionObj = allSessions.find(s => s.id === sid)
  const kind = sessionObj?.kind || DEFAULT_SESSION_KIND

  async function loadSession(id) {
    if (!id) { setGuards([]); setItems([]); return }
    setLoading(true)
    const [{ data: sg }, { data: it }, { data: ords }] = await Promise.all([
      supabase.from('session_guards').select('guard_id').eq('session_id', id),
      supabase.from('pos_order_items').select('order_id, item_type, person_name, target_guard_id, qty, with_signature, amount, visitor_name, slot_times, supervise').eq('session_id', id),
      supabase.from('pos_orders').select('id, customer_name').eq('session_id', id),
    ])
    // 每筆品項附上本單犯人(_customer):肖像/探監用 person_name,拍立得/指名用訂單的 customer_name
    const custById = {}; for (const o of ords ?? []) custById[o.id] = o.customer_name
    const itemsC = (it ?? []).map(x => ({ ...x, _customer: x.person_name || custById[x.order_id] || null }))
    // 上班獄卒 ∪ 有 POS 品項的獄卒(避免排班變動後漏算)
    const gids = [...new Set([...(sg ?? []).map(r => r.guard_id), ...itemsC.map(r => r.target_guard_id).filter(Boolean)])]
    let gList = []
    if (gids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, game_name, display_name, inmate_no').in('id', gids)
      const byId = {}; for (const p of profs ?? []) byId[p.id] = p
      gList = gids.map(g => ({ id: g, name: byId[g]?.game_name || byId[g]?.display_name || '獄卒', inmate_no: byId[g]?.inmate_no ?? 1e9 }))
        .sort((a, b) => a.inmate_no - b.inmate_no)   // 獄卒依犯人編號排序
    }
    setGuards(gList)
    setItems(itemsC)
    setLoading(false)
  }
  useEffect(() => { loadSession(sid) }, [sid, posVersion])   // sid 或 POS 異動(結帳/刪項)時重算

  // 拆帳率來自價目表 guard_cut(典獄長可在「品項價目表」調整);未設定的鍵落回內建預設
  const result = calcSettlement({ kind, guards, items, rates: priceRows ? settlementRates(priceRows, kind) : null })   // React Compiler 自動記憶化(手動 useMemo 會被跳過優化)
  const isFree = kind === 'free'

  // 費用驗算(集體/指名場):原GIL + 當日營業額 = 發薪前總額;發薪後只留伊萊諾斯薪資與監獄留存。
  // 結算金額單位為「萬」,驗算改用原始 Gil(典獄長輸入完整金額),故換算 ×10000。
  const elai = result.guards.find(g => g.inmate_no === ELAI_INMATE_NO) || null
  const revenueGil = result.revenue * TEN_K
  const elaiGil = (elai?.final ?? 0) * TEN_K
  const retainGil = result.retain * TEN_K
  const othersGil = result.guards.filter(g => g.inmate_no !== ELAI_INMATE_NO).reduce((s, g) => s + g.final, 0) * TEN_K
  const g0 = Number(gil) || 0
  const preTotal = g0 + revenueGil            // 發薪前總金額 = 原GIL + 當日營業額
  const afterBalance = preTotal - othersGil   // 發薪後餘額 = 前總額 − 其他獄卒薪資
  const shouldRemain = g0 + elaiGil + retainGil  // 對照:原GIL + 伊萊諾斯薪資 + 監獄留存
  const diff = afterBalance - shouldRemain     // 驗算差額(理應為 0)

  // 發送到「伊萊諾斯和監獄的收支」頻道:伊萊諾斯薪資 + 監獄收支一起送(測試階段)
  async function sendElaiPayslip() {
    setSending(true); setSendMsg(null)
    const r = await sendSalaryBroadcast(formatElaiAndPrisonPayout(elai, result, sessionObj))
    setSending(false)
    setSendMsg(r.ok ? '已發送伊萊諾斯薪資與監獄收支到頻道。' : `發送失敗：${zhSalaryError(r.error)}`)
  }

  // 單一獄卒:薪資明細發到「該獄卒的個人薪資頻道」(webhook 由伺服器端對照)
  async function sendGuardPayslip(g) {
    setSendingGuard(g.id); setSendMsg(null)
    const r = await sendSalaryBroadcast(formatGuardPayslip(g, sessionObj), g.name)
    setSendingGuard(null)
    setSendMsg(r.ok ? `已發送 ${g.name} 的薪資明細到個人頻道。` : `${g.name} 發送失敗：${zhSalaryError(r.error)}`)
  }

  // 一鍵發送全部獄卒(伊萊諾斯除外,其薪資走監獄收支頻道):逐位發送,結尾彙整成功/失敗
  async function sendAllPayslips() {
    const targets = result.guards.filter(g => g.inmate_no !== ELAI_INMATE_NO)
    if (!targets.length) { setSendMsg('沒有可發送的獄卒。'); return }
    setSendingGuard('_all'); setSendMsg(null)
    const fails = []
    for (const g of targets) {
      const r = await sendSalaryBroadcast(formatGuardPayslip(g, sessionObj), g.name)
      if (!r.ok) fails.push(`${g.name}（${zhSalaryError(r.error)}）`)
    }
    setSendingGuard(null)
    setSendMsg(fails.length
      ? `已發送 ${targets.length - fails.length}／${targets.length} 位；失敗：${fails.join('、')}`
      : `已發送全部 ${targets.length} 位獄卒的薪資明細到各自頻道。`)
  }

  return (
    <div className="settle-wrap">
      {!embedded && (
        <div className="card-panel" style={{ marginBottom: 16 }}>
          <div className="head"><h2>場次薪資結算</h2><span className="count">只計算顯示 · 讀 POS</span></div>
          <div className="body">
            <div className="settle-tools">
              <label>結算場次
                <select className="sel" value={sid} onChange={e => setSid(e.target.value)} style={{ minWidth: 220 }}>
                  <option value="">— 選擇場次 —</option>
                  {allSessions.map(s => <option key={s.id} value={s.id}>{s.title}{s.session_date ? `（${s.session_date}）` : ''}</option>)}
                </select>
              </label>
              <span className="tag tag-pill" style={{ background: 'rgba(180,120,255,.14)', color: '#c2a3ff' }}>{SESSION_KIND_LABEL[kind] ?? kind}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn-sm btn-pri" onClick={() => loadSession(sid)} disabled={!sid || loading}>{loading ? '計算中…' : '↻ 重新計算'}</button>
            </div>
          </div>
        </div>
      )}

      {!sid ? (embedded ? null : <p className="empty">請先選擇場次</p>)
        : isFree ? <p className="empty">自由入場場無獄卒管理，不進行薪資結算。</p>
          : (<>
            {/* 整場總覽(4 數字速覽) */}
            <div className="settle-overview">
              <div className="ov-cell"><span className="ov-lbl">當日營業額</span><span className="ov-num">{money(result.revenue)}</span></div>
              <div className="ov-cell"><span className="ov-lbl">獄卒基礎薪資</span><span className="ov-num">{money(result.directTotal)}</span></div>
              <div className="ov-cell"><span className="ov-lbl">獎金（均分獎金池）</span><span className="ov-num">{money(result.pool)}</span></div>
              <div className="ov-cell hl"><span className="ov-lbl">監獄留存</span><span className={`ov-num${result.retain < 0 ? ' neg' : ''}`}>{money(result.retain)}</span></div>
            </div>

            {/* A. 人員薪資卡(網格並排) */}
            <div className="pay-sec-lbl">獄卒薪資明細<span className="ln" /><span className="pay-sec-count">{result.guards.length} 位</span></div>
            {result.guards.length === 0 ? <p className="empty">本場沒有上班獄卒</p> : (
              <div className="pay-cards">
                {result.guards.map(g => (
                  <div key={g.id} className="pay-card">
                    <div className="pay-card-head">
                      <span className="pc-name">{g.name}</span>
                      <span className="pc-final">{money(g.final)}</span>
                    </div>
                    <div className="pay-card-body">
                      {g.segments.map((seg, i) => (
                        <div key={i} className="pay-seg">
                          <div className="pay-seg-head">
                            <span className="ps-title">{seg.title}{seg.note ? <span className="ps-note">（{seg.note}）</span> : null}</span>
                            <Amt v={seg.amount} />
                          </div>
                          {seg.rows?.map((r, j) => (
                            <div key={j} className="pay-row">
                              <span className="pr-name">{r.name}</span>
                              {r.tag && <span className="pr-tag">{r.tag}</span>}
                              {r.calc && <span className="pr-calc mono">{r.calc}</span>}
                              <Amt v={r.amount} />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="pay-card-foot">
                      <span>最終薪資</span><Amt v={g.final} strong />
                      {/* 伊萊諾斯薪資走「監獄收支」頻道發送,不在卡上單發 */}
                      {g.inmate_no !== ELAI_INMATE_NO && (
                        <button className="btn-sm" disabled={sendingGuard != null}
                          title="發送這位獄卒的薪資明細到其個人 Discord 頻道"
                          onClick={() => sendGuardPayslip(g)}>
                          {sendingGuard === g.id ? '發送中…' : '📤 發送'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* B. 監獄收支 / C. 費用驗算 並列 */}
            <div className="settle-cols">
              {/* B. 監獄收支卡 */}
              <div>
                <div className="pay-sec-lbl">監獄收支<span className="ln" /></div>
                <div className="prison-card">
                  <div className="prison-block">
                    <div className="pb-title">營業額來源</div>
                    {result.revenueRows.length === 0 ? <div className="prison-row"><span>—</span><Amt v={0} /></div>
                      : result.revenueRows.map((r, i) => (
                        <div key={i} className="prison-row"><span>{r.label}</span><Amt v={r.amount} /></div>
                      ))}
                    <div className="prison-row sum"><span>營業額合計</span><Amt v={result.revenue} strong /></div>
                  </div>
                  <div className="prison-block">
                    <div className="pb-title">結算</div>
                    <div className="prison-row"><span>獄卒直接薪資{result.tipTotal ? '（含指定小費）' : ''}</span><Amt v={-result.directTotal} neg /></div>
                    <div className="prison-row sum"><span>淨收入（營業額 − 直接薪資）</span><Amt v={result.net} neg={result.net < 0} /></div>
                    <div className="prison-row"><span>均分獎金池（淨收 50%{result.tipTotal ? ' + 不指定小費' : ''}，發給獄卒）</span><Amt v={-result.pool} neg /></div>
                    {result.bonusTotal > 0 && <div className="prison-row"><span>追加薪資（監獄額外發給獄卒）</span><Amt v={-result.bonusTotal} neg /></div>}
                    <div className="prison-row hl"><span>監獄留存（淨收 50%{result.tipTotal ? '，不含小費' : ''}{result.bonusTotal ? '，已扣追加薪資' : ''}，用於後續活動經費）</span><Amt v={result.retain} neg={result.retain < 0} strong /></div>
                  </div>
                </div>
                <p className="settle-note">資料來源 POS 結帳（pos_order_items）。金額單位「萬」。此頁僅計算顯示，不寫入。</p>
              </div>

              {/* C. 費用驗算(僅計算,不寫入;單位為原始 Gil):原GIL + 當日營業額 → 發薪前總額;發薪後只留伊萊諾斯薪資與監獄留存。 */}
              <div>
                <div className="pay-sec-lbl">驗算<span className="ln" /></div>
                <div className="prison-card">
                  <div className="prison-block">
                    <div className="pb-title">輸入</div>
                    <label className="prison-row" style={{ alignItems: 'center' }}>
                      <span>原有金額（Gil）</span>
                      <input className="inp mono" type="number" value={gil} onChange={e => setGil(e.target.value)}
                        onFocus={e => e.target.select()} placeholder="0" style={{ width: 140, textAlign: 'right' }} />
                    </label>
                  </div>
                  <div className="prison-block">
                    <div className="pb-title">驗算</div>
                    <div className="prison-row"><span>原有金額</span><span className="pay-amt">{gilFmt(g0)}</span></div>
                    <div className="prison-row"><span>＋ 當日營業額</span><span className="pay-amt">{gilFmt(revenueGil)}</span></div>
                    <div className="prison-row sum"><span>發薪前總金額</span><span className="pay-amt strong">{gilFmt(preTotal)}</span></div>
                    <div className="prison-row"><span>－ 其他獄卒薪資（伊萊諾斯以外）</span><span className="pay-amt neg">-{gilFmt(othersGil)}</span></div>
                    <div className="prison-row hl"><span>發薪後餘額</span><span className={`pay-amt strong${afterBalance < 0 ? ' neg' : ''}`}>{gilFmt(afterBalance)}</span></div>
                    <div className="prison-row" style={{ opacity: .8 }}><span>對照：原GIL + 伊萊諾斯薪資（{gilFmt(elaiGil)}）+ 監獄留存（{gilFmt(retainGil)}）</span><span className="pay-amt">{gilFmt(shouldRemain)}</span></div>
                    {Math.abs(diff) > 0.001 && (
                      <div className="prison-row" style={{ color: 'var(--alarm, #d8412f)' }}><span>驗算差額（理應為 0）</span><span className="pay-amt neg">{gilFmt(diff)}</span></div>
                    )}
                  </div>
                </div>
                <p className="settle-note">單位為原始 Gil（結算「萬」自動 ×10000）。發薪後餘額 = 原有金額 + 當日營業額 − 伊萊諾斯以外獄卒薪資；剩下的即伊萊諾斯薪資與監獄留存。</p>
              </div>
            </div>

            {/* 發送今日薪資明細:各獄卒送各自個人頻道;伊萊諾斯薪資+監獄收支送收支頻道 */}
            <div className="settle-send">
              <button className="btn-sm btn-pri" onClick={sendAllPayslips} disabled={sendingGuard != null || sending}
                title="把每位獄卒的薪資明細發送到各自的 Discord 個人頻道（伊萊諾斯除外）">
                {sendingGuard === '_all' ? '逐位發送中…' : '📤 發送全部獄卒薪資'}
              </button>
              <button className="btn-sm btn-pri" onClick={sendElaiPayslip} disabled={sending || sendingGuard != null}
                title="把伊萊諾斯薪資與監獄收支一起發送到 Discord 頻道">
                {sending ? '發送中…' : '發送薪資與監獄收支'}
              </button>
              {sendMsg && <p className="settle-note" style={{ margin: 0 }}>{sendMsg}</p>}
            </div>
          </>)}
    </div>
  )
}
