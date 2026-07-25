import { NextRequest, NextResponse } from 'next/server'

// 모든 페이지의 "AI 추천"이 공통으로 호출하는 서버 라우트.
// 브라우저에서 직접 Anthropic API를 호출하면 API 키가 노출되고(보안 문제),
// 애초에 브라우저 fetch에는 인증 헤더가 없어서 무조건 실패하기 때문에
// 반드시 서버(Next.js API route)를 거쳐서 호출해야 한다.
export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json()
    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt가 필요합니다.' }, { status: 400 })
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다. .env.local에 추가해주세요.' },
        { status: 500 }
      )
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('Anthropic API error:', res.status, errText)
      return NextResponse.json({ error: `AI 분석 요청이 실패했습니다. (${res.status})` }, { status: 502 })
    }

    const data = await res.json()
    const text = (data.content || [])
      .map((c: any) => c.text || '')
      .join('')
      .trim()

    return NextResponse.json({ text: text || '분석 결과가 비어 있습니다.' })
  } catch (e: any) {
    console.error('ai-insight route error:', e)
    return NextResponse.json({ error: e?.message || '알 수 없는 오류가 발생했습니다.' }, { status: 500 })
  }
}
