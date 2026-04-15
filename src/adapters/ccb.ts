import { log, isDebugMode } from '../utils/logger.js';
import { writeFileSync } from 'node:fs';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, isSessionError } from './base.js';
import {
  detectAskUserQuestion,
  formatQuestionsForWeChat,
  parseUserAnswer,
  answersToToolResult,
  formatAnswersAsToolResultContent,
  extractSessionMetadata,
  buildSessionMessage,
  appendToSession,
} from '../utils/questionHandler.js';
import type { PendingQuestionInfo } from './base.js';

export class CcbAdapter implements CLIAdapter {
  readonly name = 'ccb';
  readonly displayName = 'CCB';
  readonly command = 'ccb';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings } = opts;

    // 执行 CLI 并获取完整输出（用于 AskUserQuestion 检测）
    let result = await this.executeWithCLI(prompt, opts);

    // 检测是否有待处理的 AskUserQuestion
    // 注意：stream-json 格式下 result.text 可能为空，需要从完整输出检测
    if (opts.askUser) {
      const pending = detectAskUserQuestion(result.streamOutput || result.text || '', result);

      if (pending) {
        log.debug(`[ccb] 检测到 AskUserQuestion: ${pending.toolUseId}`);
        log.debug(`[ccb] 调用 askUser 回调...`);
        // 使用 askUser 回调处理问题
        const answers = await opts.askUser({
          questions: pending.questions as Array<{
            question: string;
            options: Array<{ label: string; description?: string }>;
            multiSelect?: boolean;
          }>
        });
        log.debug(`[ccb] 收到用户回答: ${JSON.stringify(answers)}`);

        // 从 session 文件提取 promptId 等元数据
        const sid = pending.sessionId || result.sessionId || '';
        const wdir = pending.workDir || settings.workDir || opts.workDir || '';
        const meta = extractSessionMetadata(sid, wdir);

        // 构造人类可读的 tool_result content（参考 mapToolResultToToolResultBlockParam 格式）
        const toolResultContent = formatAnswersAsToolResultContent(answers);

        // 构造 session 消息
        const sessionMessage = buildSessionMessage({
          parentUuid: pending.parentMessageUuid,
          toolUseId: pending.toolUseId,
          toolResultContent,
          sessionId: sid,
          workDir: wdir,
          promptId: meta?.promptId || '',
        });

        log.debug(`[ccb] tool_result content: ${toolResultContent.substring(0, 200)}`);
        log.debug(`[ccb] parentMessageUuid: ${pending.parentMessageUuid}`);
        log.debug(`[ccb] promptId: ${meta?.promptId || '(empty)'}`);

        // 保存到调试文件
        if (isDebugMode()) {
          try {
            writeFileSync(process.cwd() + '/debug_session_message.json', JSON.stringify(JSON.parse(sessionMessage), null, 2), 'utf-8');
            log.debug(`[ccb] 已保存 session 消息到 debug_session_message.json`);
          } catch (e) {
            log.debug(`[ccb] 保存调试文件失败: ${(e as Error).message}`);
          }
        }

        // 追加到 session 文件（会截断 error tool_result 并追加正确结果）
        appendToSession(sid, wdir, pending.parentMessageUuid, sessionMessage);

        // Resume session with a non-empty prompt (empty string gets ignored by CCB)
        log.debug(`[ccb] resume session: ${pending.sessionId || result.sessionId}`);
        result = await this.executeWithCLI('继续', {
          ...opts,
          settings: {
            ...settings,
            sessionIds: {
              ...settings.sessionIds,
              [this.name]: pending.sessionId || result.sessionId || ''
            }
          }
        });
      }
    }

    return result;
  }

  // ─── CLI execution with AskUserQuestion support ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];

      switch (settings.mode) {
        case 'auto':
          // 不使用 --dangerously-skip-permissions，以便在流中暴露 tool_use 块
          break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
      }
      // stream-json requires --verbose
      args.push('--verbose');
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
      let streamOutput = '';
      let stderr = '';
      let sessionId = '';
      let finalText = '';
      let isError = false;
      let duration = 0;

      proc.stdout!.on('data', (c: Buffer) => {
        const chunk = c.toString();
        streamOutput += chunk;

        // Parse stream-json line by line
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Log all event types for debugging
            if (obj.type && !['message_start', 'message_delta', 'message_stop'].includes(obj.type)) {
              log.debug(`[ccb] 事件: ${obj.type}`);
            }
            // Log all content_block_start events for debugging
            if (obj.type === 'content_block_start') {
              log.debug(`[ccb] content_block_start: ${JSON.stringify(obj.content_block || {}).substring(0, 150)}`);
            }
            // Log for debugging
            if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
              log.debug(`[ccb] 检测到 tool_use: ${obj.content_block.name}`);
            }
            // Capture session_id and final result
            if (obj.session_id) sessionId = obj.session_id;
            if (obj.type === 'message_delta' && obj.message?.metadata?.duration_ms) {
              duration = obj.message.metadata.duration_ms;
            }
          } catch (e) {
            // Log JSON parse errors
            if (line.length > 0 && line.length < 200) {
              log.debug(`[ccb] JSON解析失败: ${line.substring(0, 100)}`);
            }
          }
        }
      });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        // Save full stream output to debug file
        if (isDebugMode()) {
          const debugPath = process.cwd() + '/debug_stream.jsonl';
          try {
            writeFileSync(debugPath, streamOutput, 'utf-8');
            log.debug(`[ccb] 已保存完整流输出到: ${debugPath}, 大小: ${streamOutput.length} 字节`);
          } catch (e) {
            log.debug(`[ccb] 保存调试文件失败: ${(e as Error).message}`);
          }
        }

        // Parse stream-json to extract final text result
        const lines = streamOutput.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Collect text from content_block_delta events
            if (obj.type === 'content_block_delta' && obj.delta?.type === 'text') {
              finalText += obj.delta.text || '';
            }
            // Collect text from assistant messages (CCB stream-json uses this format)
            if (obj.type === 'assistant' && obj.message?.content) {
              const content = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  finalText += block.text;
                }
              }
            }
            // Collect text from result message
            if (obj.type === 'result' && obj.result) {
              finalText = obj.result;
            }
            // Check for error
            if (obj.type === 'error' || obj.error) {
              isError = true;
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        log.debug(`[ccb] stream-json 解析完成: sessionId=${sessionId}, text长度=${finalText.length}, isError=${isError}`);

        if (!finalText) {
          // Fallback to raw output if parsing failed
          finalText = streamOutput.trim() || stderr.trim() || '(无输出)';
        }

        resolve({
          text: finalText,
          streamOutput, // Include raw stream for AskUserQuestion detection
          sessionId,
          duration,
          error: isError || code !== 0,
          sessionExpired: code !== 0 && !!sid && isSessionError(finalText)
        });
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
