export interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  timestamp: number;
}

export class MessageQueue {
  private messages: ChatMessage[] = [];
  private pendingRequest: { resolve: (text: string) => void; reject: () => void; timeout: NodeJS.Timeout } | null = null;
  private listeners: Set<(msg: ChatMessage) => void> = new Set();

  addInboundMessage(content: string): string {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const message: ChatMessage = {
      id,
      direction: 'inbound',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(message);
    this.notifyListeners(message);
    return id;
  }

  addOutboundMessage(content: string): void {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const message: ChatMessage = {
      id,
      direction: 'outbound',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(message);
    this.notifyListeners(message);

    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timeout);
      this.pendingRequest.resolve(content);
      this.pendingRequest = null;
    }
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  waitForReply(timeoutMs: number = 300_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequest = null;
        reject(new Error('等待网页回复超时'));
      }, timeoutMs);

      this.pendingRequest = { resolve, reject, timeout };
    });
  }

  subscribe(callback: (msg: ChatMessage) => void): () => void {
    this.listeners.add(callback);

    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners(message: ChatMessage): void {
    this.listeners.forEach(cb => cb(message));
  }

  clearMessages(): void {
    this.messages = [];
  }
}
