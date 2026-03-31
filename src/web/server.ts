import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageQueue } from './message-queue.js';
import { log } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class WebServer {
  private server: Server;
  private messageQueue: MessageQueue;
  private port: number;
  private htmlContent: string;

  constructor(port: number, messageQueue: MessageQueue) {
    this.port = port;
    this.messageQueue = messageQueue;
    try {
      this.htmlContent = readFileSync(join(__dirname, 'chat.html'), 'utf-8');
    } catch (err) {
      log.error('Failed to read chat.html:', err);
      this.htmlContent = '<html><body>Error loading chat page</body></html>';
    }
    this.server = createServer(this.handleRequest.bind(this));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        log.info(`Web调试通道已启动: http://localhost:${this.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        log.error('Web服务器启动失败:', err);
        reject(err);
      });
    });
  }

  stop(): void {
    this.server.close();
    log.info('Web服务器已停止');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      this.serveChatPage(req, res, url);
    } else if (path === '/api/messages') {
      await this.handleMessages(req, res, url);
    } else if (path === '/api/events') {
      this.handleSSE(req, res, url);
    } else {
      this.sendError(res, 404, 'Not Found');
    }
  }

  private serveChatPage(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(this.htmlContent);
  }

  private async handleMessages(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET') {
      const messages = this.messageQueue.getMessages();
      this.sendJSON(res, { messages });
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const content = data.content;

          if (!content) {
            this.sendError(res, 400, 'content is required');
            return;
          }

          this.messageQueue.addOutboundMessage(content);
          this.sendJSON(res, { success: true });
        } catch (err) {
          log.error('Failed to parse message:', err);
          this.sendError(res, 400, 'Invalid JSON');
        }
      });
    } else {
      this.sendError(res, 405, 'Method Not Allowed');
    }
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const unsubscribe = this.messageQueue.subscribe((msg) => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });

    const existingMessages = this.messageQueue.getMessages();
    existingMessages.forEach(msg => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  }

  private sendJSON(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}
