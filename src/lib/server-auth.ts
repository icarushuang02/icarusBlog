import { KJUR, KEYUTIL } from 'jsrsasign'

const GH_API = 'https://api.github.com'

function signAppJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'RS256', typ: 'JWT' }
	const payload = { iat: now - 60, exp: now + 8 * 60, iss: appId }
	const prv = KEYUTIL.getKey(privateKeyPem) as unknown as string
	return KJUR.jws.JWS.sign('RS256', JSON.stringify(header), JSON.stringify(payload), prv)
}

async function getInstallationId(jwt: string, owner: string, repo: string): Promise<number> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/installation`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (!res.ok) throw new Error(`installation lookup failed: ${res.status}`)
	const data = await res.json()
	return data.id
}

async function createInstallationToken(jwt: string, installationId: number): Promise<string> {
	const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (!res.ok) throw new Error(`create token failed: ${res.status}`)
	const data = await res.json()
	return data.token as string
}

export async function getServerAuthToken(owner: string, repo: string, appId: string): Promise<string> {
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
	if (!privateKey) throw new Error('GITHUB_APP_PRIVATE_KEY 环境变量未配置')

	const jwt = signAppJwt(appId, privateKey)
	const installationId = await getInstallationId(jwt, owner, repo)
	return createInstallationToken(jwt, installationId)
}
