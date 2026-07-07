import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { ProgressBar } from '../ManuscriptManager'
import { computeProgress } from '../progress'
import { normalizeStatus, SESSION_STATUS_LABEL, materializeResultMsg } from './constants'
import { startServingChain } from './sessionActions'
import SessionTimerControl from './SessionTimerControl'
import GuardAssign from './GuardAssign'
import SessionPOS from './SessionPOS'
import SalarySettlement from './SalarySettlement'
import { askConfirm } from '../ConfirmDialog'

// 非 serving 狀態時,控制條番茄鐘區的提示(典獄長另有「開始服刑」鈕;獄卒僅見提示)
const TIMER_HINT = {
  booking: '場次預約中，尚未開始服刑',
  booking_paused: '已停止預約，尚未開始服刑',
  intake: '準備服刑中，請按「開始服刑」完成啟動',
  ended: '本場已結束',
}

export default function SessionTab({ currentSession, setCurrentSession, sessions, endedSessions = [], inmates, isWarden, setMsg, reloadShared, onGoToManuscripts }) {
  const [roster, setRoster] = useState([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [goalsByInmate, setGoalsByInmate] = useState({}) // session_inmate_id -> [{id, manuscript_id, title}]
  const [msByMember, setMsByMember] = useState({})       // member_id -> [active manuscripts]
  const [goalSteps, setGoalSteps] = useState({})         // manuscript_id -> [steps]
  const [pickGoal, setPickGoal] = useState({})           // session_inmate_id -> 選中的 manuscript_id
  const [goalModalInmate, setGoalModalInmate] = useState(null) // 開啟「新增本場目標」modal 的犯人 roster row(null=關閉)
  const [goalExpanded, setGoalExpanded] = useState([])   // 展開中的目標(session_goals.id)
  const [startingServe, setStartingServe] = useState(false) // 「開始服刑」處理中:即時回饋 + 防連點
  const [posVer, setPosVer] = useState(0)                // POS 異動版本號:每次結帳/刪項 +1,通知內嵌薪資結算重算

  async function loadRoster(sid) {
    if (!sid) { setRoster([]); return }
    setRosterLoading(true)
    const { data: si } = await supabase.from('session_inmates')
      .select('id, state, member_id, role_in_session').eq('session_id', sid)
    if (!si || si.length === 0) { setRoster([]); setRosterLoading(false); return }
    const ids = si.map(r => r.member_id)
    const { data: profs } = await supabase.from('profiles')
      .select('id, inmate_no, game_name, display_name, avatar_url, role').in('id', ids)
    const merged = si.map(r => ({
      ...r,
      profile: (profs ?? []).find(p => p.id === r.member_id)
    }))
    setRoster(merged); setRosterLoading(false)
  }
  useEffect(() => { loadRoster(currentSession) }, [currentSession])

  // 載入本場每個犯人的「本場目標」+ 各自 active 稿件 + 目標稿件的子項目(算進度)
  async function loadGoals(rosterArg) {
    const rs = rosterArg ?? roster
    if (!rs.length) { setGoalsByInmate({}); setMsByMember({}); setGoalSteps({}); return }
    const inmateIds = rs.map(r => r.id)
    const memberIds = rs.map(r => r.member_id)
    const { data: goals } = await supabase.from('session_goals')
      .select('id, session_inmate_id, manuscript_id').in('session_inmate_id', inmateIds)
    const { data: ms } = await supabase.from('manuscripts')
      .select('id, member_id, title, status, is_done').in('member_id', memberIds)
    const msById = {}; for (const m of ms ?? []) msById[m.id] = m
    const goalMsIds = (goals ?? []).map(g => g.manuscript_id)
    let steps = []
    if (goalMsIds.length) {
      const { data: st } = await supabase.from('manuscript_steps')
        .select('id, manuscript_id, title, done, sort_order')
        .in('manuscript_id', goalMsIds).order('sort_order').order('created_at')
      steps = st ?? []
    }
    const gByInmate = {}
    for (const g of goals ?? [])
      (gByInmate[g.session_inmate_id] ??= []).push({ ...g, title: msById[g.manuscript_id]?.title ?? '（未知稿件）', is_done: msById[g.manuscript_id]?.is_done })
    const mByMember = {}
    for (const m of (ms ?? []).filter(x => x.status === 'active'))
      (mByMember[m.member_id] ??= []).push(m)
    const sBy = {}
    for (const s of steps) (sBy[s.manuscript_id] ??= []).push(s)
    setGoalsByInmate(gByInmate); setMsByMember(mByMember); setGoalSteps(sBy)
  }
  useEffect(() => { loadGoals() }, [roster])

  async function addInmateGoal(sessionInmateId, manuscriptId) {
    const mid = manuscriptId ?? pickGoal[sessionInmateId]   // modal 直接帶稿件 id;沿用原下拉時讀 pickGoal
    if (!mid) return
    const { error } = await supabase.from('session_goals')
      .insert({ session_inmate_id: sessionInmateId, manuscript_id: mid })
    if (error) { setMsg('加入目標失敗：' + error.message); return }
    setPickGoal({ ...pickGoal, [sessionInmateId]: '' }); loadGoals()
  }

  async function removeInmateGoal(goalId) {
    const { error } = await supabase.from('session_goals').delete().eq('id', goalId)
    if (error) { setMsg('移除目標失敗：' + error.message); return }
    loadGoals()
  }

  function openBroadcast(sessionId) {
    window.open(window.location.origin + '/?broadcast=' + sessionId, '_blank', 'width=1280,height=720')
  }

  async function removeFromSession(row) {
    if (!await askConfirm({ title: '移出本場', message: '確定將這位犯人移出本場？本場目標會一併清除，其預約也會標記為取消（不會在重新帶入名單時再出現）。', confirmLabel: '移出本場', danger: true })) return
    // 移出本場 = 取消預約:先把同場同人(user_id=member_id)的預約標記 cancelled,避免「開始服刑」重新帶入名單時又出現
    if (row.member_id) {
      const { error: bErr } = await supabase.from('bookings')
        .update({ status: 'cancelled' })
        .eq('session_id', currentSession).eq('user_id', row.member_id).neq('status', 'cancelled')
      if (bErr) { setMsg('取消預約失敗：' + bErr.message); return }
    }
    const { error } = await supabase.from('session_inmates').delete().eq('id', row.id)
    if (error) { setMsg('移出失敗：' + error.message); return }
    setMsg('已移出本場並取消預約'); loadRoster(currentSession)  // 本場目標靠 cascade 自動清
  }

  async function toggleGoalStep(step) {
    const next = !step.done
    const setDone = (val) => setGoalSteps(prev => {
      const arr = prev[step.manuscript_id] ?? []
      return { ...prev, [step.manuscript_id]: arr.map(s => s.id === step.id ? { ...s, done: val } : s) }
    })
    // 1) 樂觀更新:先改本地 state,進度條立即重算
    setDone(next)
    // 2) 背景寫 DB;失敗則回滾畫面並提示(避免畫面與 DB 不一致)
    const { error } = await supabase.from('manuscript_steps').update({ done: next }).eq('id', step.id)
    if (error) { setDone(step.done); setMsg('子項目更新失敗，已還原：' + error.message) }
  }

  function toggleGoalExpand(goalId) {
    setGoalExpanded(prev => prev.includes(goalId)
      ? prev.filter(x => x !== goalId)
      : [...prev, goalId])
  }

  // 直接開始服刑(僅 warden):本分頁一鈕完成 帶入預約名單 + 進 serving,不必跳「場次總覽」。
  // 成功後 reloadShared 刷新共用 sessions → currentSessionObj 變 serving → 自動切換成番茄鐘控台。
  async function startServing() {
    if (!currentSessionObj) return
    setStartingServe(true)
    const r = await startServingChain(currentSessionObj)
    setStartingServe(false)
    if (r.error) { setMsg(r.error); reloadShared(); return }
    setMsg(r.msg)
    loadRoster(currentSession)   // 名單剛帶入,立即刷新
    reloadShared()
  }

  // 結束服刑(進行中場次直接結束,不必跳「場次總覽」)。
  async function endServing() {
    if (!currentSession) return
    if (!await askConfirm({ title: '結束服刑', message: '確定結束本場服刑？結束後不可重開。', confirmLabel: '結束服刑', danger: true })) return
    const { error } = await supabase.rpc('set_session_status', { p_session: currentSession, p_new_status: 'ended' })
    if (error) { setMsg('結束服刑失敗：' + error.message); return }
    setMsg('已結束服刑'); reloadShared()
  }

  // 重新帶入預約名單(僅 warden):intake 後又有人新預約時手動補帶。
  async function rematerialize() {
    if (!currentSession) return
    const { data: skipped, error } = await supabase.rpc('materialize_session_bookings', { p_session: currentSession })
    if (error) { setMsg('帶入失敗：' + error.message); return }
    setMsg(materializeResultMsg(skipped))
    loadRoster(currentSession)
  }
  const currentSessionObj = sessions.find(s => s.id === currentSession) ?? endedSessions.find(s => s.id === currentSession)

  return (
    <div>
      {/* 場次控制條:目前場次 / 直播大螢幕 / 番茄鐘 / 開始服刑(開新場次移至「場次總覽」) */}
      <div className="control">
        <div className="seg">
          <span className="lbl">目前場次</span>
          <div className="row">
            <select className="sel" value={currentSession} onChange={e => setCurrentSession(e.target.value)}>
              <option value="">— 選擇場次 —</option>
              {sessions.map(s => <option key={s.id} value={s.id}>{s.title}（{SESSION_STATUS_LABEL[normalizeStatus(s)] ?? '未知'}）</option>)}
              {/* 已結束場次也可選:用於補登/修改購買紀錄(POS) */}
              {endedSessions.length > 0 && (
                <optgroup label="已結束場次（可編輯購買紀錄）">
                  {endedSessions.map(s => <option key={s.id} value={s.id}>{s.title}（已結束）</option>)}
                </optgroup>
              )}
            </select>
          </div>
        </div>
        <div className="seg">
          <span className="lbl">直播大螢幕</span>
          <div className="row broadcast-list">
            {sessions.length === 0
              ? <span className="muted">無開放場次</span>
              : sessions.map(s => (
                <button key={s.id} className="btn-sm" onClick={() => openBroadcast(s.id)}>📺 {s.title} ↗</button>
              ))}
          </div>
        </div>
        {/* 番茄鐘控台:只有場次 = serving 時才有意義(計時資料),故只在 serving 渲染。
            其餘狀態在此顯示提示,實際狀態機操作在「場次總覽」分頁。
            key={session.id} 讓切換場次時內部狀態(輪數輸入等)自動重置。 */}
        {currentSessionObj && (() => {
          const st = normalizeStatus(currentSessionObj)
          const canStart = isWarden && (st === 'booking' || st === 'booking_paused' || st === 'intake')
          const startBtn = canStart && (
            <button className="btn-sm btn-pri" disabled={startingServe} onClick={startServing}>
              {startingServe ? '啟動中…' : '開始服刑'}
            </button>
          )
          // 指名場/自由入場不使用番茄鐘;未開始可一鈕開始服刑、進行中可直接結束。
          if (currentSessionObj.kind === 'named' || currentSessionObj.kind === 'free')
            return (
              <div className="seg">
                <span className="lbl">{currentSessionObj.kind === 'named' ? '指名場' : '自由入場'}</span>
                <div className="row timer-state">
                  <span className="muted">{st === 'serving'
                    ? (currentSessionObj.kind === 'named' ? '指名場不使用番茄鐘，於下方 POS 開單' : '自由入場無番茄鐘管理')
                    : (TIMER_HINT[st] ?? '本場尚未開始服刑')}</span>
                  {startBtn}
                  {isWarden && st === 'serving' && <button className="btn-sm btn-danger" onClick={endServing}>結束服刑</button>}
                </div>
              </div>
            )
          if (st === 'serving')
            return <SessionTimerControl key={currentSessionObj.id} session={currentSessionObj}
              setMsg={setMsg} reloadShared={reloadShared} />
          return (
            <div className="seg">
              <span className="lbl">番茄鐘</span>
              <div className="row timer-state">
                {/* 未開始:本分頁一鈕開始服刑(帶入名單+啟動番茄鐘),不必跳「場次總覽」 */}
                {startBtn || <span className="muted">{TIMER_HINT[st] ?? '本場尚未開始服刑'}</span>}
                {canStart && <span className="muted">{TIMER_HINT[st]}</span>}
              </div>
            </div>
          )
        })()}
      </div>

      {/* 本場名單(犯人;獄卒改由「獄卒排班」/POS 檢視,不在此手動新增) */}
      <div className="card-panel">
        <div className="head">
          <h2>本場名單</h2>
          {isWarden && currentSession && <button className="btn-sm" onClick={rematerialize}>重新帶入預約名單</button>}
        </div>
          <div className="body">
            {rosterLoading ? <p className="empty">載入中…</p>
              : roster.length === 0 ? <p className="empty">本場還沒有人</p> : (() => {
              const inmateRoster = roster.filter(r => r.role_in_session !== 'guard')
              const guardRoster = roster.filter(r => r.role_in_session === 'guard')
              return (<>
              <div className="group-lbl">本場犯人 ({inmateRoster.length})<span className="ln" /></div>
              {inmateRoster.length === 0 ? <p className="empty">本場沒有犯人</p> : inmateRoster.map(r => {
              const goals = goalsByInmate[r.id] ?? []
              const avInit = r.profile?.inmate_no != null ? String(r.profile.inmate_no).padStart(2, '0').slice(-2) : (r.profile?.game_name ?? '?')[0]
              return (
                <div key={r.id} className="member">
                  <div className="m-top">
                    <div className="avatar">{avInit}</div>
                    <div>
                      <div className="m-id">No.{String(r.profile?.inmate_no).padStart(4, '0')}</div>
                      <div className="m-nm">{r.profile?.game_name ?? r.profile?.display_name} <span className="faint">（{r.state}）</span></div>
                    </div>
                    <button className="btn-danger btn-sm spacer" onClick={() => removeFromSession(r)}>移出本場</button>
                  </div>
                  <div className="m-detail">
                    {/* 本場目標 */}
                    <div className="detail-row" style={{ alignItems: 'flex-start' }}>
                      <span className="k">本場目標</span>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {goals.length === 0 ? <span className="v">尚未挑選</span> : goals.map(g => {
                          const steps = goalSteps[g.manuscript_id] ?? []
                          const prog = computeProgress({ steps, isDone: g.is_done })
                          const isOpen = goalExpanded.includes(g.id)
                          return (
                            <div key={g.id}>
                              <div className="detail-row">
                                <span style={{ flex: '0 0 130px', fontSize: 14 }}>{g.title}</span>
                                <div style={{ flex: 1, minWidth: 120 }}><ProgressBar progress={prog} /></div>
                                <button className="btn-sm" onClick={() => toggleGoalExpand(g.id)}>{isOpen ? '收合' : '展開'}</button>
                                <button className="btn-sm btn-danger" onClick={() => removeInmateGoal(g.id)}>移除</button>
                              </div>
                              {isOpen && (
                                <div className="substeps">
                                  {steps.length === 0 ? (
                                    <p className="empty">這本稿還沒有子項目</p>
                                  ) : steps.map(s => (
                                    <div key={s.id} className="step">
                                      <input type="checkbox" checked={s.done} onChange={() => toggleGoalStep(s)} />
                                      <span className={s.done ? 'done-text' : ''}>{s.title}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                        <div className="detail-row">
                          <button className="btn-sm" onClick={() => setGoalModalInmate(r)}>+ 新增本場目標</button>
                        </div>
                      </div>
                    </div>

                    {isWarden && (
                      <div className="detail-row" style={{ alignItems: 'flex-start' }}>
                        <span className="k">專屬獄卒</span>
                        <GuardAssign sessionInmateId={r.id} guardRoster={guardRoster} setMsg={setMsg} />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

              </>)
            })()}
          </div>
        </div>

      {/* 進行中場次 POS(指名/集體場):上班獄卒排程 + 走查加購(寫結算)+ 臨時追加犯人。上班獄卒直接由排班帶入。
          不限場次狀態:預約中即可先臨時報名/開單,已結束也可補登/修改購買紀錄。 */}
      {isWarden && currentSession && ['named', 'crunch'].includes(currentSessionObj?.kind) && (
        <SessionPOS session={currentSessionObj} inmates={inmates} setMsg={setMsg} reloadShared={reloadShared}
          onPosChange={() => setPosVer(v => v + 1)} />
      )}

      {/* 薪資結算(整場總覽 + 每位獄卒明細)內嵌於進行中場次,讀 POS。posVer 變動即重算(結帳後自動更新) */}
      {isWarden && currentSession && ['named', 'crunch'].includes(currentSessionObj?.kind) && (
        <SalarySettlement currentSession={currentSession} embedded posVersion={posVer} />
      )}

      {/* 新增本場目標 modal:把原本 inline 挑稿清單搬進 modal,挑稿沿用 addInmateGoal,可連續挑多筆。
          可挑清單即時依 goalsByInmate/msByMember 重算(挑進來的稿自動從清單移除)。 */}
      {goalModalInmate && (() => {
        const r = goalModalInmate
        const goalIds = (goalsByInmate[r.id] ?? []).map(g => g.manuscript_id)
        const available = (msByMember[r.member_id] ?? []).filter(m => !goalIds.includes(m.id))
        const name = r.profile?.game_name ?? r.profile?.display_name
        return (
          <div className="admin-modal-bg" onClick={() => setGoalModalInmate(null)}>
            <div className="admin-modal goal-modal" onClick={e => e.stopPropagation()}>
              <div className="goal-modal-head">
                <h3>新增本場目標 · {name}</h3>
                <button className="goal-modal-x" onClick={() => setGoalModalInmate(null)}>✕</button>
              </div>
              {available.length === 0 ? (
                <div className="goal-modal-empty">
                  <p className="warn">沒有可以加入的稿件，請到「我的稿件」新增</p>
                  {onGoToManuscripts && (
                    <button className="btn-pri" onClick={() => { setGoalModalInmate(null); onGoToManuscripts() }}>前往我的稿件</button>
                  )}
                </div>
              ) : (
                <div className="goal-pick-list">
                  {available.map(m => (
                    <button key={m.id} className="goal-pick" onClick={() => addInmateGoal(r.id, m.id)}>
                      <span className="goal-pick-title">{m.title}</span>
                      <span className="goal-pick-add">＋ 加入</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
