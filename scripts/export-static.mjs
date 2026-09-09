import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const sourceRoot = resolve(process.cwd());
const destination = resolve(process.argv[2] || '');
const basePath = process.env.REDACT_PDF_BASE_PATH || '/redact-pdf/';
const canonicalUrl = process.env.REDACT_PDF_CANONICAL_URL || 'https://aisetuk.com/redact-pdf';
const port = Number(process.env.REDACT_PDF_EXPORT_PORT || 8793);

if (!destination || basename(destination) !== 'redact-pdf') {
  throw new Error('Pass the exact destination directory ending in "redact-pdf".');
}
if (destination === sourceRoot || destination.startsWith(`${sourceRoot}${sep}`)) {
  throw new Error('The destination must be outside the source project root.');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function waitForHtml(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for the rendered page: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function stopProcessTree(process) {
  if (process.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(process.pid), '/t', '/f'], { stdio: 'ignore' });
  else process.kill('SIGTERM');
}

const buildEnvironment = { ...process.env, REDACT_PDF_BASE_PATH: basePath, REDACT_PDF_CANONICAL_URL: canonicalUrl };
const npmCommand = process.platform === 'win32'
  ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm'] }
  : { command: 'npm', args: [] };

execFileSync(npmCommand.command, [...npmCommand.args, 'run', 'build'], { cwd: sourceRoot, env: buildEnvironment, stdio: 'inherit' });

const server = spawn(npmCommand.command, [...npmCommand.args, 'run', 'start', '--', '--port', String(port)], {
  cwd: sourceRoot,
  env: { ...buildEnvironment, WRANGLER_WRITE_LOGS: 'false' },
  stdio: 'ignore',
});

let html;
try {
  html = await waitForHtml(`http://127.0.0.1:${port}/`);
} finally {
  stopProcessTree(server);
}

if (!html.includes('<header') || html.includes('body > main > header { display: none')) {
  throw new Error('The exported page must contain the original visible app header.');
}
if (!html.includes(`${basePath}_next/`)) {
  throw new Error(`The rendered page did not use the requested base path ${basePath}.`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(sourceRoot, 'dist', 'client'), destination, { recursive: true });
await writeFile(join(destination, 'index.html'), html, 'utf8');

const sourceCommit = execFileSync('git', ['-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'], {
  cwd: sourceRoot,
  encoding: 'utf8',
}).trim();
const digest = createHash('sha256');
for (const file of (await listFiles(destination)).sort()) {
  const relativePath = relative(destination, file).replaceAll('\\', '/');
  digest.update(`${relativePath}\0${sha256(await readFile(file))}\n`);
}
await writeFile(join(destination, 'release.json'), `${JSON.stringify({
  sourceCommit,
  builtAt: new Date().toISOString(),
  basePath,
  canonicalUrl,
  runtimeSha256: digest.digest('hex'),
}, null, 2)}\n`, 'utf8');

console.log(`Exported ${await stat(join(destination, 'index.html')).then((entry) => entry.size)} bytes of HTML to ${destination}`);
