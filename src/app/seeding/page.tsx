'use client'

import { useEffect, useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'

type SeedingRow = {
  id: number
  item_id: number
  qty: number
  recipient: string | null
  instagram: string | null
  contact: string | null
  email: string | null
  route: string | null
  sent_date: string
  memo: string | null
  item?: { name: string; sku: string; option_name: string; cost_price: number; season: string | null }
}

const DELIVERY_FEE = 3000

// 엑셀 "전달날짜" 값을 'YYYY-MM-DD'로 변환. 인식 실패/빈값이면 null 반환.
// - 260305 / "260305" (YYMMDD, 6자리) -> 2026-03-05 (20YY로 취급)
// - 20260305 / "20260305" (YYYYMMDD, 8자리) -> 2026-03-05
// - 진짜 엑셀 날짜 시리얼 숫자(보통 4~5자리)는 기존처럼 XLSX.SSF로 변환
// - "2026.03.05", "2026-03-05" 등 구분자 있는 문자열은 기존 로직으로 변환
function parseSentDate(raw: any): string | null {
  if (raw === undefined || raw === null || raw === '') return null

  const toIsoIfValid = (y: string, m: string, d: string) => {
    const iso = `${y}-${m}-${d}`
    return isNaN(new Date(iso).getTime()) ? null : iso
  }

  if (typeof raw === 'number') {
    const digits = String(Math.trunc(raw))
    if (digits.length === 8) return toIsoIfValid(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8))
    if (digits.length === 6) return toIsoIfValid(`20${digits.slice(0, 2)}`, digits.slice(2, 4), digits.slice(4, 6))
    // 그 외 숫자는 엑셀 날짜 시리얼 값으로 간주
    const formatted = XLSX.SSF.format('yyyy-mm-dd', raw)
    return formatted && !formatted.includes('#') ? formatted : null
  }

  const str = String(raw).trim()
  if (!str) return null

  const digitsOnly = str.replace(/[.\-/\s]/g, '')
  if (/^\d{8}$/.test(digitsOnly)) return toIsoIfValid(digitsOnly.slice(0, 4), digitsOnly.slice(4, 6), digitsOnly.slice(6, 8))
  if (/^\d{6}$/.test(digitsOnly)) return toIsoIfValid(`20${digitsOnly.slice(0, 2)}`, digitsOnly.slice(2, 4), digitsOnly.slice(4, 6))

  const parsed = new Date(str.replace(/\./g, '-'))
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

export default function SeedingPage() {
  const [rows, setRows] = useState<SeedingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [items, setItems] = useState<{ id: number; name: string; sku: string; option_name: string; cost_price: number }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ item_id: '', qty: '', recipient: '', instagram: '', contact: '', email: '', route: '', sent_date: new Date().toISOString().slice(0, 10), memo: '' })
  const [saving, setSaving] = useState(false)
  const [seasonIdx, setSeasonIdx] = useState(0)
  const [yearIdx, setYearIdx] = useState(0)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [showChart, setShowChart] = useState(false)
  const [chartSeason, setChartSeason] = useState<string>('')
  const excelInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data: recordData } = await supabase
      .from('seeding_records')
      .select('*')
      .eq('type', '시딩')
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
      type: '시딩',
      qty: Number(form.qty),
      recipient: form.recipient || null,
      instagram: form.instagram || null,
      contact: form.contact || null, // 선택 입력
      email: form.email || null,     // 선택 입력
      route: form.route || null,
      sent_date: form.sent_date,
      memo: form.memo || null,
    })
    setSaving(false)
    setShowAddForm(false)
    setForm({ item_id: '', qty: '', recipient: '', instagram: '', contact: '', email: '', route: '', sent_date: new Date().toISOString().slice(0, 10), memo: '' })
    load()
  }

  async function deleteRecord(id: number) {
    if (!confirm('이 시딩 기록을 삭제할까요?')) return
    await supabase.from('seeding_records').delete().eq('id', id)
    load()
  }

  async function deleteAllRecords() {
    if (!confirm(`시딩 기록 전체(${rows.length}건)를 삭제할까요? 되돌릴 수 없습니다.`)) return
    if (!confirm('정말로 전체 삭제하시겠습니까?')) return
    await supabase.from('seeding_records').delete().eq('type', '시딩')
    load()
  }

  async function handleExcelUpload(file: File) {
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheetName = wb.SheetNames.includes('시딩 등록') ? '시딩 등록' : wb.SheetNames[0]
      const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])

      const { data: allItems } = await supabase.from('items').select('id, name, sku, option_name')

      const norm = (v: any) => (v ?? '').toString().trim().toLowerCase()

      const normTight = (v: any) => norm(v).replace(/\s+/g, '')

      // 'NONE'과 'F'는 둘 다 "단일옵션"을 의미하는 경우가 있어 서로 동등한 후보로 취급.
      // 단, 재고에 실제로 등록된 값(NONE이든 F든)을 우선하며 강제 변환은 하지 않는다.
      const optionCandidates = (op: string) => {
        const n = norm(op)
        if (n === 'none' || n === 'f') return [n, n === 'none' ? 'f' : 'none']
        return [n]
      }

      let added = 0, skipped = 0, failed = 0
      const skippedRows: string[] = []
      let firstInsertError = ''
      for (const row of rows) {
        const name = row['아이템명']?.toString().trim() // 표시/디버그용으로만 사용 (매칭에는 미사용)
        const styleNo = row['스타일 넘버']?.toString().trim()
        const option = row['옵션']?.toString().trim() || 'F'
        const qty = Number(row['수량'])
        if (!styleNo || !qty) { skipped++; continue }

        const optCands = optionCandidates(option)
        // 스타일넘버 + 옵션으로만 매칭 (상품명은 매칭에 사용하지 않음, 공백/대소문자 무관)
        let match = allItems?.find(i => norm(i.sku) === norm(styleNo) && optCands.includes(norm(i.option_name)))
        // 폴백: 스타일넘버 표기의 공백만 다른 경우 ("HD #2" vs "HD#2") 대응
        if (!match) {
          match = allItems?.find(i => normTight(i.sku) === normTight(styleNo) && optCands.includes(norm(i.option_name)))
        }
        if (!match) {
          skipped++
          // 진단용: 스타일넘버가 겹치는 재고 후보를 찾아 실제 등록된 옵션을 같이 보여준다
          const candidates = (allItems || []).filter(i => normTight(i.sku).includes(normTight(styleNo)) || normTight(styleNo).includes(normTight(i.sku)))
          const candidateInfo = candidates.slice(0, 3).map(i => `${i.name}(sku:${i.sku}/옵션:${i.option_name})`).join(', ')
          skippedRows.push(`${name || '-'} / 스타일넘버:${styleNo} / 옵션:${option}` + (candidateInfo ? `  ← 재고 후보: ${candidateInfo}` : '  ← 재고에 이 스타일넘버 자체가 없음'))
          continue
        }

        const sentDate = parseSentDate(row['전달날짜']) || new Date().toISOString().slice(0, 10) // 날짜 미입력 시 오늘 날짜로 기본 처리

        const { error: insertError } = await supabase.from('seeding_records').insert({
          item_id: match.id,
          type: '시딩',
          qty,
          recipient: row['이름']?.toString().trim() || null,
          instagram: row['인스타']?.toString().trim() || null,
          contact: row['연락처']?.toString().trim() || null,
          email: row['이메일']?.toString().trim() || null,
          route: row['경로']?.toString().trim() || null,
          sent_date: sentDate,
          memo: row['메모']?.toString().trim() || null,
        })
        if (insertError) {
          failed++
          if (!firstInsertError) firstInsertError = insertError.message
          continue
        }
        added++
      }
      const preview = skippedRows.slice(0, 5).join('\n')
      const failMsg = failed > 0 ? `\n\n[DB 저장 실패 ${failed}건] ${firstInsertError}` : ''
      alert(`업로드 완료\n등록 ${added}건 / 매칭 안됨 ${skipped}건 / 저장 실패 ${failed}건` + (preview ? `\n\n[매칭 안된 샘플]\n${preview}` : '') + failMsg)
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
  const totalCost = rows.reduce((s, r) => s + ((r.item?.cost_price || 0) + DELIVERY_FEE) * r.qty, 0)

  // 시즌 문자열(예: "25FW", "26SS")을 최신순으로 정렬하기 위한 순위 계산. 인식 안되는 값(미지정 등)은 맨 뒤로.
  function seasonRank(season: string) {
    const m = season.match(/(\d{2,4})\s*(SS|FW)/i)
    if (!m) return -Infinity
    const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1])
    const half = m[2].toUpperCase() === 'FW' ? 1 : 0
    return year * 10 + half
  }

  // 시즌별 요약 — 건수만 (최근 시즌이 맨 앞)
  const seasonSummary = (() => {
    const map = new Map<string, number>()
    for (const r of rows) {
      const season = r.item?.season || '미지정'
      map.set(season, (map.get(season) || 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => seasonRank(b[0]) - seasonRank(a[0]))
  })()

  // 연도별 요약 (전달날짜 기준) — 건수만 (최근 연도가 맨 앞)
  const yearSummary = (() => {
    const map = new Map<string, number>()
    for (const r of rows) {
      const year = r.sent_date?.slice(0, 4)
      if (!year) continue
      map.set(year, (map.get(year) || 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  })()

  // 아이템별 요약 — 아이템당 시딩 건수/수량, 클릭 시 상세 팝업에 쓸 개별 기록 목록도 함께 보관
  const itemSummary = (() => {
    const map = new Map<number, { item?: SeedingRow['item']; records: SeedingRow[] }>()
    for (const r of rows) {
      const prev = map.get(r.item_id) || { item: r.item, records: [] as SeedingRow[] }
      prev.records.push(r)
      if (!prev.item && r.item) prev.item = r.item
      map.set(r.item_id, prev)
    }
    return Array.from(map.entries()).map(([item_id, v]) => {
      const totalQty = v.records.reduce((s, r) => s + r.qty, 0)
      const totalCost = v.records.reduce((s, r) => s + ((v.item?.cost_price || 0) + DELIVERY_FEE) * r.qty, 0)
      return { item_id, item: v.item, count: v.records.length, totalQty, totalCost, records: v.records }
    }).sort((a, b) => b.count - a.count)
  })()

  const selectedGroup = itemSummary.find(g => g.item_id === selectedItemId) || null

  // 그래프용 시즌 드롭다운 옵션 (최근 시즌이 맨 위) — 데이터 로드 후 최초 1회 최근 시즌으로 기본 선택
  const chartSeasonOptions = seasonSummary.map(([season]) => season)
  useEffect(() => {
    if (!chartSeason && chartSeasonOptions.length > 0) setChartSeason(chartSeasonOptions[0])
  }, [chartSeasonOptions.join(','), chartSeason])

  // 아이템별 시딩 건수 그래프 데이터 (선택한 시즌만, 건수 내림차순)
  const chartData = itemSummary
    .filter(g => (g.item?.season || '미지정') === chartSeason)
    .map(g => ({ name: g.item?.name || '(삭제된 상품)', count: g.count }))
    .sort((a, b) => b.count - a.count)
  const chartMax = Math.max(1, ...chartData.map(d => d.count))

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">시딩 관리</h2>
          <p className="page-sub">인플루언서 등에게 무상으로 나간 상품 — 회수 없이 재고에서 차감</p>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: -16 }}>
        <button onClick={deleteAllRecords} disabled={rows.length === 0}
          style={{ padding: '6px 14px', border: '1px solid #fecaca', borderRadius: 8, background: '#fff', cursor: rows.length === 0 ? 'default' : 'pointer', fontSize: 12, fontWeight: 700, color: '#e11d48', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, lineHeight: 1.3, opacity: rows.length === 0 ? 0.5 : 1 }}>
          <span style={{ fontSize: 16 }}>🗑️</span>
          <span>전체 삭제</span>
        </button>
        <input ref={excelInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleExcelUpload(f) }} />
        <button onClick={() => excelInputRef.current?.click()} disabled={uploading}
          style={{ padding: '6px 14px', border: '1px solid #94a3b8', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, lineHeight: 1.3 }}>
          <span style={{ fontSize: 16 }}>📤</span>
          <span>{uploading ? '업로드 중...' : '엑셀 업로드'}</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>총 시딩 건수</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{rows.length}건</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>총 시딩 수량</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{totalQty}개</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 12, color: '#757575', fontWeight: 700, marginBottom: 4 }}>원가+택배비 합계</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{totalCost.toLocaleString('ko-KR')}원</div>
        </div>

        {(() => {
          const hasData = seasonSummary.length > 0
          const idx = hasData ? Math.min(seasonIdx, seasonSummary.length - 1) : 0
          const [season, count] = hasData ? seasonSummary[idx] : ['시즌 없음', 0]
          return (
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>{season} 건수</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button onClick={() => setSeasonIdx(i => hasData ? Math.min(i + 1, seasonSummary.length - 1) : 0)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>◀</button>
                  <button onClick={() => setSeasonIdx(i => Math.max(i - 1, 0))} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>▶</button>
                </div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{count}건</div>
            </div>
          )
        })()}

        {(() => {
          const hasData = yearSummary.length > 0
          const idx = hasData ? Math.min(yearIdx, yearSummary.length - 1) : 0
          const [year, count] = hasData ? yearSummary[idx] : ['연도 없음', 0]
          return (
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>{year} 건수</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button onClick={() => setYearIdx(i => hasData ? Math.min(i + 1, yearSummary.length - 1) : 0)} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>◀</button>
                  <button onClick={() => setYearIdx(i => Math.max(i - 1, 0))} style={{ ...monthNavBtnStyle, padding: '2px 6px', fontSize: 10 }}>▶</button>
                </div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{count}건</div>
            </div>
          )
        })()}
      </div>

      {showAddForm && (
        <div style={{ background: '#fff', border: '2px solid #4f46e5', borderRadius: 16, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: '#4f46e5' }}>+ 시딩 등록</div>
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
              <input type="number" value={form.qty} onChange={e => setForm(p => ({ ...p, qty: e.target.value }))} placeholder="예: 3" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>전달날짜</div>
              <input type="date" value={form.sent_date} onChange={e => setForm(p => ({ ...p, sent_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>이름</div>
              <input value={form.recipient} onChange={e => setForm(p => ({ ...p, recipient: e.target.value }))} placeholder="받는 사람" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>인스타</div>
              <input value={form.instagram} onChange={e => setForm(p => ({ ...p, instagram: e.target.value }))} placeholder="@handle" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>연락처 (선택)</div>
              <input value={form.contact} onChange={e => setForm(p => ({ ...p, contact: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>이메일 (선택)</div>
              <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>경로</div>
              <input value={form.route} onChange={e => setForm(p => ({ ...p, route: e.target.value }))} placeholder="예: DM 신청" style={inputStyle} />
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

      <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button onClick={() => setShowChart(v => !v)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 800, color: '#0f172a', padding: 0 }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: showChart ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            아이템별 시딩 그래프
          </button>
          {showChart && (
            <select value={chartSeason} onChange={e => setChartSeason(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#fff' }}>
              {chartSeasonOptions.length === 0 && <option value="">시즌 없음</option>}
              {chartSeasonOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>

        {showChart && (
          <div style={{ marginTop: 16 }}>
            {chartData.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: '#757575', fontSize: 13 }}>이 시즌에 등록된 시딩 기록이 없습니다.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {chartData.map(d => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 220, flexShrink: 0, fontSize: 12, fontWeight: 600, color: '#0f172a', textAlign: 'right', wordBreak: 'break-word' }}>{d.name}</div>
                    <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ width: `${(d.count / chartMax) * 100}%`, background: '#4f46e5', color: '#fff', fontSize: 11, fontWeight: 700, padding: '6px 8px', borderRadius: 6, minWidth: 28, textAlign: 'right', boxSizing: 'border-box' }}>
                        {d.count}건
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['순차', '시즌', '아이템명', '시딩 건수', '총 수량', '원가+택배비 합계'].map(h => (
                  <th key={h} style={{ padding: '10px 8px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {itemSummary.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 48, color: '#757575' }}>등록된 시딩 기록이 없습니다.</td></tr>
              ) : itemSummary.map((g, idx) => (
                <tr key={g.item_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '8px', textAlign: 'center', color: '#757575' }}>{idx + 1}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{g.item?.season || '-'}</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>
                    <button onClick={() => setSelectedItemId(g.item_id)}
                      style={{ border: 'none', background: 'none', color: '#4f46e5', cursor: 'pointer', fontWeight: 700, fontSize: 13, textDecoration: 'underline' }}>
                      {g.item?.name || '(삭제된 상품)'}
                    </button>
                  </td>
                  <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700 }}>{g.count}건</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{g.totalQty}개</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{g.totalCost.toLocaleString('ko-KR')}원</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedGroup && (
        <div onClick={() => setSelectedItemId(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, padding: 20, width: '90%', maxWidth: 1000, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{selectedGroup.item?.name || '(삭제된 상품)'} — 시딩 상세 ({selectedGroup.count}건)</div>
              <button onClick={() => setSelectedItemId(null)}
                style={{ border: 'none', background: 'none', color: '#757575', cursor: 'pointer', fontSize: 20, fontWeight: 800, lineHeight: 1 }}>×</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['전달날짜', '수량', '이름', '인스타', '연락처', '이메일', '경로', '메모', ''].map(h => (
                    <th key={h} style={{ padding: '10px 8px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedGroup.records.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{r.sent_date}</td>
                    <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700 }}>{r.qty}개</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{r.recipient || '-'}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{r.instagram || '-'}</td>
                    <td style={{ padding: '8px', textAlign: 'center', color: '#757575' }}>{r.contact || '-'}</td>
                    <td style={{ padding: '8px', textAlign: 'center', color: '#757575' }}>{r.email || '-'}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{r.route || '-'}</td>
                    <td style={{ padding: '8px', color: '#757575', fontSize: 12 }}>{r.memo || '-'}</td>
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
        </div>
      )}
    </div>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#757575', fontWeight: 700, marginBottom: 4 }
const selectStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const monthNavBtnStyle: React.CSSProperties = { border: '1px solid #94a3b8', background: '#f8fafc', cursor: 'pointer', borderRadius: 6, padding: '6px 14px', fontSize: 13, fontWeight: 700, color: '#475569' }