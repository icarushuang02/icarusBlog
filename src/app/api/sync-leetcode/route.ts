import { NextResponse, type NextRequest } from 'next/server'
import { toBase64Utf8, getRef, createTree, createCommit, updateRef, createBlob, readTextFileFromRepo, type TreeItem } from '@/lib/server-github'
import { getServerAuthToken } from '@/lib/server-auth'
import { htmlToMarkdown, leetcodeSlug } from '@/lib/leetcode-utils'
import { GITHUB_CONFIG } from '@/consts'

const LEETCODE_API = 'https://leetcode.cn/graphql/'
const DEFAULT_TAGS = ['LeetCode', '算法']
const MAX_PAGES = 50

function getLeetcodeHeaders() {
	const cookie = process.env.LEETCODE_COOKIE || ''
	const csrf = cookie.match(/csrftoken=([^;]+)/)?.[1] || ''
	return {
		'Content-Type': 'application/json',
		Cookie: cookie,
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
		Referer: 'https://leetcode.cn',
		'x-csrftoken': csrf
	}
}

async function lcGql(query: string, variables: Record<string, any> = {}) {
	const res = await fetch(LEETCODE_API, {
		method: 'POST',
		headers: getLeetcodeHeaders(),
		body: JSON.stringify({ query, variables })
	})
	if (!res.ok) {
		throw new Error(`LeetCode API 请求失败: ${res.status} ${res.statusText}`)
	}
	const data = await res.json()
	if (data.errors?.length) throw new Error(data.errors.map((e: any) => e.message).join('; '))
	return data.data
}

