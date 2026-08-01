'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'

type UploadResult = {
  success: boolean
  total: number
  inserted: number
  errors: string[]
  message: string
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleUpload() {
    if (!file) return
    setLoading(true)
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('/api/upload/cafe24', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()
      setResult(data)
    } catch (err) {
      setResult({ success: false, total: 0, inserted: 0, errors: ['네트워크 오류'], message: '업로드 실패' })
    } finally {
      setLoading(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f && (f.name.endsWith('.csv') || f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) {
      setFile(f)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-slate-400 hover:text-slate-600 text-sm">← 대시보드</Link>
        <span className="text-slate-300">/</span>
        <span className="text-sm font-semibold text-slate-700">카페24 데이터 업로드</span>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-8">
        <h2 className="text-xl font-bold text-slate-900 mb-1">카페24 주문내역 업로드</h2>
        <p className="text-sm text-slate-500 mb-6">
          카페24 파트너센터 → 주문관리 → 주문내역 → <strong>엑셀 다운로드</strong>한 파일을 업로드하세요.
        </p>

        {/* 드래그앤드롭 영역 */}
        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
            dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          {file ? (
            <div>
              <p className="text-indigo-600 font-bold text-sm">{file.name}</p>
              <p className="text-slate-400 text-xs mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div>
              <p className="text-slate-500 text-sm">CSV / XLSX 파일을 끌어다 놓거나 클릭해서 선택</p>
              <p className="text-slate-400 text-xs mt-1">카페24 주문내역 엑셀 다운로드 파일</p>
            </div>
          )}
        </div>

        {/* 안내 */}
        <div className="mt-4 bg-slate-50 rounded-xl p-4 text-xs text-slate-600 space-y-1">
          <p className="font-semibold text-slate-700">필요한 컬럼:</p>
          <p>주문번호 · 주문일 · 상품명 · 옵션 · 수량 · 판매가(상품금액)</p>
          <p className="text-slate-400 mt-2">* 상품명/옵션이 Brand Hub에 등록된 상품과 일치해야 자동 매칭됩니다.</p>
        </div>

        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className={`mt-6 w-full py-3 rounded-xl font-bold text-sm transition ${
            file && !loading
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          }`}
        >
          {loading ? '업로드 중...' : '업로드 및 저장'}
        </button>
      </div>

      {/* 결과 */}
      {result && (
        <div className={`rounded-2xl border p-6 ${result.success ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
          <p className={`font-bold text-sm ${result.success ? 'text-emerald-700' : 'text-rose-700'}`}>
            {result.success ? '✓' : '✕'} {result.message}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-extrabold text-slate-800">{result.total}</p>
              <p className="text-xs text-slate-500">전체 행</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold text-emerald-600">{result.inserted}</p>
              <p className="text-xs text-slate-500">저장 성공</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold text-rose-500">{result.errors.length}</p>
              <p className="text-xs text-slate-500">오류</p>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="mt-3 space-y-1">
              {result.errors.slice(0, 5).map((e, i) => (
                <p key={i} className="text-xs text-rose-600">• {e}</p>
              ))}
              {result.errors.length > 5 && (
                <p className="text-xs text-slate-400">... 외 {result.errors.length - 5}건</p>
              )}
            </div>
          )}
          {result.success && (
            <Link href="/" className="mt-4 block text-center text-sm text-indigo-600 font-semibold hover:underline">
              대시보드에서 확인하기 →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}