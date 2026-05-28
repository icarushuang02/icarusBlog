import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function POST(req: Request) {
	if (process.env.NODE_ENV !== 'development') {
		return NextResponse.json({ error: '仅在开发环境可用' }, { status: 403 })
	}

	try {
		const { slug, title, md, tags, date, summary, cover, hidden, category } = await req.json()

		if (!slug || !md) {
			return NextResponse.json({ error: '缺少 slug 或 md' }, { status: 400 })
		}

		const blogsDir = path.join(process.cwd(), 'public', 'blogs', slug)
		fs.mkdirSync(blogsDir, { recursive: true })

		// 写 config.json
		const config = { title, tags, date, summary, cover, hidden, category }
		fs.writeFileSync(path.join(blogsDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')

		// 写 index.md
		fs.writeFileSync(path.join(blogsDir, 'index.md'), md, 'utf-8')

		// 更新 index.json
		const indexPath = path.join(process.cwd(), 'public', 'blogs', 'index.json')
		let index: any[] = []
		if (fs.existsSync(indexPath)) {
			index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
		}
		const entry = { slug, title, tags, date, summary, cover, hidden, category }
		const idx = index.findIndex((e: any) => e.slug === slug)
		if (idx >= 0) index[idx] = entry
		else index.unshift(entry)
		fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

		return NextResponse.json({ ok: true })
	} catch (err: any) {
		return NextResponse.json({ error: err.message }, { status: 500 })
	}
}
