import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { spawnProc, setupAbort, setupTimeout, isSessionError } from './base.js';
import { existsSync } from 'node:fs';

export class CcbAdapter implements CLIAdapter {
  readonly name = 'ccb';
  readonly displayName = 'CCB';
  readonly command = 'ccb.exe';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
  };

  private readonly binPath = 'd:\\Program Files\\Git\\cmd\\ccb.exe';

  async isAvailable(): Promise<boolean> {
    return existsSync(this.binPath);
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return this.executeWithCLI(prompt, opts);
  }

  // ─── CLI execution (no AskUserQuestion) ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['-p', prompt, '--output-format', 'json'];

      switch (settings.mode) {
        case 'auto': args.push('--dangerously-skip-permissions'); break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
      }
      if (settings.effort) args.push('--effort', settings.effort);
      args.push('--max-turns', String(settings.maxTurns));
      if (settings.model) args.push('--model', settings.model);
      if (settings.maxBudget > 0) args.push('--max-budget-usd', String(settings.maxBudget));
      if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
      if (settings.disallowedTools) args.push('--disallowedTools', settings.disallowedTools);
      if (settings.systemPrompt) args.push('--append-system-prompt', settings.systemPrompt);
      if (settings.verbose) args.push('--verbose');
      if (settings.bare) args.push('--bare');
      if (settings.addDir) args.push('--add-dir', settings.addDir);
      if (settings.sessionName) args.push('--name', settings.sessionName);
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[ccb] effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode}`);
      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        try {
          const r = JSON.parse(stdout);
          const isErr = r.is_error || r.subtype !== 'success';
          const text = r.result || '(无输出)';
          resolve({ text, sessionId: r.session_id, duration: r.duration_ms, error: isErr, sessionExpired: isErr && !!sid && isSessionError(text) });
        } catch {
          const text = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(text) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
