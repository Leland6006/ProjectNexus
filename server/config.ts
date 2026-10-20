import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export interface ServerConfig {
  databaseUrl: string
  issuer: string
  clientId: string
  clientSecret: string
  publicUrl: string
  accountUrl: string
  encryptionKey: Buffer
  host: string
  port: number
  development: boolean
}

function endpoint(value: string, name: string, development: boolean): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' &&
    !(development && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error(`${name} must be HTTPS (loopback HTTP is development-only)`)
  }
  return url.toString().replace(/\/$/, '')
}

export function readConfig(env = process.env): ServerConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing server configuration: ${name}`)
    return value
  }
  const development = env.NODE_ENV === 'development'
  const encryptionKey = Buffer.from(required('SESSION_ENCRYPTION_KEY'), 'base64')
  if (encryptionKey.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64')
  const port = Number(env.PORT ?? 4318)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  const publicUrl = endpoint(required('API_PUBLIC_URL'), 'API_PUBLIC_URL', development)
  if (new URL(publicUrl).pathname !== '/') throw new Error('API_PUBLIC_URL must be an API root URL')
  return {
    databaseUrl: required('DATABASE_URL'),
    issuer: endpoint(required('OIDC_ISSUER'), 'OIDC_ISSUER', development),
    clientId: required('OIDC_CLIENT_ID'), clientSecret: required('OIDC_CLIENT_SECRET'),
    publicUrl,
    accountUrl: endpoint(required('OIDC_ACCOUNT_URL'), 'OIDC_ACCOUNT_URL', development),
    encryptionKey, host: env.HOST ?? '127.0.0.1', port, development
  }
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decrypt(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 28) throw new Error('Invalid encrypted value')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
