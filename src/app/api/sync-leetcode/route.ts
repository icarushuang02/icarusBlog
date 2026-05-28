import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import path from 'path'

export async function POST() {
	return new Promise<NextResponse>((resolve) => {
		const scriptPath = path.join(process.cwd(), '..', 'leetcode-blog-sync', 'sync.js')

		exec(`node "${scriptPath}"`, { timeout: 300_000, cwd: path.join(process.cwd(), '..', 'leetcode-blog-sync') }, (error, stdout, stderr) => {
			if (error) {
				resolve(NextResponse.json({ ok: false, error: error.message, stdout, stderr }, { status: 500 }))
			} else {
				resolve(NextResponse.json({ ok: true, output: stdout }))
			}
		})
	})
}
