export function htmlToMarkdown(html: string): string {
	if (!html) return ''
	let md = html
	md = md.replace(/<strong>(.*?)<\/strong>/g, '**$1**')
	md = md.replace(/<b>(.*?)<\/b>/g, '**$1**')
	md = md.replace(/<em>(.*?)<\/em>/g, '*$1*')
	md = md.replace(/<pre>([\s\S]*?)<\/pre>/g, (_, code) => {
		const cleaned = code.replace(/<[^>]+>/g, '').trim()
		return `\n\`\`\`\n${cleaned}\n\`\`\`\n`
	})
	md = md.replace(/<code>(.*?)<\/code>/g, '`$1`')
	md = md.replace(/<ul>([\s\S]*?)<\/ul>/g, (_, items) => {
		return items.replace(/<li>([\s\S]*?)<\/li>/g, '- $1\n').replace(/<[^>]+>/g, '')
	})
	md = md.replace(/<ol>([\s\S]*?)<\/ol>/g, (_match: string, items: string) => {
		let i = 0
		return items.replace(/<li>([\s\S]*?)<\/li>/g, (_m: string, c: string) => {
			i++
			return `${i}. ${c.replace(/<[^>]+>/g, '')}\n`
		})
	})
	md = md.replace(/<strong>输入[：:]\s*<\/strong>/g, '**输入：**\n')
	md = md.replace(/<strong>输出[：:]\s*<\/strong>/g, '**输出：**\n')
	md = md.replace(/<strong>解释[：:]\s*<\/strong>/g, '**解释：**\n')
	md = md.replace(/<strong>提示[：:]\s*<\/strong>/g, '**提示：**\n')
	md = md.replace(/<a href="(.*?)".*?>(.*?)<\/a>/g, '[$2]($1)')
	md = md.replace(/<p>([\s\S]*?)<\/p>/g, '$1\n\n')
	md = md.replace(/<br\s*\/?>/g, '\n')
	md = md.replace(/<img src="(.*?)".*?\/?>/g, '![]($1)')
	md = md.replace(/<sup>(.*?)<\/sup>/g, '^$1')
	md = md.replace(/<sub>(.*?)<\/sub>/g, '~$1')
	md = md.replace(/<[^>]+>/g, '')
	md = md.replace(/&nbsp;/g, ' ')
	md = md.replace(/&lt;/g, '<')
	md = md.replace(/&gt;/g, '>')
	md = md.replace(/&amp;/g, '&')
	md = md.replace(/&quot;/g, '"')
	md = md.replace(/&#39;/g, "'")
	md = md.replace(/\n{3,}/g, '\n\n')
	return md.trim()
}

export function leetcodeSlug(title: string): string {
	return `leetcode-${title.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '')}`
}
