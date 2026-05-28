import { toBase64Utf8, getRef, createTree, createCommit, updateRef, createBlob, type TreeItem } from '@/lib/github-client'
import { fileToBase64NoPrefix, hashFileSHA256 } from '@/lib/file-utils'
import { prepareBlogsIndex } from '@/lib/blog-index'
import { getAuthToken } from '@/lib/auth'
import { GITHUB_CONFIG } from '@/consts'
import type { ImageItem } from '../types'
import { getFileExt } from '@/lib/utils'
import { toast } from 'sonner'
import { formatDateTimeLocal } from '../stores/write-store'

export type PushBlogParams = {
	form: {
		slug: string
		title: string
		md: string
		tags: string[]
		date?: string
		summary?: string
		hidden?: boolean
		category?: string
	}
	cover?: ImageItem | null
	images?: ImageItem[]
	mode?: 'create' | 'edit'
	originalSlug?: string | null
}

export async function pushBlog(params: PushBlogParams): Promise<void> {
	const { form, cover, images, mode = 'create', originalSlug } = params

	if (!form?.slug) throw new Error('需要 slug')

	if (mode === 'edit' && originalSlug && originalSlug !== form.slug) {
		throw new Error('编辑模式下不支持修改 slug，请保持原 slug 不变')
	}

	const token = await getAuthToken()

	toast.info('正在准备数据...')

	// 并行：获取 ref + 预读 index.json
	const [refData, indexJson] = await Promise.all([
		getRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `heads/${GITHUB_CONFIG.BRANCH}`),
		prepareBlogsIndex(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, {
			slug: form.slug,
			title: form.title,
			tags: form.tags,
			date: form.date || formatDateTimeLocal(),
			summary: form.summary,
			cover: cover?.type === 'url' ? cover.url : undefined,
			hidden: form.hidden,
			category: form.category
		}, GITHUB_CONFIG.BRANCH)
	])

	const latestCommitSha = refData.sha
	const basePath = `public/blogs/${form.slug}`
	const commitMessage = mode === 'edit' ? `更新文章: ${form.slug}` : `新增文章: ${form.slug}`

	// collect all local images
	const allLocalImages: Array<{ img: Extract<ImageItem, { type: 'file' }>; id: string }> = []
	for (const img of images || []) {
		if (img.type === 'file') allLocalImages.push({ img, id: img.id })
	}
	if (cover?.type === 'file') {
		allLocalImages.push({ img: cover, id: cover.id })
	}

	// 去重
	const uniqueImages: Array<{ img: Extract<ImageItem, { type: 'file' }>; filename: string; publicPath: string }> = []
	const seenHashes = new Set<string>()
	for (const { img } of allLocalImages) {
		const hash = img.hash || (await hashFileSHA256(img.file))
		const ext = getFileExt(img.file.name)
		const filename = `${hash}${ext}`
		if (!seenHashes.has(hash)) {
			seenHashes.add(hash)
			uniqueImages.push({ img, filename, publicPath: `/blogs/${form.slug}/${filename}` })
		}
	}

	// 并行：上传所有图片 blob + 创建内容 blob
	let coverPath: string | undefined
	if (cover?.type === 'url') coverPath = cover.url

	const treeItems: TreeItem[] = []

	if (uniqueImages.length > 0) {
		toast.info(`正在上传 ${uniqueImages.length} 张图片...`)
		const imageBlobs = await Promise.all(
			uniqueImages.map(async ({ img, filename }) => {
				const contentBase64 = await fileToBase64NoPrefix(img.file)
				const blobData = await createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, contentBase64, 'base64')
				return { img, filename, sha: blobData.sha }
			})
		)
		for (const { img, filename, sha } of imageBlobs) {
			treeItems.push({ path: `${basePath}/${filename}`, mode: '100644', type: 'blob', sha })
			if (cover?.type === 'file' && cover.id === img.id) {
				coverPath = `/blogs/${form.slug}/${filename}`
			}
		}
	}

	// 替换 markdown 中的图片占位符
	let mdToUpload = form.md
	for (const { img, publicPath } of uniqueImages) {
		mdToUpload = mdToUpload.split(`(local-image:${img.id})`).join(`(${publicPath})`)
	}

	// 如果 cover 是 file 类型，更新 indexJson 中的 cover
	let finalIndexJson = indexJson
	if (coverPath && cover?.type === 'file') {
		const indexArr = JSON.parse(indexJson)
		const entry = indexArr.find((e: any) => e.slug === form.slug)
		if (entry) entry.cover = coverPath
		finalIndexJson = JSON.stringify(indexArr, null, 2)
	}

	toast.info('正在创建文件...')

	// 并行：创建 md / config / index 三个 blob
	const dateStr = form.date || formatDateTimeLocal()
	const config = {
		title: form.title, tags: form.tags, date: dateStr,
		summary: form.summary, cover: coverPath,
		hidden: form.hidden, category: form.category
	}

	const [mdBlob, configBlob, indexBlob] = await Promise.all([
		createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(mdToUpload), 'base64'),
		createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(JSON.stringify(config, null, 2)), 'base64'),
		createBlob(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, toBase64Utf8(finalIndexJson), 'base64')
	])

	treeItems.push(
		{ path: `${basePath}/index.md`, mode: '100644', type: 'blob', sha: mdBlob.sha },
		{ path: `${basePath}/config.json`, mode: '100644', type: 'blob', sha: configBlob.sha },
		{ path: 'public/blogs/index.json', mode: '100644', type: 'blob', sha: indexBlob.sha }
	)

	// create tree → commit → update ref（带 422 重试）
	let currentParentSha = latestCommitSha
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			toast.info(attempt === 0 ? '正在提交...' : '正在重试提交...')
			const treeData = await createTree(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, treeItems, currentParentSha)
			const commitData = await createCommit(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, commitMessage, treeData.sha, [currentParentSha])
			await updateRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `heads/${GITHUB_CONFIG.BRANCH}`, commitData.sha)
			toast.success('发布成功！')
			return
		} catch (err: any) {
			if (err?.message?.includes('422') && attempt < 2) {
				// SHA 冲突，重新获取最新 ref
				const newRef = await getRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, `heads/${GITHUB_CONFIG.BRANCH}`)
				currentParentSha = newRef.sha
				continue
			}
			throw err
		}
	}
}
