import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.NODE_ENV === 'production' || process.defaultApp === false) {
  throw new Error('Demo mode is only available in an unpackaged development build')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn('electron-vite', ['dev'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', NEXUS_MODE: 'demo' },
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
child.on('error', (error) => {
  console.error(`Could not start the unpackaged demo: ${error.message}`)
  process.exitCode = 1
})
