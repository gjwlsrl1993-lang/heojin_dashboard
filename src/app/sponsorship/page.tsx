'use client'

import { useEffect, useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'

type SponsorshipRow = {
  id: number
  item_id: number
  qty: number
  recipient: string | null
  contact: string | null
  email: string | null
  sent_date: string
  due_date: string | null
  returned_date: string | null
  returned: boolean
  memo: string | null
  item?: { name: string; sku: string; option_name: string; cost_price: number; season: string | null }
}

const DELIVERY_FEE = 3000

export default function SponsorshipPage() {
  const [rows, setRows] = useState<SponsorshipRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [items, setItems] = useState<{ id: number; name: string; sku: string; option_name: string; cost_price: number }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ item_id: '', qty: '', recipient: '', contact: '', email: '', sent_date: new Date().toISOString().slice(0, 10), due_date: '', memo: '' })
  const [saving, setSaving] = useState(false)
  const [viewMonth, setViewMonth] = useState(new Date().toISOString().slice(0, 7)) // YYYY-MM
  const [seasonIdx, setSeasonIdx] = useState(0)

  function shiftMonth(delta: number) {
    const [y, m] = viewMonth.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setViewMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const excelInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data: recordData } = await supabase
      .from('seeding_records')
      .select('*')
      .eq('type', '협찬')
      .order('sent_date', { ascending: false })

    const { data: itemData } = await supabase
      .from('items')
      .select('id, name, sku, option_name, cost_price, season')
      .order('name')

    setItems(itemData || [])

    const merged = (recordData || []).map((r: any) => ({
      ...r,
      item: (itemData || []).find((i: any) => i.id === r.item_id),
    }))
    setRows(merged)
    setLoading(false)
  }

  async function addRecord() {
    if (!form.item_id || !form.qty) { alert('상품과 수량을 선택/입력해주세요.'); return }
    setSaving(true)
    await supabase.from('seeding_records').insert({
      item_id: Number(form.item_id),
      type: '협찬',
      qty: Number(form.qty),
      recipient: form.recipient || null,
      contact: form.contact || null,
      email: form.email || null,
      sent_date: form.sent_date,
      due_date: form.due_date || null,
      memo: form.memo || null,
    })
    setSaving(false)
    setShowAddForm(false)
    setForm({ item_id: '', qty: '', recipient: '', contact: '', email: '', sent_date: new Date().toISOString().slice(0, 10), due_date: '', memo: '' })
    load()
  }

  async function markReturned(row: SponsorshipRow) {
    if (row.returned) return
    if (!confirm('반납 완료 처리할까요? (재고에 다시 반영됩니다)')) return
    await supabase.from('seeding_records').update({
      returned: true,
      returned_date: new Date().toISOString().slice(0, 10),
      returned_qty: row.qty, // 전량 반납 완료 처리 (재고 계산에서 협찬 미회수분을 뺄 때 사용)
    }).eq('id', row.id)
    load()
  }

  async function deleteRecord(id: number) {
    if (!confirm('이 협찬 기록을 삭제할까요?')) return
    await supabase.from('seeding_records').delete().eq('id', id)
    load()
  }

  function parseSheetDate(raw: any): string | null {
    if (!raw) return null
    if (typeof raw === 'number') return XLSX.SSF.format('yyyy-mm-dd', raw)
    if (raw instanceof Date && !isNaN(raw.getTime())) {
      return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`
    }
    const parsed = new Date(String(raw).trim().replace(/\./g, '-'))
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
    return null
  }

  // 문자열 비교용 정규화: 앞뒤 공백 제거 + 소문자 변환 + 내부 연속 공백 하나로
  function normalize(v: any): string {
    return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  }

  // 옵션 정규화: 'F', '', 'NONE', '없음', '단일옵션' 등은 전부 동일한 옵션(프리사이즈)으로 취급
  function normalizeOption(v: any): string {
    const n = normalize(v)
    if (n === '' || n === 'f' || n === 'free' || n === 'none' || n === 'null' || n === '없음' || n === '단일') return 'f'
    return n
  }

  async function handleExcelUpload(file: File) {
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const sheetName = wb.SheetNames.includes('협찬 등록') ? '협찬 등록' : wb.SheetNames[0]
      const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])

      const { data: allItems, error: itemsError } = await supabase.from('items').select('id, name, sku, option_name')

      if (itemsError) {
        alert('상품 목록을 불러오지 못했습니다 (권한/네트워크 오류).\n' + itemsError.message)
        return
      }
      if (!allItems || allItems.length === 0) {
        alert('등록된 상품이 없습니다. 재고 제어판에서 상품을 먼저 등록해주세요.')
        return
      }

      let added = 0, skipped = 0
      const skipReasons: string[] = []
      const insertErrors: string[] = []

      for (const [i, row] of rows.entries()) {
        const rawStyle = row['스타일넘버']
        const rawName = row['아이템명']
        const rawOption = row['옵션']
        const styleNo = rawStyle?.toString().trim()
        const name = rawName?.toString().trim()
        const option = rawOption?.toString().trim()
        const qty = Number(row['수량'])

        if ((!styleNo && !name) || !qty) {
          skipped++
          skipReasons.push(`${i + 2}행: 스타일넘버/아이템명 또는 수량 누락`)
          continue
        }

        // 1순위: 스타일넘버 + 옵션으로 매칭 (대소문자/공백 무시, F=없음=None 동일 취급)
        // 2순위(스타일넘버가 없는 행): 아이템명 + 옵션으로 매칭
        const match = styleNo
          ? allItems.find(
              it => normalize(it.sku) === normalize(styleNo) && normalizeOption(it.option_name) === normalizeOption(option)
            )
          : allItems.find(
              it => normalize(it.name) === normalize(name) && normalizeOption(it.option_name) === normalizeOption(option)
            )

        if (!match) {
          skipped++
          const label = styleNo ? `스타일넘버 "${styleNo}" (${option || 'F'})` : `"${name}" (${option || 'F'})`
          skipReasons.push(`${i + 2}행: ${label} — 재고에서 매칭되는 상품 없음`)
          continue
        }

        const sentDate = parseSheetDate(row['전달날짜']) || new Date().toISOString().slice(0, 10)
        const dueDate = parseSheetDate(row['반납예정일'])
        const returnedDate = parseSheetDate(row['반납일'])

        const { error: insertError } = await supabase.from('seeding_records').insert({
          item_id: match.id,
          type: '협찬',
          qty,
          recipient: row['이름']?.toString().trim() || null,
          contact: row['연락처']?.toString().trim() || null,
          email: row['이메일']?.toString().trim() || null,
          sent_date: sentDate,
          due_date: dueDate,
          returned_date: returnedDate,
          returned: !!returnedDate,
          returned_qty: returnedDate ? qty : 0,
          memo: row['메모']?.toString().trim() || null,
        })

        if (insertError) {
          skipped++
          insertErrors.push(`${i + 2}행: 저장 실패 (${insertError.message})`)
          continue
        }
        added++
      }

      let msg = `업로드 완료\n등록 ${added}건 / 건너뜀 ${skipped}건`
      if (skipReasons.length) msg += `\n\n[매칭/입력 실패]\n` + skipReasons.slice(0, 15).join('\n')
      if (insertErrors.length) msg += `\n\n[저장 오류]\n` + insertErrors.slice(0, 15).join('\n')
      alert(msg)
      load()
    } catch (e: any) {
      console.error(e)
      alert('엑셀 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploading(false)
      if (excelInputRef.current) excelInputRef.current.value = ''
    }
  }

  const totalQty = rows.reduce((s, r) => s + r.qty, 0)
  const notReturnedCount = rows.filter(r => !r.returned).length
  const totalCost = rows.reduce((s, r) => s + ((r.item?.cost_price || 0) + DELIVERY_FEE) * r.qty, 0)

  // 월별 요약 (전달날짜 기준) — 건수 / 원가+택배비 합계
  const monthlySummary = (() => {
    const map = new Map<string, { count: number; cost: number }>()
    for (const r of rows) {
      const month = r.sent_date?.slice(0, 7) // YYYY-MM
      if (!month) continue
      const cost = ((r.item?.cost_price || 0) + DELIVERY_FEE) * r.qty
      const prev = map.get(month) || { count: 0, cost: 0 }
      map.set(month, { count: prev.count + 1, cost: prev.cost + cost })
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  })()

  // 시즌별 요약 — 건수 / 원가+택배비 합계
  const seasonSummary = (() => {
    const map = new Map<string, { count: number; cost: number }>()
    for (const r of rows) {
      const season = r.item?.season || '미지정'
      const cost = ((r.item?.cost_price || 0) + DELIVERY_FEE) * r.qty
      const prev = map.get(season) || { count: 0, cost: 0 }
      map.set(season, { count: prev.count + 1, cost: prev.cost + cost })
    }
    return Array.from(map.entries()).sort((a, b) => (b[0] < a[0] ? 1 : -1))
  })()

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">협찬 관리</h2>
          <p className="page-sub">나갔다가 돌려받는 상품 — 반납 완료 시 재고에 다시 반영</p>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8, marginTop: -16 }}>
        <input ref={excelInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleExcelUpload(f) }} />
        <button onClick={() => excelInputRef.current?.click()} disabled={uploading}
          style={{ padding: '6px 14px', border: '1px solid #94a3b8', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, lineHeight: 1.3 }}>
          <span style={{ fontSize: 16 }}>📤</span>
          <span>{uploading ? '업로드 중...' : '엑셀 업로드'}</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: 8, marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>총 협찬 건수</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{rows.length}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>총 나간 수량</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{totalQty}개</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>미반납 건수</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: notReturnedCount > 0 ? '#d97706' : '#059669' }}>{notReturnedCount}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>원가+택배비 합계</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{totalCost.toLocaleString('ko-KR')}원</div>
        </div>

        {(() => {
          const hasData = seasonSummary.length > 0
          const idx = hasData ? Math.min(seasonIdx, seasonSummary.length - 1) : 0
          const [season, s] = hasData ? seasonSummary[idx] : ['시즌 없음', { count: 0, cost: 0 }]
          return (
            <>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>{season} 건수</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button onClick={() => setSeasonIdx(i => hasData ? Math.min(i + 1, seasonSummary.length - 1) : 0)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>◀</button>
                    <button onClick={() => setSeasonIdx(i => Math.max(i - 1, 0))} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>▶</button>
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{s.count}건</div>
              </div>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>{season} 원가+택배비</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{s.cost.toLocaleString('ko-KR')}원</div>
              </div>
            </>
          )
        })()}

        {(() => {
          const stat = monthlySummary.find(([m]) => m === viewMonth)?.[1] || { count: 0, cost: 0 }
          const shortMonth = viewMonth.slice(2).replace('-', '.') // 2026-07 -> 26.07
          return (
            <>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>{shortMonth} 건수</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button onClick={() => shiftMonth(-1)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>◀</button>
                    <button onClick={() => shiftMonth(1)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>▶</button>
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{stat.count}건</div>
              </div>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>{shortMonth} 원가+택배비</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{stat.cost.toLocaleString('ko-KR')}원</div>
              </div>
            </>
          )
        })()}
      </div>

      {showAddForm && (
        <div style={{ background: '#fff', border: '2px solid #4f46e5', borderRadius: 16, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: '#4f46e5' }}>+ 협찬 등록</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: 'span 2' }}>
              <div style={labelStyle}>상품 *</div>
              <select value={form.item_id} onChange={e => setForm(p => ({ ...p, item_id: e.target.value }))} style={selectStyle}>
                <option value="">선택</option>
                {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.option_name}) — {i.sku}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>수량 *</div>
              <input type="number" value={form.qty} onChange={e => setForm(p => ({ ...p, qty: e.target.value }))} placeholder="예: 2" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>전달날짜</div>
              <input type="date" value={form.sent_date} onChange={e => setForm(p => ({ ...p, sent_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>반납예정일</div>
              <input type="date" value={form.due_date} onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>이름</div>
              <input value={form.recipient} onChange={e => setForm(p => ({ ...p, recipient: e.target.value }))} placeholder="받는 사람/업체" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>연락처</div>
              <input value={form.contact} onChange={e => setForm(p => ({ ...p, contact: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>이메일</div>
              <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} style={inputStyle} />
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <div style={labelStyle}>메모</div>
              <input value={form.memo} onChange={e => setForm(p => ({ ...p, memo: e.target.value }))} placeholder="선택 사항" style={inputStyle} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowAddForm(false)} style={{ padding: '8px 18px', border: '1px solid #94a3b8', borderRadius: 8, background: '#f8fafc', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>취소</button>
            <button onClick={addRecord} disabled={saving} style={{ padding: '8px 18px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              {saving ? '저장 중...' : '등록'}
            </button>
          </div>
        </div>
      )}

      {loading ? <div className="loading">로딩 중...</div> : (
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['순차', '시즌', '아이템명', '원가+택배비', '전달날짜', '반납예정일', '반납일', '수량', '이름', '연락처', '이메일', '메모', ''].map(h => (
                  <th key={h} style={{ padding: '10px 8px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={13} style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>등록된 협찬 기록이 없습니다.</td></tr>
              ) : rows.map((r, idx) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#94a3b8' }}>{idx + 1}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.item?.season || '-'}</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>{r.item?.name || '(삭제된 상품)'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.item ? ((r.item.cost_price || 0) + DELIVERY_FEE).toLocaleString('ko-KR') + '원' : '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.sent_date}</td>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#d97706' }}>{r.due_date || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    {r.returned ? (
                      <span style={{ color: '#059669', fontWeight: 700 }}>{r.returned_date}</span>
                    ) : (
                      <button onClick={() => markReturned(r)}
                        style={{ border: '1px solid #4f46e5', background: '#eef2ff', color: '#4f46e5', cursor: 'pointer', fontSize: 11, padding: '4px 10px', borderRadius: 6, fontWeight: 700 }}>
                        반납완료
                      </button>
                    )}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700 }}>{r.qty}개</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.recipient || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#94a3b8' }}>{r.contact || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#94a3b8' }}>{r.email || '-'}</td>
                  <td style={{ padding: '8px', color: '#94a3b8', fontSize: 12 }}>{r.memo || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    <button onClick={() => deleteRecord(r.id)} title="삭제"
                      style={{ border: 'none', background: 'none', color: '#e11d48', cursor: 'pointer', fontSize: 15, fontWeight: 800, lineHeight: 1 }}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }
const selectStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const monthNavBtnStyle: React.CSSProperties = { border: '1px solid #94a3b8', background: '#f8fafc', cursor: 'pointer', borderRadius: 6, padding: '6px 14px', fontSize: 13, fontWeight: 700, color: '#475569' }