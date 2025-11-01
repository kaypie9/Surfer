import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const redis = Redis.fromEnv()

function normalize(raw: any): { member: string; score: number }[] {
  if (!raw) return []
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') {
    const out: { member: string; score: number }[] = []
    for (let i = 0; i < raw.length; i += 2) out.push({ member: String(raw[i]), score: Number(raw[i + 1]) })
    return out
  }
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
    return raw.map((r: any) => ({ member: String(r.member), score: Number(r.score) }))
  }
  return []
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const game = url.searchParams.get('game') || ''
    const op = url.searchParams.get('op') || 'top'
    if (!game) return NextResponse.json({ error: 'bad_query' }, { status: 400 })
    const key = `lb:${game}`

    if (op === 'count') {
      const count = await redis.zcard(key)
      return NextResponse.json({ game, count })
    }

    // get player rank & score
if (op === 'rank') {
  const member = (url.searchParams.get('member') || '').toLowerCase()
  if (!member) return NextResponse.json({ error: 'bad_member' }, { status: 400 })
  const rank = await redis.zrevrank(key, member)
  const score = await redis.zscore(key, member)
  return NextResponse.json({ game, member, rank, score: score ? Number(score) : 0 })
}

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 25), 1), 100)
    const raw = await redis.zrange(key, 0, limit - 1, { withScores: true, rev: true })
    return NextResponse.json({ game, limit, rows: normalize(raw) })
  } catch (err: any) {
    console.error('LB_GET_ERROR', err)
    return NextResponse.json({ error: 'lb_get_failed', detail: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }) }
    const { game, member, score } = body || {}
    if (!game || !member || typeof score !== 'number') {
      return NextResponse.json({ error: 'bad_body' }, { status: 400 })
    }
    const key = `lb:${game}`
    const prev = await redis.zscore(key, member)
    const next = prev != null ? Math.max(Number(prev), score) : score
    if (prev == null || next !== Number(prev)) {
      await redis.zadd(key, { score: next, member })
    }
    return NextResponse.json({ ok: true, game, member, score: next })
  } catch (err: any) {
    console.error('LB_POST_ERROR', err)
    return NextResponse.json({ error: 'lb_post_failed', detail: String(err?.message || err) }, { status: 500 })
  }
}
