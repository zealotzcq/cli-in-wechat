import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../utils/logger.js';
import type { AskUserRequest } from '../adapters/base.js';

export interface PendingQuestion {
  toolUseId: string;
  parentMessageUuid: string;
  questions: AskUserRequest['questions'];
  sessionId: string;
  timestamp: string;
  workDir: string;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * 检测选项是否为自定义选项
 * UI 层面总是自动添加一个 "Other" 自定义选项
 * 选项在 JSON 中没有 custom 属性，而是通过位置判断（最后一个选项）
 */
function isCustomOption(option: { label: string; custom?: boolean }, index: number, totalOptions: number): boolean {
  return index === totalOptions - 1 && option.label.toLowerCase() === 'other';
}

/**
 * 检测 CLI 输出中是否包含未完成的 AskUserQuestion
 */
export function detectAskUserQuestion(output: string, cliResult: any): PendingQuestion | null {
  // 方式1: 检查 JSON 输出中的特殊标记
  if (cliResult.pending_permission) {
    // 某些 CLI 可能返回 pending_permission 标记
    return null; // 需要根据实际格式调整
  }

  // 方式2: 解析 stream-json 格式中的 assistant 消息（查找 message.content 中的 tool_use）
  const lines = output.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // 检查 assistant 消息中的 tool_use
      if (obj.type === 'assistant' && obj.message?.content) {
        const content = obj.message.content;
        const assistantUuid = obj.uuid || '';
        const contentArray = Array.isArray(content) ? content : [content];
        for (const item of contentArray) {
          if (item.type === 'tool_use' && item.name === 'AskUserQuestion') {
            log.debug(`[question] 在 stream-json 的 assistant 消息中检测到 AskUserQuestion`);
            log.debug(`[question] tool_use 块: ${JSON.stringify(item).substring(0, 200)}`);
            log.debug(`[question] assistant message UUID: ${assistantUuid}`);
            return {
              toolUseId: item.id || '',
              parentMessageUuid: assistantUuid,
              questions: item.input.questions as AskUserRequest['questions'],
              sessionId: cliResult.sessionId || cliResult.session_id || '',
              timestamp: new Date().toISOString(),
              workDir: cliResult.workDir || ''
            };
          }
        }
      }

      // 检查 permission_denials 中的 AskUserQuestion
      if (obj.permission_denials) {
        for (const denial of obj.permission_denials) {
          if (denial.tool_name === 'AskUserQuestion') {
            log.debug(`[question] 在 permission_denials 中检测到 AskUserQuestion`);
            log.debug(`[question] tool_use 块: ${JSON.stringify(denial).substring(0, 200)}`);
            return {
              toolUseId: denial.tool_use_id || '',
              parentMessageUuid: '',
              questions: denial.tool_input.questions as AskUserRequest['questions'],
              sessionId: cliResult.sessionId || cliResult.session_id || '',
              timestamp: new Date().toISOString(),
              workDir: cliResult.workDir || ''
            };
          }
        }
      }
    } catch (e) {
      // Skip non-JSON lines
    }
  }

  // 方式3: 解析 output 中的 tool_use 块（备用，用于普通 JSON 格式）
  const toolUseMatch = output.match(/"type":\s*"tool_use".*?"name":\s*"AskUserQuestion"/s);
  if (toolUseMatch && toolUseMatch.index !== undefined) {
    try {
      // 尝试提取完整的 tool_use 块
      const toolUse = extractToolUseBlock(output, toolUseMatch.index);
      if (toolUse) {
        log.debug(`[question] 解析到 tool_use 块: ${JSON.stringify(toolUse)}`);
        log.debug(`[question] 完整输出长度: ${output.length} 字符`);
        return {
          toolUseId: toolUse.id,
          parentMessageUuid: '',
          questions: toolUse.input.questions as AskUserRequest['questions'],
          sessionId: cliResult.sessionId || cliResult.session_id || '',
          timestamp: new Date().toISOString(),
          workDir: cliResult.workDir || ''
        };
      }
    } catch (err) {
      // 解析失败，输出日志调试
      log.debug(`[question] 解析 tool_use 失败: ${(err as Error).message}`);
      log.debug(`[question] 输出片段: ${output.substring(toolUseMatch.index, toolUseMatch.index + 500)}`);
    }
  }

  log.debug(`[question] 未能检测到 AskUserQuestion，输出长度: ${output.length}`);
  // 只输出前500字符避免日志过大
  log.debug(`[question] 输出预览: ${output.substring(0, 500)}`);
  return null;
}

