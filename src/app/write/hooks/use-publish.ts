import { useCallback } from 'react'
import { readFileAsText } from '@/lib/file-utils'
import { toast } from 'sonner'
import { pushBlog } from '../services/push-blog'
import { deleteBlog } from '../services/delete-blog'
import { useWriteStore } from '../stores/write-store'
import { useAuthStore } from '@/hooks/use-auth'

const isDev = process.env.NODE_ENV === 'development'

export function usePublish() {
	const { loading, setLoading, form, cover, images, mode, originalSlug } = useWriteStore()
	const { isAuth, setPrivateKey } = useAuthStore()

	const onChoosePrivateKey = useCallback(
		async (file: File) => {
			const pem = await readFileAsText(file)
			setPrivateKey(pem)
		},
		[setPrivateKey]
	)

	const onPublish = useCallback(async () => {
		try {
			setLoading(true)

			if (isDev) {
				// 开发环境：直接写本地文件
				const res = await fetch('/api/local-save', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						slug: form.slug,
						title: form.title,
						md: form.md,
						tags: form.tags,
						date: form.date,
						summary: form.summary,
						cover: cover?.type === 'url' ? cover.url : '',
						hidden: form.hidden,
						category: form.category
					})
				})
				const data = await res.json()
				if (!res.ok) throw new Error(data.error)
				toast.success('已保存到本地，浏览器刷新即可预览')
			} else {
				await pushBlog({ form, cover, images, mode, originalSlug })
				const successMsg = mode === 'edit' ? '更新成功' : '发布成功'
				toast.success(successMsg)
			}
		} catch (err: any) {
			console.error(err)
			toast.error(err?.message || '操作失败')
		} finally {
			setLoading(false)
		}
	}, [form, cover, images, mode, originalSlug, setLoading])

	const onDelete = useCallback(async () => {
		const targetSlug = originalSlug || form.slug
		if (!targetSlug) {
			toast.error('缺少 slug，无法删除')
			return
		}
		try {
			setLoading(true)
			await deleteBlog(targetSlug)
		} catch (err: any) {
			console.error(err)
			toast.error(err?.message || '删除失败')
		} finally {
			setLoading(false)
		}
	}, [form.slug, originalSlug, setLoading])

	return {
		isAuth,
		isDev,
		loading,
		onChoosePrivateKey,
		onPublish,
		onDelete
	}
}
