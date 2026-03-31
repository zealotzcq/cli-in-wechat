import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import type { MessageQueue } from '../web/message-queue.js';

export class WebAdapter implements CLIAdapter {
  readonly name = 'web';
  readonly displayName = 'Web Debug';
  readonly command = 'web';
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    jsonOutput: false,
    sessionResume: false,
    modes: ['auto'],
    hasEffort: false,
    hasModel: false,
    hasSearch: false,
    hasBudget: false,
  };

  constructor(private messageQueue: MessageQueue) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts.timeout || 300_000;

    try {
      const reply = await this.messageQueue.waitForReply(timeoutMs);
      return { text: reply, error: false };
    } catch (err) {
      return { text: `错误: ${(err as Error).message}`, error: true };
    }
  }
}