/**
 * 从输出中提取 tool_use 块
 */
function extractToolUseBlock(output: string, startIndex: number): ToolUseBlock | null {
  // 找到 tool_use 块的开始和结束
  const start = output.lastIndexOf('"type": "tool_use"', startIndex);
  if (start === -1) return null;

  log.debug(`[question] 开始位置: ${start}`);

  // 找到匹配的结束括号
  let braceCount = 0;
  let inString = false;
  let escape = false;
  let end = start;

  for (let i = start; i < output.length; i++) {
    const c = output[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (c === '\\') {
      escape = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (c === '{') braceCount++;
      else if (c === '}') {
        braceCount--;
        if (braceCount === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  if (end <= start) return null;

  try {
    const blockStr = output.substring(start, end);
    // 添加缺失的开始括号
    const fullBlock = '{' + blockStr;
    const parsed = JSON.parse(fullBlock);

    log.debug(`[question] 解析结果: ${JSON.stringify(parsed, null, 2)}`);

    if (parsed.name === 'AskUserQuestion' && parsed.input?.questions) {
      // 输出每个选项
      if (parsed.input.questions) {
        for (const q of parsed.input.questions) {
          if (q.options) {
            log.debug(`[question] 问题: ${q.question}`);
            for (let i = 0; i < q.options.length; i++) {
              const opt = q.options[i];
              log.debug(`[question]   选项${i + 1}: label="${opt.label}"`);
            }
            log.debug(`[question]   自动添加自定义选项: index=${q.options.length + 1}`);
          }
        }
      }

      return {
        id: parsed.id || randomUUID(),
        name: parsed.name,
        input: parsed.input
      };
    }
  } catch {
    log.debug(`[question] JSON 解析失败: ${output.substring(start, Math.min(start + 500, output.length))}...`);
    return null;
  }

  return null;
}

/**
 * 格式化问题为微信友好格式
 */
export function formatQuestionsForWeChat(
  questions: AskUserRequest['questions'],
  displayName: string
): string {
  const lines: string[] = [];

  // 第一行：明确显示 agent 正在使用 question 工具
  lines.push(`🔔 ${displayName} 正在使用 AskUserQuestion 工具询问你`);
  lines.push('');

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    lines.push(`❓ ${q.question}`);

    // 总是假设有一个 "Other" 自定义选项
    const customOptionIndex = q.options.length;

    // 显示所有选项（数字编号）
    for (let j = 0; j < q.options.length; j++) {
      const opt = q.options[j];
      lines.push(`  ${j + 1}. ${opt.label}`);
    }

    // 自动添加 "Other" 自定义选项
    lines.push(`  ${customOptionIndex + 1}. Other ← 自定义选项，请输入 "${customOptionIndex + 1}:你的内容"`);

    if (q.multiSelect) {
      lines.push('  (可多选，用逗号分隔数字)');
    }

    // 输出调试信息
    log.info(`[formatQuestions] 问题: ${q.question}`);
    for (let j = 0; j < q.options.length; j++) {
      const opt = q.options[j];
      log.info(`[formatQuestions]   选项${j + 1}: label="${opt.label}"`);
    }
    log.info(`[formatQuestions]   自动添加自定义选项: index=${customOptionIndex + 1}`);

    if (i < questions.length - 1) {
      lines.push('');
    }
  }

  // 添加回答格式说明
  if (questions.length > 1) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📝 共 ' + questions.length + ' 个问题，请逐行回答：');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const customIdx = q.options.length + 1;
      const normalOpts = q.options.map((_, j) => j + 1).join('、');
      const multiNote = q.multiSelect ? '（可多选，用逗号分隔如 1,3）' : '（单选）';
      lines.push(`  第${i + 1}题${multiNote}: ${normalOpts} 或 ${customIdx}:自定义内容`);
    }
  } else {
    const q = questions[0];
    const customOptionIndex = q.options.length;
    const normalOptions = q.options.map((_, i) => i + 1).join('、');
    const multiNote = q.multiSelect ? '（可多选，用逗号分隔如 1,3）' : '';

    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📝 请回复：');
    lines.push(`  • ${normalOptions} 选择普通选项${multiNote}`);
    lines.push(`  • ${customOptionIndex + 1}:你的内容 选择自定义选项`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
  }

  lines.push(`— ${displayName} | 等待回复`);

  return lines.join('\n');
}

/**
 * 解析用户回答
 */
export interface ParsedAnswer {
  questionIndex: number;
  selections: number[];
  customInput?: string;
  isCustomOption: boolean;
}

export function parseUserAnswer(
  input: string,
  questionCount: number,
  questions: AskUserRequest['questions']
): ParsedAnswer[] {
  // 去除空白
  const trimmed = input.trim();

  // 单问题
  if (questionCount === 1) {
    return [parseSingleAnswer(trimmed, 0, questions[0])];
  }

  // 多问题：每行一个答案
  const lines = trimmed.split('\n').filter(l => l.trim());
  if (lines.length < questionCount) {
    throw new Error(
      `需要回答 ${questionCount} 个问题，但只收到 ${lines.length} 个答案`
    );
  }

  return lines.slice(0, questionCount).map((line, i) =>
    parseSingleAnswer(line.trim(), i, questions[i])
  );
}

function parseSingleAnswer(
  input: string,
  questionIndex: number,
  question: AskUserRequest['questions'][0]
): ParsedAnswer {
  const colonIndex = input.indexOf(':');
  let selectionPart = input;
  let customInput: string | undefined;

  if (colonIndex !== -1) {
    selectionPart = input.substring(0, colonIndex);
    customInput = input.substring(colonIndex + 1).trim();
  }

  const customOptionIndex = question.options.length;

  const selections: number[] = [];
  let hasCustomSelection = false;

  if (selectionPart.trim()) {
    const nums = selectionPart.split(',');
    for (const num of nums) {
      const n = parseInt(num.trim());
      if (!isNaN(n) && n > 0) {
        const selectedIndex = n - 1;
        if (selectedIndex >= customOptionIndex) {
          hasCustomSelection = true;
        } else if (selectedIndex < question.options.length) {
          selections.push(selectedIndex);
        }
      }
    }
  }

  if (hasCustomSelection) {
    return {
      questionIndex,
      selections,
      customInput: customInput || '',
      isCustomOption: true
    };
  }

  return {
    questionIndex,
    selections,
    customInput,
    isCustomOption: false
  };
}

/**
 * 将解析的答案转换为 tool_result 格式
 */
export function answersToToolResult(
  parsed: ParsedAnswer[],
  questions: AskUserRequest['questions']
): string {
  const answers: Record<string, string> = {};

  for (const p of parsed) {
    const q = questions[p.questionIndex];

    // 自定义选项（可能同时有常规选项选择）
    if (p.isCustomOption) {
      const selectedLabels = p.selections
        .filter(i => i >= 0 && i < q.options.length)
        .map(i => q.options[i].label);
      const parts = [...selectedLabels];
      if (p.customInput) parts.push(p.customInput);
      answers[q.question] = parts.join(',');
      continue;
    }

    // 如果只有自定义输入没有选择，直接使用自定义输入
    if (p.selections.length === 0 && p.customInput) {
      answers[q.question] = p.customInput;
      continue;
    }

    // 组合固定选项
    const selectedLabels = p.selections
      .filter(i => i >= 0 && i < q.options.length)
      .map(i => q.options[i].label);

    let answer = selectedLabels.join(',');

    // 添加自定义输入（补充说明）
    if (p.customInput && answer !== p.customInput) {
      answer += `:${p.customInput}`;
    }

    answers[q.question] = answer;
  }

  return JSON.stringify({
    type: 'input_json',
    input_json: { answers }
  });
}

/**
 * 构造 session 消息
 */
export interface SessionMessageOptions {
  parentUuid: string;
  toolUseId: string;
  toolResultContent: string;
  sessionId: string;
  workDir: string;
  promptId?: string;
}

export function buildSessionMessage(options: SessionMessageOptions): string {
  const uuid = randomUUID();
  const timestamp = new Date().toISOString();

  const message = {
    parentUuid: options.parentUuid,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: options.toolUseId,
          content: options.toolResultContent
        }
      ]
    },
    uuid,
    timestamp,
    sessionId: options.sessionId,
    promptId: options.promptId || '',
    sourceToolAssistantUUID: options.parentUuid,
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd: options.workDir
  };

  return JSON.stringify(message);
}

