import { NextResponse, type NextRequest } from 'next/server'
import { toBase64Utf8, getRef, createTree, createCommit, updateRef, createBlob, readTextFileFromRepo, type TreeItem } from '@/lib/server-github'
import { htmlToMarkdown } from '@/lib/leetcode-utils'
import { GITHUB_CONFIG } from '@/consts'

const LEETCODE_API = 'https://leetcode.cn/graphql/'
const DEFAULT_TAGS = ['LeetCode', '算法']
const MAX_PAGES = 50

// 用 titleSlug 生成 slug，和 sync.js 保持一致
function leetcodeSlugFromTitleSlug(titleSlug: string): string {
	return `leetcode-${titleSlug}`
}

function getLeetcodeHeaders(cookie: string) {
	const csrf = cookie.match(/csrftoken=([^;]+)/)?.[1] || ''
	return {
		'Content-Type': 'application/json',
		Cookie: cookie,
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
		Referer: 'https://leetcode.cn',
		'x-csrftoken': csrf
	}
}

async function lcGql(cookie: string, query: string, variables: Record<string, any> = {}) {
	const res = await fetch(LEETCODE_API, {
		method: 'POST',
		headers: getLeetcodeHeaders(cookie),
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
		// 从请求头读取凭证
		const token = request.headers.get('x-github-token')
		if (!token) {
			return NextResponse.json({ error: '缺少 GitHub Token，请先导入密钥' }, { status: 401 })
		}

		const cookie = request.headers.get('x-leetcode-cookie')
		if (!cookie) {
			return NextResponse.json({ error: '缺少 LeetCode Cookie，请先导入' }, { status: 401 })
		}

		// 1. 获取所有 AC 提交
		let allSubmissions: any[] = []
		let offset = 0
		let hasNext = true
		let pageCount = 0
		while (hasNext && pageCount < MAX_PAGES) {
			const data = await lcGql(cookie, `
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
		let existingIndex: any[] = []
		try {
			const txt = await readTextFileFromRepo(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, 'public/blogs/index.json', GITHUB_CONFIG.BRANCH)
			if (txt) existingIndex = JSON.parse(txt)
		} catch {}
		const existingSlugs = new Set(existingIndex.map((e: any) => e.slug))

		// 4. 先获取详情拿 titleSlug，再过滤已存在的
		const allSubs = Array.from(problemMap.values())
		const toFetch: { title: string; sub: any }[] = []

		// 先批量获取详情（5个一组）
		const detailResults: any[] = []
		let di = 0
		async function detailWorker() {
			while (di < allSubs.length) {
				const idx = di++
				try {
					const detail = await lcGql(cookie, `
						query ($id: ID!) {
							submissionDetail(submissionId: $id) {
								code statusDisplay lang
								question {
									questionFrontendId titleSlug translatedTitle translatedContent
									difficulty topicTags { name }
								}
							}
						}
					`, { id: allSubs[idx].id })
					detailResults[idx] = { sub: allSubs[idx], detail: detail.submissionDetail }
				} catch (err: any) {
					detailResults[idx] = { sub: allSubs[idx], error: err.message }
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(5, allSubs.length) }, () => detailWorker()))

		// 用 titleSlug 过滤已存在的
		for (const r of detailResults) {
			if (r.error) continue
			const slug = leetcodeSlugFromTitleSlug(r.detail.question.titleSlug)
			if (!existingSlugs.has(slug)) {
				toFetch.push({ title: r.sub.title, sub: r.sub })
			}
		}

		if (toFetch.length === 0) {
			return NextResponse.json({ ok: true, synced: 0, message: '没有新题目需要同步' })
		}

		// 5. 用已获取的详情生成文件
		const synced: { slug: string; title: string; tags: string[]; date: string; summary: string }[] = []

		// 6. 构建 tree items
		const treeItems: TreeItem[] = []

		// 从 detailResults 中找出需要同步的（已过滤已存在的）
		const toSyncSet = new Set(toFetch.map(t => t.sub.id))

		for (const r of detailResults) {
			if (r.error) continue
			if (!toSyncSet.has(r.sub.id)) continue

			const detail = r.detail
			const slug = leetcodeSlugFromTitleSlug(detail.question.titleSlug)
			const q = detail.question
			const id = q.questionFrontendId
			const title = q.translatedTitle || q.title
			const tags = [...DEFAULT_TAGS, ...q.topicTags.map((t: any) => t.name).slice(0, 3)]
			const date = r.sub.timestamp ? new Date(r.sub.timestamp * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
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

		// 7. 更新 index.json，按算法分类
		const categoryMap: Record<string, string> = {
			'Array': '数组',
			'Hash Table': '哈希表',
			'Two Pointers': '双指针',
			'Sliding Window': '滑动窗口',
			'Binary Search': '二分查找',
			'String': '字符串',
			'Linked List': '链表',
			'Stack': '栈',
			'Queue': '队列',
			'Heap': '堆',
			'Tree': '树',
			'Graph': '图',
			'Dynamic Programming': '动态规划',
			'Greedy': '贪心',
			'Backtracking': '回溯',
			'Divide and Conquer': '分治',
			'Sorting': '排序',
			'Bit Manipulation': '位运算',
			'Math': '数学',
			'Recursion': '递归',
			'Design': '设计',
			'Trie': '字典树',
			'Union Find': '并查集',
			'Prefix Sum': '前缀和',
			'Counting': '计数',
			'Matrix': '矩阵',
			'Simulation': '模拟',
			'Enumeration': '枚举',
			'Geometry': '几何',
			'Monotonic Stack': '单调栈',
		}

		for (const item of synced) {
			// 根据 tags 确定分类：取第一个非 LeetCode/算法的 tag 对应的中文分类
			const algorithmTag = item.tags.find(t => t !== 'LeetCode' && t !== '算法')
			const category = algorithmTag ? (categoryMap[algorithmTag] || '其他') : '其他'

			const entry = { slug: item.slug, title: item.title, tags: item.tags, date: `${item.date}T00:00`, summary: item.summary, cover: '', hidden: false, category }
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

		const failures = detailResults.filter((r: any) => r.error).map((r: any) => ({ title: r.sub?.title, error: r.error }))

		return NextResponse.json({
			ok: true,
			synced: synced.length,
			titles: synced.map(s => s.title),
			...(failures.length > 0 ? { failures } : {})
		})
	} catch (err: any) {
		const message = String(err.message || '同步失败').replace(/Bearer\s+[^\s]+/g, 'Bearer ***').replace(/x-github-token[^\n]*/gi, 'x-github-token: ***')
		return NextResponse.json({ error: message }, { status: 500 })
	}
}
