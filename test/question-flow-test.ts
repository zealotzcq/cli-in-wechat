import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  detectAskUserQuestion,
  formatQuestionsForWeChat,
  parseUserAnswer,
  answersToToolResult,
  formatAnswersAsToolResultContent,
  extractSessionMetadata,
  buildSessionMessage,
  appendToSession,
} from '../src/utils/questionHandler.js';

const WORK_DIR = process.cwd();
const LOG_DIR = join(WORK_DIR, 'test-logs');
mkdirSync(LOG_DIR, { recursive: true });

const SESSION_BASE = join(homedir(), '.claude', 'projects',
  WORK_DIR.replace(/:[/\\]/g, '--').replace(/[/\\]/g, '-'));

const results: { step: string; pass: boolean; detail: string }[] = [];

function check(step: string, pass: boolean, detail: string) {
  results.push({ step, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${step}: ${detail}`);
}

function runCcb(args: string[], timeout = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('ccb', args, {
      cwd: WORK_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGTERM'); }, timeout);
    proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', stderr: err.message, code: -1 }); });
  });
}

function extractTextFromStream(streamOutput: string): string {
  let text = '';
  for (const line of streamOutput.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text') {
        text += obj.delta.text || '';
      }
      if (obj.type === 'result' && obj.result) {
        text = obj.result;
      }
    } catch {}
  }
  return text;
}

function extractSessionId(streamOutput: string): string {
  for (const line of streamOutput.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.session_id) return obj.session_id;
      if (obj.message?.session_id) return obj.message.session_id;
    } catch {}
  }
  return '';
}

function getSessionLineCount(sessionId: string): number {
  const path = join(SESSION_BASE, `${sessionId}.jsonl`);
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf-8').split('\n').filter(l => l.trim()).length;
}

function getLastSessionLines(sessionId: string, n: number): string[] {
  const path = join(SESSION_BASE, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  return lines.slice(-n);
}

async function runFullTest(label: string, mockUserInput: string, expectedAnswers: Record<string, string>) {
  results.length = 0;
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# ${label}`);
  console.log(`# 模拟用户回复: ${JSON.stringify(mockUserInput)}`);
  console.log(`${'#'.repeat(60)}`);

  const prefix = label.replace(/[^a-zA-Z0-9]/g, '_');

  // ════════════════════════════════════════════════════════════
  // PHASE 1: New session - CCB 调用 AskUserQuestion
  // ════════════════════════════════════════════════════════════
  console.log('\n>>> PHASE 1: NEW SESSION - 触发 AskUserQuestion');

  const prompt = '使用AskUserQuestion工具调研我的喜好，包含两个问题：第一问我最喜爱的颜色，选项红色白色蓝色；第二问我喜爱的运动，选项跑步和跳舞。收到回答后，输出一段30字描述我是什么样的人。';

  const { stdout: stream1, code: code1 } = await runCcb([
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ]);

  writeFileSync(join(LOG_DIR, `${prefix}_phase1_stream.jsonl`), stream1, 'utf-8');

  // 检查 result 的 is_error 字段而非 exit code
  let phase1IsError = true;
  let phase1StopReason = '';
  for (const line of stream1.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'result') {
        phase1IsError = !!obj.is_error;
        phase1StopReason = obj.stop_reason || '';
      }
    } catch {}
  }
  check('Phase1 CCB执行(非交互模式干净停止)', !phase1IsError,
    `exit code=${code1}, is_error=${phase1IsError}, stop_reason=${phase1StopReason}`);


  let noPermissionDenials = false;
  for (const line of stream1.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.permission_denials !== undefined) {
        noPermissionDenials = obj.permission_denials.length === 0;
      }
    } catch {}
  }
  check('Phase1 AskUserQuestion无permission_denials', noPermissionDenials, 'permission_denials应为空数组');

  const sessionId1 = extractSessionId(stream1);
  check('Phase1 获取sessionId', !!sessionId1, sessionId1 || '(空)');

  const pending = detectAskUserQuestion(stream1, { sessionId: sessionId1, workDir: WORK_DIR });
  check('Phase1 检测到AskUserQuestion', !!pending,
    pending ? `toolUseId=${pending.toolUseId}` : '未检测到');
  check('Phase1 parentMessageUuid非空', !!pending?.parentMessageUuid,
    pending?.parentMessageUuid || '(空)');

  if (!pending || !sessionId1) {
    console.log('  !! Phase1 失败，跳过后续步骤');
    console.log(`  !! stream前300字符: ${stream1.substring(0, 300)}`);
    return false;
  }

  // 验证 session 文件已创建且属于同一 session
  const linesBefore = getSessionLineCount(sessionId1);
  check('Phase1 session文件已创建', linesBefore > 0, `${linesBefore} 行`);
  writeFileSync(join(LOG_DIR, `${prefix}_phase1_session_lines.json`),
    JSON.stringify(getLastSessionLines(sessionId1, linesBefore), null, 2), 'utf-8');

  // ════════════════════════════════════════════════════════════
  // PHASE 2: 中间层处理 - 解析+写入session（跳过微信）
  // ════════════════════════════════════════════════════════════
  console.log('\n>>> PHASE 2: 中间层处理');

  // 2a. 格式化微信消息（仅保存，不发送）
  const wechatMsg = formatQuestionsForWeChat(pending.questions, 'CCB');
  writeFileSync(join(LOG_DIR, `${prefix}_wechat_msg.txt`), wechatMsg, 'utf-8');
  check('Phase2 生成微信消息', wechatMsg.includes('红色') && wechatMsg.includes('跳舞'),
    `包含红色=${wechatMsg.includes('红色')}, 包含跳舞=${wechatMsg.includes('跳舞')}`);

  // 2b. 解析模拟用户输入
  const parsed = parseUserAnswer(mockUserInput, pending.questions.length, pending.questions);
  check('Phase2 解析答案数量', parsed.length === pending.questions.length,
    `${parsed.length}/${pending.questions.length}`);

  // 2c. 构建最终 answers
  const answersObj = JSON.parse(answersToToolResult(parsed, pending.questions)).input_json.answers;
  const answerValues = Object.values(answersObj) as string[];
  const expectedValues = Object.values(expectedAnswers);
  check('Phase2 颜色答案正确', answerValues[0] === expectedValues[0],
    `期望="${expectedValues[0]}", 实际="${answerValues[0]}"`);

  // 2d. 构建人类可读 tool_result content
  const toolResultContent = formatAnswersAsToolResultContent(answersObj);
  check('Phase2 tool_result格式', toolResultContent.startsWith('User has answered'),
    `"${toolResultContent.substring(0, 80)}..."`);

  // 2e. 写入 session 文件
  const meta = extractSessionMetadata(sessionId1, WORK_DIR);
  const sessionMsg = buildSessionMessage({
    parentUuid: pending.parentMessageUuid,
    toolUseId: pending.toolUseId,
    toolResultContent,
    sessionId: sessionId1,
    workDir: WORK_DIR,
    promptId: meta?.promptId || '',
  });

  writeFileSync(join(LOG_DIR, `${prefix}_session_msg.json`),
    JSON.stringify(JSON.parse(sessionMsg), null, 2), 'utf-8');

  // 验证消息结构
  const msgObj = JSON.parse(sessionMsg);
  check('Phase2 msg.parentUuid', msgObj.parentUuid === pending.parentMessageUuid,
    `${msgObj.parentUuid} === ${pending.parentMessageUuid}`);
  check('Phase2 msg.tool_use_id', msgObj.message.content[0].tool_use_id === pending.toolUseId,
    `${msgObj.message.content[0].tool_use_id}`);
  check('Phase2 msg.type=user', msgObj.type === 'user', `type=${msgObj.type}`);
  check('Phase2 msg.sessionId', msgObj.sessionId === sessionId1,
    `${msgObj.sessionId} === ${sessionId1}`);

  try {
    appendToSession(sessionId1, WORK_DIR, pending.parentMessageUuid, sessionMsg);
    check('Phase2 写入session成功', true, '');
  } catch (e) {
    check('Phase2 写入session成功', false, (e as Error).message);
    return false;
  }

  // 验证 session 文件变化：应该被截断后追加了 tool_result
  const linesAfter = getSessionLineCount(sessionId1);
  check('Phase2 session行数变化正确', linesAfter < linesBefore + 5,
    `${linesBefore} -> ${linesAfter} (截断了error行，追加了1行)`);

  const lastLine = getLastSessionLines(sessionId1, 1)[0];
  const lastObj = JSON.parse(lastLine);
  check('Phase2 最后一行是user消息', lastObj.type === 'user', `type=${lastObj.type}`);
  check('Phase2 最后一行parentUuid正确', lastObj.parentUuid === pending.parentMessageUuid,
    `${lastObj.parentUuid}`);

  writeFileSync(join(LOG_DIR, `${prefix}_phase2_session_final.json`),
    JSON.stringify(getLastSessionLines(sessionId1, 3), null, 2), 'utf-8');

  // ════════════════════════════════════════════════════════════
  // PHASE 3: Resume session - CCB 读取答案并生成回复
  // ════════════════════════════════════════════════════════════
  console.log('\n>>> PHASE 3: RESUME SESSION - CCB 基于答案继续');

  const { stdout: stream2, code: code2 } = await runCcb([
    '-p', '继续',
    '--output-format', 'stream-json',
    '--verbose',
    '--resume', sessionId1,
  ], 90_000);

  writeFileSync(join(LOG_DIR, `${prefix}_phase3_stream.jsonl`), stream2, 'utf-8');
  check('Phase3 Resume CCB执行', code2 === 0, `exit code=${code2}`);

  const sessionId2 = extractSessionId(stream2);
  check('Phase3 Resume后sessionId一致', sessionId2 === sessionId1,
    `"${sessionId2}" === "${sessionId1}"`);

  const resumeText = extractTextFromStream(stream2);
  check('Phase3 Resume有文本输出', resumeText.length > 0,
    `"${resumeText.substring(0, 100)}..."`);

  // 关键验证：输出中应包含对用户选择的描述
  const hasAnswerReflection = /根据你/.test(resumeText) && resumeText.length > 10;
  check('Phase3 输出反映了用户答案', hasAnswerReflection,
    `"${resumeText.substring(0, 150)}"`);

  // 验证 session 文件在 resume 后有新内容
  const linesFinal = getSessionLineCount(sessionId1);
  check('Phase3 Resume后session增长', linesFinal > linesAfter,
    `${linesAfter} -> ${linesFinal}`);

  writeFileSync(join(LOG_DIR, `${prefix}_phase3_session_final.json`),
    JSON.stringify(getLastSessionLines(sessionId1, 3), null, 2), 'utf-8');

  console.log(`\n  >>> 最终 CCB 回复: "${resumeText}"`);

  // ════════════════════════════════════════════════════════════
  // BONUS: 验证 new session 是不同 session
  // ════════════════════════════════════════════════════════════
  console.log('\n>>> BONUS: 验证 new session 独立性');

  const { stdout: stream3, code: code3 } = await runCcb([
    '-p', 'reply ok',
    '--output-format', 'stream-json',
    '--verbose',
  ], 30_000);

  const sessionId3 = extractSessionId(stream3);
  check('Bonus 新session与之前不同', sessionId3 !== sessionId1,
    `"${sessionId3}" !== "${sessionId1}"`);

  const allPass = results.every(r => r.pass);
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# ${label}: ${allPass ? 'ALL PASSED' : 'HAS FAILURES'}`);
  console.log(`${'#'.repeat(60)}`);

  return allPass;
}

