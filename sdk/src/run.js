/**
 * Child processes, with the output kept where a failure can use it.
 *
 * Provisioning runs pip for several minutes. Sending that to the terminal is
 * noise; discarding it makes a failure unreadable. So output is captured to a
 * bounded tail and the caller decides whether to show it.
 */

import { spawn } from 'node:child_process';

const TAIL_BYTES = 12_000;

function keep(tail, chunk) {
  return (tail + chunk).slice(-TAIL_BYTES);
}

export function run(command, args, options = {}) {
  const { cwd, env = process.env, timeoutMs = 0, onLine } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let timer = null;

    const show = (chunk) => {
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = keep(stdout, text);
      show(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = keep(stderr, text);
      show(text);
    });

    child.once('error', reject);

    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending.trim() && onLine) onLine(pending);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs a command that must succeed, and reports its last words when it does not. */
export async function runOrThrow(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code === 0) return result;
  const output = (result.stderr || result.stdout || '').trim();
  const last = output.split(/\r?\n/).slice(-12).join('\n');
  throw new Error(`${command} ${args.join(' ')} exited with ${result.code}${last ? `\n${last}` : ''}`);
}