export async function POST(request: NextRequest) {
	try {
		// 鉴权：检查 SYNC_SECRET（配置了则校验）
		const syncSecret = process.env.SYNC_SECRET
		if (syncSecret) {
			const authHeader = request.headers.get('authorization')
			if (authHeader !== `Bearer ${syncSecret}`) {
				return NextResponse.json({ error: '未授权' }, { status: 401 })
			}
		}

		// 同时检查 GitHub App 私钥是否配置
		if (!process.env.GITHUB_APP_PRIVATE_KEY) {
			return NextResponse.json({ error: '未配置 GITHUB_APP_PRIVATE_KEY 环境变量' }, { status: 500 })
		}

		const cookie = process.env.LEETCODE_COOKIE
		if (!cookie) {
			return NextResponse.json({ error: '未配置 LEETCODE_COOKIE 环境变量' }, { status: 500 })
		}

		// 1. 获取所有 AC 提交
		let allSubmissions: any[] = []
		let offset = 0
		let hasNext = true
		let pageCount = 0
		while (hasNext && pageCount < MAX_PAGES) {
			const data = await lcGql(`
				query ($offset: Int!, $limit: Int!) {
					submissionList(offset: $offset, limit: $limit, status: AC) {
						lastKey hasNext
						submissions { id title statusDisplay lang timestamp }
					}
				}
			`, { offset, limit: 100 })
			allSubmissions.push(...data.submissionList.submissions)
			hasNext = data.submissionList.hasNext
			offset += 100
			pageCount++
		}

		// 2. 去重
		const problemMap = new Map<string, any>()
		for (const sub of allSubmissions) {
			if (sub.statusDisplay === 'Accepted' && !problemMap.has(sub.title)) {
				problemMap.set(sub.title, sub)
			}
		}

		// 3. 读取现有 index.json，找出已存在的 slug
		const token = await getServerAuthToken(GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, GITHUB_CONFIG.APP_ID)
		let existingIndex: any[] = []
		try {
			const txt = await readTextFileFromRepo(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, 'public/blogs/index.json', GITHUB_CONFIG.BRANCH)
			if (txt) existingIndex = JSON.parse(txt)
		} catch {}
		const existingSlugs = new Set(existingIndex.map((e: any) => e.slug))

		// 4. 过滤出新题目
		const toFetch: { title: string; sub: any; slug: string }[] = []
		for (const [title, sub] of problemMap) {
			const slug = leetcodeSlug(title)
			if (!existingSlugs.has(slug)) {
				toFetch.push({ title, sub, slug })
			}
		}

		if (toFetch.length === 0) {
			return NextResponse.json({ ok: true, synced: 0, message: '没有新题目需要同步' })
		}

		// 5. 并发获取详情并生成文件
		const synced: { slug: string; title: string; tags: string[]; date: string; summary: string }[] = []

		const fetchDetail = async (item: { title: string; sub: any; slug: string }) => {
			const detail = await lcGql(`
				query ($id: ID!) {
					submissionDetail(submissionId: $id) {
						code statusDisplay lang
						question {
							questionFrontendId titleSlug translatedTitle translatedContent
							difficulty topicTags { name }
						}
					}
				}
			`, { id: item.sub.id })
			return { ...item, detail: detail.submissionDetail }
		}

		// 并发获取（5个一组）
		const results: any[] = []
		let i = 0
		async function worker() {
			while (i < toFetch.length) {
				const idx = i++
				try {
					results[idx] = await fetchDetail(toFetch[idx])
				} catch (err: any) {
					results[idx] = { error: err.message, title: toFetch[idx].title }
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(5, toFetch.length) }, () => worker()))

		// 6. 构建 tree items
		const treeItems: TreeItem[] = []

		for (const r of results) {
			if (r.error) continue
			const { slug, sub, detail } = r
			const q = detail.question
			const id = q.questionFrontendId
			const title = q.translatedTitle || q.title
			const tags = [...DEFAULT_TAGS, ...q.topicTags.map((t: any) => t.name).slice(0, 3)]
			const date = sub.timestamp ? new Date(sub.timestamp * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
			const content = q.translatedContent || ''
			const summary = content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 100) + '...'
			const basePath = `public/blogs/${slug}`

			// config.json
			const config = { title: `${id}. ${title}`, tags, date, summary, cover: '' }
			const configBlob = await createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(JSON.stringify(config, null, 2)), 'base64')
			treeItems.push({ path: `${basePath}/config.json`, mode: '100644', type: 'blob', sha: configBlob.sha })

			// index.md
			const description = htmlToMarkdown(content)
			const md = `## 题目描述\n\n${description}\n\n## 解法\n\n\`\`\`java\n${detail.code}\n\`\`\`\n`
			const mdBlob = await createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(md), 'base64')
			treeItems.push({ path: `${basePath}/index.md`, mode: '100644', type: 'blob', sha: mdBlob.sha })

			synced.push({ slug, title: `${id}. ${title}`, tags, date, summary })
		}

		if (synced.length === 0) {
			return NextResponse.json({ ok: true, synced: 0, message: '获取题目详情失败' })
		}

		// 7. 更新 index.json
		for (const item of synced) {
			const entry = { slug: item.slug, title: item.title, tags: item.tags, date: `${item.date}T00:00`, summary: item.summary, cover: '', hidden: false, category: '' }
			const idx = existingIndex.findIndex((e: any) => e.slug === item.slug)
			if (idx >= 0) existingIndex[idx] = entry
			else existingIndex.unshift(entry)
		}
		const indexBlob = await createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(JSON.stringify(existingIndex, null, 2)), 'base64')
		treeItems.push({ path: 'public/blogs/index.json', mode: '100644', type: 'blob', sha: indexBlob.sha })

		// 8. 提交
		const refData = await getRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `heads/${GITHUB_CONFIG.BRANCH}`)
		const treeData = await createTree(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, treeItems, refData.sha)
		const commitData = await createCommit(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `feat: 同步 LeetCode 题解 (${synced.length} 道)`, treeData.sha, [refData.sha])
		await updateRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `heads/${GITHUB_CONFIG.BRANCH}`, commitData.sha)

		return NextResponse.json({ ok: true, synced: synced.length, titles: synced.map(s => s.title) })
	} catch (err: any) {
		return NextResponse.json({ error: err.message }, { status: 500 })
	}
}
