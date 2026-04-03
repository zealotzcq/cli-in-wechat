import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionsDir } from '../config.js';
import { DEFAULT_SETTINGS, type UserSettings } from '../adapters/base.js';

export class SessionManager {
  private data = new Map<string, UserSettings>();

  constructor() {
    this.load();
  }

  get(userId: string): UserSettings {
    let s = this.data.get(userId);
    if (!s) {
      s = { ...DEFAULT_SETTINGS, sessionIds: {} };
      this.data.set(userId, s);
    }
    // Return the stored object directly to ensure sessionIds is always up-to-date
    // Callers should not modify the returned object directly - use update() instead
    return s;
  }

  update(userId: string, partial: Partial<UserSettings>): UserSettings {
    const s = this.get(userId);
    Object.assign(s, partial);
    this.save();
    return s;
  }

  setSession(userId: string, tool: string, sessionId: string): void {
    const s = this.get(userId);
    s.sessionIds[tool] = sessionId;
    this.save();
  }

  clearSession(userId: string, tool?: string): void {
    const s = this.get(userId);
    if (tool) {
      delete s.sessionIds[tool];
    } else {
      s.sessionIds = {};
    }
    this.save();
  }

  setCurrentProject(userId: string, projectDir: string): void {
    const s = this.get(userId);
    s.currentProject = projectDir;
    this.save();
  }

  getCurrentProject(userId: string): string {
    const s = this.get(userId);
    return s.currentProject || '';
  }

  private filePath(): string {
    return join(getSessionsDir(), 'sessions.json');
  }

  private load(): void {
    const p = this.filePath();
    if (!existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      for (const [key, val] of Object.entries(raw)) {
        this.data.set(key, { ...DEFAULT_SETTINGS, sessionIds: {}, ...(val as object) });
      }
    } catch { /* start fresh */ }
  }

  private save(): void {
    const out: Record<string, UserSettings> = {};
    for (const [k, v] of this.data) out[k] = v;
    try {
      writeFileSync(this.filePath(), JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch { /* ignore */ }
  }
}
