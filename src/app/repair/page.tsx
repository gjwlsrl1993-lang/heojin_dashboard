'use client'

import { useEffect, useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'

type RepairRow = {
  id: number
  item_id: number
  status: '수선중' | '수선완료' | '폐기'
  qty: number
  vendor: string | null
  defect_note: string | null
  repair_date: string
  memo: string | null
  item?: { name: string; sku: string; option_name: string; cost_price: number; season: string | null }
}

const monthNavBtnStyle: React.CSSProperties = { border: '1px solid #94a3b8', background: '#f8fafc', cursor: 'pointer', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#475569' }

export default function RepairPage() {
  const [rows, setRows] = useState<RepairRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [items, setItems] = useState<{ id: number; name: string; sku: string; option_name: string; cost_price: number; season: string | null }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ item_id: '', qty: '', vendor: '', defect_note: '', repair_date: new Date().toISOString().slice(0, 10), memo: '' })
  const [saving, setSaving] = useState(false)
  const excelInputRef = useRef<HTMLInputElement | null>(null)

  const [viewMonth, setViewMonth] = useState(new Date().toISOString().slice(0, 7))
  const [seasonIdx, setSeasonIdx] = useState(0)

  function shiftMonth(delta: number) {
    const [y, m] = viewMonth.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setViewMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data: recordData } = await supabase
      .from('repair_records')
      .select('*')
      .order('repair_date', { ascending: false })

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
    await supabase.from('repair_records').insert({
      item_id: Number(form.item_id),
      status: '수선중',
      qty: Number(form.qty),
      vendor: form.vendor || null,
      defect_note: form.defect_note || null,
      repair_date: form.repair_date,
      memo: form.memo || null,
    })
    setSaving(false)
    setShowAddForm(false)
    setForm({ item_id: '', qty: '', vendor: '', defect_note: '', repair_date: new Date().toISOString().slice(0, 10), memo: '' })
    load()
  }

  async function changeStatus(id: number, status: RepairRow['status']) {
    await supabase.from('repair_records').update({ status }).eq('id', id)
    load()
  }

  async function deleteRecord(id: number) {
    if (!confirm('이 수선 기록을 삭제할까요?')) return
    await supabase.from('repair_records').delete().eq('id', id)
    load()
  }

  async function handleExcelUpload(file: File) {
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheetName = wb.SheetNames.includes('수선 등록') ? '수선 등록' : wb.SheetNames[0]
      const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])

      const { data: allItems } = await supabase.from('items').select('id, name, option_name')

      let added = 0, skipped = 0
      for (const row of rows) {
        const name = row['상품명']?.toString().trim()
        const option = row['옵션']?.toString().trim() || 'F'
        const qty = Number(row['수량'])
        if (!name || !qty) { skipped++; continue }

        const match = allItems?.find(i => i.name === name && i.option_name === option)
        if (!match) { skipped++; continue }

        let repairDate = new Date().toISOString().slice(0, 10)
        const raw = row['날짜']
        if (raw) {
          if (typeof raw === 'number') repairDate = XLSX.SSF.format('yyyy-mm-dd', raw)
          else {
            const parsed = new Date(String(raw).trim().replace(/\./g, '-'))
            if (!isNaN(parsed.getTime())) repairDate = parsed.toISOString().slice(0, 10)
          }
        }

        const statusRaw = row['상태']?.toString().trim()
        const status = (['수선중', '수선완료', '폐기'].includes(statusRaw) ? statusRaw : '수선중') as RepairRow['status']

        await supabase.from('repair_records').insert({
          item_id: match.id,
          status,
          qty,
          vendor: row['업체']?.toString().trim() || null,
          defect_note: row['불량내용']?.toString().trim() || null,
          repair_date: repairDate,
          memo: row['메모']?.toString().trim() || null,
        })
        added++
      }
      alert(`업로드 완료\n등록 ${added}건 / 건너뜀 ${skipped}건`)
      load()
    } catch (e: any) {
      console.error(e)
      alert('엑셀 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploading(false)
      if (excelInputRef.current) excelInputRef.current.value = ''
    }
  }

  const repairingCount = rows.filter(r => r.status === '수선중').length
  const repairedCount = rows.filter(r => r.status === '수선완료').length
  const discardedCount = rows.filter(r => r.status === '폐기').length
  const totalCost = rows.reduce((s, r) => s + (r.item?.cost_price || 0) * r.qty, 0)

  const monthlySummary = (() => {
    const map = new Map<string, { count: number; cost: number }>()
    for (const r of rows) {
      const month = r.repair_date?.slice(0, 7)
      if (!month) continue
      const cost = (r.item?.cost_price || 0) * r.qty
      const prev = map.get(month) || { count: 0, cost: 0 }
      map.set(month, { count: prev.count + 1, cost: prev.cost + cost })
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  })()

  const seasonSummary = (() => {
    const map = new Map<string, { count: number; cost: number }>()
    for (const r of rows) {
      const season = r.item?.season || '미지정'
      const cost = (r.item?.cost_price || 0) * r.qty
      const prev = map.get(season) || { count: 0, cost: 0 }
      map.set(season, { count: prev.count + 1, cost: prev.cost + cost })
    }
    return Array.from(map.entries()).sort((a, b) => (b[0] < a[0] ? 1 : -1))
  })()

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">수선 관리</h2>
          <p className="page-sub">수선 진행 상태와 원가 현황 관리</p>
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
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>수선중</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>{repairingCount}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>수선완료</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#059669' }}>{repairedCount}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>폐기</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#e11d48' }}>{discardedCount}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>원가 합계</div>
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
                  <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>{season} 건수</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button onClick={() => setSeasonIdx(i => hasData ? Math.min(i + 1, seasonSummary.length - 1) : 0)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 12 }}>◀</button>
                    <button onClick={() => setSeasonIdx(i => Math.max(i - 1, 0))} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 12 }}>▶</button>
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{s.count}건</div>
              </div>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>{season} 원가</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{s.cost.toLocaleString('ko-KR')}원</div>
              </div>
            </>
          )
        })()}

        {(() => {
          const stat = monthlySummary.find(([m]) => m === viewMonth)?.[1] || { count: 0, cost: 0 }
          const shortMonth = viewMonth.slice(2).replace('-', '.')
          return (
            <>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>{shortMonth} 건수</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button onClick={() => shiftMonth(-1)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 12 }}>◀</button>
                    <button onClick={() => shiftMonth(1)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 12 }}>▶</button>
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{stat.count}건</div>
              </div>
              <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>{shortMonth} 원가</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{stat.cost.toLocaleString('ko-KR')}원</div>
              </div>
            </>
          )
        })()}
      </div>

      {showAddForm && (
        <div style={{ background: '#fff', border: '2px solid #4f46e5', borderRadius: 16, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: '#4f46e5' }}>+ 수선 등록</div>
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
              <input type="number" value={form.qty} onChange={e => setForm(p => ({ ...p, qty: e.target.value }))} placeholder="예: 1" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>날짜</div>
              <input type="date" value={form.repair_date} onChange={e => setForm(p => ({ ...p, repair_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>업체</div>
              <input value={form.vendor} onChange={e => setForm(p => ({ ...p, vendor: e.target.value }))} placeholder="수선 업체" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>불량내용</div>
              <input value={form.defect_note} onChange={e => setForm(p => ({ ...p, defect_note: e.target.value }))} placeholder="예: 박음질 불량" style={inputStyle} />
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
                {['날짜', '시즌', '상품명', '옵션', '수량', '업체', '불량내용', '메모', '상태', ''].map(h => (
                  <th key={h} style={{ padding: '10px 8px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 48, color: '#757575' }}>등록된 수선 기록이 없습니다.</td></tr>
              ) : rows.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.repair_date}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.item?.season || '-'}</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>{r.item?.name || '(삭제된 상품)'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.item?.option_name || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700 }}>{r.qty}개</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{r.vendor || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#757575' }}>{r.defect_note || '-'}</td>
                  <td style={{ padding: '8px', color: '#757575', fontSize: 12 }}>{r.memo || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    <select value={r.status} onChange={e => changeStatus(r.id, e.target.value as RepairRow['status'])}
                      style={{
                        border: '1px solid #94a3b8', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        color: r.status === '수선완료' ? '#059669' : r.status === '폐기' ? '#e11d48' : '#d97706',
                        background: r.status === '수선완료' ? '#f0fdf4' : r.status === '폐기' ? '#fef2f2' : '#fff7ed',
                      }}>
                      <option value="수선중">수선중</option>
                      <option value="수선완료">수선완료</option>
                      <option value="폐기">폐기</option>
                    </select>
                  </td>
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

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#757575', fontWeight: 700, marginBottom: 4 }
const selectStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }