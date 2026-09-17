// Static server for demo/ with no dependencies. Used by the Playwright config.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../demo/', import.meta.url))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const port = Number(process.env.PORT ?? 4817)

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const file = join(root, normalize(path === '/' ? 'index.html' : path))
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, () => console.log(`demo at http://localhost:${port}`))