async function main() {
  const testCases = [
    {
      label: '测试A: 单选红色 + 多选跑步+自定义看书',
      input: '1\n1,3:看书',
      expected: { '你最喜爱的颜色是什么？': '红色', '你喜欢哪些运动？': '跑步,看书' },
    },
    {
      label: '测试B: 全部自定义输入 (绿色+游泳)',
      input: '4:绿色\n3:游泳',
      expected: { '你最喜爱的颜色是什么？': '绿色', '你喜欢哪些运动？': '游泳' },
    },
    {
      label: '测试C: 多选颜色+单选运动',
      input: '1,3\n2',
      expected: { '你最喜爱的颜色是什么？': '红色,蓝色', '你喜欢哪些运动？': '跳舞' },
    },
  ];

  const summary: { label: string; pass: boolean; fails: string[] }[] = [];

  for (const tc of testCases) {
    const prevLen = results.length;
    const pass = await runFullTest(tc.label, tc.input, tc.expected);
    const fails = results.slice(prevLen).filter(r => !r.pass).map(r => `${r.step}: ${r.detail}`);
    summary.push({ label: tc.label, pass, fails });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('最终汇总');
  console.log(`${'='.repeat(60)}`);
  for (const s of summary) {
    console.log(`  ${s.pass ? 'PASS' : 'FAIL'} ${s.label}`);
    if (!s.pass) {
      for (const f of s.fails) console.log(`        - ${f}`);
    }
  }
  console.log(`\n所有日志: ${LOG_DIR}`);
}

main().catch(console.error);
