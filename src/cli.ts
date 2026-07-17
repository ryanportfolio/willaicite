#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runAudit, VERSION } from './audit.js';
import { renderMarkdown, renderJson } from './report.js';

const USAGE = `geo-audit v${VERSION} — GEO (Generative Engine Optimization) audit

Usage:
  geo-audit <url> [--json] [--out <file>]
  geo-audit serve [--port <n>]

Options:
  --json        Emit machine-readable JSON instead of markdown
  --out <file>  Write the report to a file instead of stdout
  --port <n>    Port for the local web UI (default 4173)
  --help        Show this help
  --version     Show version
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`geo-audit v${VERSION}\n`);
    return 0;
  }

  if (args[0] === 'serve') {
    let port = 4173;
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1) {
      port = Number(args[portIdx + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write('error: --port requires a number 0-65535\n');
        return 2;
      }
    }
    const { startServer } = await import('./server.js');
    await startServer(port);
    return new Promise<number>(() => undefined); // run until killed
  }

  let url: string | null = null;
  let json = false;
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--out') {
      out = args[++i] ?? null;
      if (!out) {
        process.stderr.write('error: --out requires a file path\n');
        return 2;
      }
    } else if (arg.startsWith('-')) {
      process.stderr.write(`error: unknown option ${arg}\n\n${USAGE}`);
      return 2;
    } else if (url === null) {
      url = arg;
    } else {
      process.stderr.write(`error: unexpected argument ${arg}\n\n${USAGE}`);
      return 2;
    }
  }

  if (!url) {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    process.stderr.write(`error: invalid URL "${url}"\n`);
    return 2;
  }

  process.stderr.write(`Auditing ${url} …\n`);
  const result = await runAudit(url);
  const output = json ? renderJson(result) : renderMarkdown(result);

  if (out) {
    const dir = dirname(out);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(out, output, 'utf8');
    process.stderr.write(`Report written to ${out}\n`);
  } else {
    process.stdout.write(output + '\n');
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`geo-audit failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
