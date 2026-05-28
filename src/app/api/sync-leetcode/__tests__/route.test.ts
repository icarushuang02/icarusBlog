import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, leetcodeSlug } from '@/lib/leetcode-utils'

describe('htmlToMarkdown', () => {
	it('returns empty string for empty input', () => {
		expect(htmlToMarkdown('')).toBe('')
	})

	it('converts bold tags', () => {
		expect(htmlToMarkdown('<strong>hello</strong>')).toBe('**hello**')
		expect(htmlToMarkdown('<b>hello</b>')).toBe('**hello**')
	})

	it('converts italic tags', () => {
		expect(htmlToMarkdown('<em>hello</em>')).toBe('*hello*')
	})

	it('converts inline code', () => {
		expect(htmlToMarkdown('<code>var x = 1</code>')).toBe('`var x = 1`')
	})

	it('converts pre blocks to fenced code blocks', () => {
		const input = '<pre>function hello() {\n  return "world"\n}</pre>'
		const result = htmlToMarkdown(input)
		expect(result).toContain('```')
		expect(result).toContain('function hello()')
		expect(result).toContain('return "world"')
	})

	it('converts pre blocks with inner code tags', () => {
		const input = '<pre><code>const x = 1</code></pre>'
		const result = htmlToMarkdown(input)
		expect(result).toContain('```')
		expect(result).toContain('const x = 1')
	})

	it('converts unordered lists', () => {
		const input = '<ul><li>item 1</li><li>item 2</li></ul>'
		const result = htmlToMarkdown(input)
		expect(result).toContain('- item 1')
		expect(result).toContain('- item 2')
	})

	it('converts ordered lists', () => {
		const input = '<ol><li>first</li><li>second</li></ol>'
		const result = htmlToMarkdown(input)
		expect(result).toContain('1. first')
		expect(result).toContain('2. second')
	})

	it('converts links', () => {
		expect(htmlToMarkdown('<a href="https://example.com">click</a>')).toBe('[click](https://example.com)')
	})

	it('converts paragraphs', () => {
		const result = htmlToMarkdown('<p>hello</p><p>world</p>')
		expect(result).toContain('hello')
		expect(result).toContain('world')
	})

	it('converts br tags', () => {
		expect(htmlToMarkdown('line1<br>line2')).toBe('line1\nline2')
		expect(htmlToMarkdown('line1<br/>line2')).toBe('line1\nline2')
	})

	it('converts img tags', () => {
		expect(htmlToMarkdown('<img src="https://example.com/img.png"/>')).toBe('![](https://example.com/img.png)')
	})

	it('converts sup and sub', () => {
		expect(htmlToMarkdown('<sup>2</sup>')).toBe('^2')
		expect(htmlToMarkdown('<sub>2</sub>')).toBe('~2')
	})

	it('decodes HTML entities', () => {
		expect(htmlToMarkdown('&amp;')).toBe('&')
		expect(htmlToMarkdown('&lt;')).toBe('<')
		expect(htmlToMarkdown('&gt;')).toBe('>')
		expect(htmlToMarkdown('&quot;')).toBe('"')
		expect(htmlToMarkdown('&#39;')).toBe("'")
		expect(htmlToMarkdown('a&nbsp;b')).toBe('a b')
	})

	it('converts LeetCode-style input/output labels', () => {
		expect(htmlToMarkdown('<strong>输入：</strong>')).toBe('**输入：**')
		expect(htmlToMarkdown('<strong>输出：</strong>')).toBe('**输出：**')
		expect(htmlToMarkdown('<strong>解释：</strong>')).toBe('**解释：**')
		expect(htmlToMarkdown('<strong>提示：</strong>')).toBe('**提示：**')
	})

	it('collapses multiple newlines', () => {
		expect(htmlToMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb')
	})

	it('handles complex LeetCode problem HTML', () => {
		const input = `<p>给你一个整数数组 <code>nums</code> 和一个整数 <code>target</code>。</p>
<p><strong>输入：</strong>nums = [2,7,11,15], target = 9</p>
<p><strong>输出：</strong>[0,1]</p>
<p><strong>解释：</strong>因为 nums[0] + nums[1] == 9 ，返回 [0, 1] 。</p>`
		const result = htmlToMarkdown(input)
		expect(result).toContain('`nums`')
		expect(result).toContain('`target`')
		expect(result).toContain('**输入：**')
		expect(result).toContain('**输出：**')
		expect(result).toContain('**解释：**')
	})

	it('strips unknown tags', () => {
		expect(htmlToMarkdown('<div class="test">hello</div>')).toBe('hello')
		expect(htmlToMarkdown('<span>world</span>')).toBe('world')
	})
})

describe('leetcodeSlug', () => {
	it('generates correct slug for English title', () => {
		expect(leetcodeSlug('Two Sum')).toBe('leetcode-two-sum')
	})

	it('generates correct slug for Chinese title', () => {
		expect(leetcodeSlug('两数之和')).toBe('leetcode-两数之和')
	})

	it('generates correct slug for mixed title', () => {
		expect(leetcodeSlug('Best Time to Buy and Sell Stock')).toBe('leetcode-best-time-to-buy-and-sell-stock')
	})

	it('handles special characters', () => {
		expect(leetcodeSlug('Longest Palindromic Substring')).toBe('leetcode-longest-palindromic-substring')
	})

	it('trims leading/trailing dashes', () => {
		expect(leetcodeSlug(' Hello World ')).toBe('leetcode-hello-world')
	})
})