export function formatAnswersAsToolResultContent(answers: Record<string, string>): string {
  const answersText = Object.entries(answers)
    .map(([questionText, answer]) => `"${questionText}"="${answer}"`)
    .join(', ');
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}

export function extractSessionMetadata(
  sessionId: string,
  workDir: string
): { promptId: string; version: string; gitBranch: string } | null {
  const encodedCwd = workDir
    .replace(/:[\/\\]/g, '--')
    .replace(/[\/\\]/g, '-');

  const claudeDir = join(homedir(), '.claude');
  const sessionsDir = join(claudeDir, 'projects', encodedCwd);
  const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);

  if (!existsSync(sessionPath)) return null;

  const allLines = readFileSync(sessionPath, 'utf-8').split('\n').filter(l => l.trim());

  for (const line of allLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.promptId) {
        return {
          promptId: obj.promptId,
          version: obj.version || '',
          gitBranch: obj.gitBranch || ''
        };
      }
    } catch {
      // skip
    }
  }

  return null;
}

/**
 * 追加消息到 session 文件
 */
export function appendToSession(
  sessionId: string,
  workDir: string,
  parentMessageUuid: string,
  message: string
): void {
  const encodedCwd = workDir
    .replace(/:[\/\\]/g, '--')
    .replace(/[\/\\]/g, '-');

  const claudeDir = join(homedir(), '.claude');
  const sessionsDir = join(claudeDir, 'projects', encodedCwd);
  const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);

  if (!existsSync(sessionPath)) {
    throw new Error(`Session 文件不存在: ${sessionPath}`);
  }

  const allLines = readFileSync(sessionPath, 'utf-8').split('\n').filter(l => l.trim());

  // Find the index of the assistant message that contains the tool_use
  let truncateIndex = -1;
  for (let i = allLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(allLines[i]);
      if (obj.uuid === parentMessageUuid) {
        truncateIndex = i;
        break;
      }
    } catch {
      // skip
    }
  }

  if (truncateIndex === -1) {
    log.warn(`[question] 未找到 assistant message UUID: ${parentMessageUuid}，直接追加`);
  } else {
    // Keep everything up to and including the assistant message, discard the rest
    const keptLines = allLines.slice(0, truncateIndex + 1);
    log.debug(`[question] 截断 session 文件: 保留 ${keptLines.length}/${allLines.length} 行 (到 assistant message ${parentMessageUuid})`);
    writeFileSync(sessionPath, keptLines.join('\n') + '\n', 'utf-8');
  }

  appendFileSync(sessionPath, message + '\n');
  log.debug(`[question] 已追加 tool_result 到 session 文件`);
}
