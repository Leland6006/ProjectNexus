import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
const realmTemplatePath = resolve(root, 'config/keycloak/nexus-realm.template.json')
const realmImportDir = resolve(root, '.dev/keycloak/import')
const realmImportPath = resolve(realmImportDir, 'nexus-dev-realm.json')
const args = process.argv.slice(2)
const action = args[0] ?? 'help'

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function parseEnv(text) {
  const result = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) result.set(match[1], match[2].replace(/^(["'])(.*)\1$/, '$2'))
  }
  return result
}

async function readLocalEnv() {
  return parseEnv(await readFile(envPath, 'utf8'))
}

async function writeRealmImport(env) {
  const template = await readFile(realmTemplatePath, 'utf8')
  const realm = JSON.parse(template)
  const secret = env.get('OIDC_CLIENT_SECRET')
  if (!secret || secret.startsWith('REPLACE_WITH'))
    throw new Error('OIDC_CLIENT_SECRET is missing; run setup first')
  realm.clients[0].secret = secret
  await mkdir(realmImportDir, { recursive: true })
  await writeFile(realmImportPath, `${JSON.stringify(realm, null, 2)}\n`, { mode: 0o600 })
}

async function setup() {
  let env
  try {
    env = await readLocalEnv()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(envPath, await readFile(resolve(root, '.env.example'), 'utf8'), {
      flag: 'wx',
      mode: 0o600
    })
    env = await readLocalEnv()
  }
  const defaults = {
    POSTGRES_DB: 'nexus',
    POSTGRES_USER: 'nexus',
    KEYCLOAK_ADMIN: 'admin'
  }
  for (const [key, value] of Object.entries(defaults)) if (!env.get(key)) env.set(key, value)
  const secretFields = {
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    KEYCLOAK_ADMIN_PASSWORD: generatedSecret(32),
    OIDC_CLIENT_SECRET: generatedSecret(32),
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64')
  }
  for (const [key, value] of Object.entries(secretFields)) {
    if (!env.get(key) || env.get(key).startsWith('REPLACE_WITH')) env.set(key, value)
  }
  const connectionUrl = `postgresql://${env.get('POSTGRES_USER')}:${encodeURIComponent(env.get('POSTGRES_PASSWORD'))}@127.0.0.1:5432/${env.get('POSTGRES_DB')}`
  if (!env.get('DATABASE_URL') || env.get('DATABASE_URL').startsWith('REPLACE_WITH'))
    env.set('DATABASE_URL', connectionUrl)
  const fixed = {
    API_PUBLIC_URL: 'http://127.0.0.1:4318',
    NEXUS_API_URL: 'http://127.0.0.1:4318',
    OIDC_ISSUER: 'http://127.0.0.1:8080/realms/nexus-dev',
    OIDC_ACCOUNT_URL: 'http://127.0.0.1:8080/realms/nexus-dev/account',
    OIDC_CLIENT_ID: 'nexus-api',
    HOST: '127.0.0.1',
    PORT: '4318',
    NODE_ENV: 'development'
  }
  for (const [key, value] of Object.entries(fixed)) env.set(key, value)
  const example = parseEnv(await readFile(resolve(root, '.env.example'), 'utf8'))
  for (const [key, value] of example) if (!env.has(key)) env.set(key, value)
  const lines = [...env].map(([key, value]) => `${key}=${value}`)
  await writeFile(envPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  await writeRealmImport(env)
  console.info('Created local .env and Keycloak realm import. Keep both out of version control.')
}

async function run(command, commandArgs) {
  const executable = command === 'node' ? process.execPath : command
  const child = spawn(executable, commandArgs, { cwd: root, stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  child.on('error', (error) => {
    console.error(`Could not start ${command}: ${error.message}`)
    process.exitCode = 1
  })
}

if (action === 'setup') {
  await setup()
} else if (action === 'services') {
  await setup()
  await run('docker', ['compose', 'up', '-d', 'postgres', 'mailpit', 'keycloak'])
} else if (action === 'api') {
  try {
    await readLocalEnv()
  } catch {
    console.error('Missing .env. Run `node scripts/dev-services.mjs setup` first.')
    process.exitCode = 1
  }
  if (!process.exitCode)
    await run('node', ['--env-file=.env', '--experimental-strip-types', 'server/index.ts'])
} else if (action === 'app') {
  await setup()
  await run('node', ['--env-file=.env', './node_modules/electron-vite/bin/electron-vite.js', 'dev'])
} else {
  console.info(`Project Nexus local development

  node scripts/dev-services.mjs setup     Generate local-only .env secrets and realm import
  node scripts/dev-services.mjs services  Start PostgreSQL, Keycloak and Mailpit with Docker Compose
  node scripts/dev-services.mjs api       Run the API locally with Node --env-file
  node scripts/dev-services.mjs app       Run the Electron development app with .env`)
}
