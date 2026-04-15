# AGENTS.md - 智能体编码指南

本文件为在此仓库中工作的 AI 编码代理提供指导。

## 仓库功能
本仓库代码的主要功能是作为微信消息聊天机器人，一端和微信连接，一段和本地cli工具连接，双向传输信息

## 构建、检查和测试命令

```bash
# 开发模式
npm run dev              # 使用 tsx 运行（热重载）
npm run dev:debug        # 启用调试日志运行

# 构建
npm run build            # TypeScript 编译到 dist/
npm run typecheck        # 仅类型检查不生成文件

# 测试
npm test                 # 运行所有测试
node --test test/*.test.ts  # 显式运行所有测试
node --test test/router.test.ts  # 运行单个测试文件
```

## 日志和状态
开发者会使用如下命令启动开发服务：
npm run dev 2>1 | tee ./debug.log
所以智能体应该自己读取这个日志文件(当前工程目录下)来获得运行时信息，并在需要时增加日志

## 代码风格指南

### TypeScript 配置
- 目标：ES2022，模块：Node16，严格模式启用
- 导入必须使用 `.js` 扩展名（Node 16+ ESM 要求）
- 无配置的 lint 工具 - 遵循 TypeScript 严格模式

### 导入和模块
- 所有导入必须使用 `.js` 扩展名（Node 16+ 中的 ESM）
- 使用 `node:` 协议导入内置模块：`import { readFileSync } from 'node:fs'`
- 分组导入：标准库 → 第三方 → 本地模块
- 跨边界使用时重新导出类型：`export type { MyType }`

### 命名约定
- **文件**：kebab-case（`opencode.ts`、`session-manager.ts`）
- **类**：PascalCase（`ClaudeAdapter`、`SessionManager`）
- **接口**：PascalCase（`CLIAdapter`、`ExecOptions`）
- **函数/方法**：camelCase（`execute()`、`listSessions()`）
- **常量**：UPPER_SNAKE_CASE（`DEFAULT_SETTINGS`、`TOOL_ALIASES`）
- **私有成员**：前缀下划线（`_lastSessionList`）

### 类型定义
- 在公共方法上使用显式返回类型
- 公共契约首选接口，联合/元组使用 type
- 对不可变数据使用 `Readonly` 和 `as const`
- 导出被其他模块使用的类型

### 错误处理
- 不要抛出异常 - 使用 Promise 拒绝或返回错误对象
- 使用 `ExecResult.error: boolean` 标志而非异常
- 使用 `isSessionError(text)` 助手检测会话错误
- 使用 `log.error()` 记录错误，通过格式化消息面向用户
- 优雅地处理进程失败（`on('error')`、`on('close')`）

### 会话管理（OpenCode 集成的关键）
- 会话 ID 存储在 `UserSettings.sessionIds[toolName]` 中
- **OpenCode**：`sessionResume: false` - 不支持恢复，总是全新执行
- 具有 `sessionResume: true` 的工具（Claude、Codex）向 CLI 传递 `--resume <id>`
- 通过 `ExecResult` 中的 `sessionExpired` 标志自动清除过期会话
- SessionManager 持久化到 `~/.wx-ai-bridge/sessions.json`，权限模式 0o600

### 架构模式
- **适配器模式**：所有 CLI 工具实现 `CLIAdapter` 接口
- **路由器**：将消息路由到工具，处理 `/` 命令、`@` 提及、`>>` 接力
- **注册表**：运行时检测和管理可用适配器
- 通过 `adapter.execute(prompt, { settings, workDir, timeout, extraArgs, signal, askUser })` 执行
- 在 `/cancel` 或 Ctrl+C 时中止所有长时间运行的操作

### 进程管理
- 对跨平台 CLI 执行使用 `spawnProc()` 包装器
- Windows 要求对 npm 安装的 CLI 工具使用 `shell: true`
- 始终设置中止和超时：`setupAbort()`、`setupTimeout()`
- 在异步操作早期处理 `opts.signal?.aborted`
- 在 `finally` 块中清理：`active.delete()`、`stopTyping()`

### 日志记录
- 使用 `log.debug()`、`log.info()`、`log.warn()`、`log.error()`
- 使用 `--debug` 标志或 `-d` 设置调试模式
- 时间戳自动格式化并带颜色编码级别

### 文件操作
- 使用 `fs` 模块并设置适当的权限位：敏感数据使用 `{ mode: 0o600 }`
- 原子写入：写入到 `.tmp` 然后 `renameSync()`
- 优雅地处理缺失文件（首先使用 `existsSync()` 检查）

### 测试
- 使用 Node.js 内置测试运行器（`node:test`）
- 使用最小化接口模拟依赖项
- 测试状态变更而非内部细节
- 验证消息路由逻辑和会话持久性

## CCB 会话处理
- CCB是一个和claude code完全兼容，公用session数据的工具，但没有对应的agent sdk
- 对于ccb通道的功能，可以采用和cc通道同样的数据结构进行处理
- ccb的源代码位置在 /g/platform/src/github/claude-code-best， 可以在git bash环境下，先cd到这个路径，然后使用bash ./ccb_build.sh来编译并更新本地的ccb命令

## OpenCode 会话处理

OpenCode 集成细节：
- 命令：`opencode -p "prompt" -f json -q -c <workdir>`
- 无会话恢复能力 - 每个 prompt 是独立的
- JSON 输出解析 `content`/`result`/`response` 字段
- JSON 解析失败时回退到文本（去除 ANSI 代码）
- 设置时通过 `-c` 标志传递工作目录

## 重要说明

- 永远不要提交 `.wx-ai-bridge/` 目录（包含会话/凭据）
- Windows 开发：彻底测试 `shell: true` 的 CLI 生成
- 会话 ID 是 UUID 但在显示中截断以提高可读性
- `/resume` 从各自的目录列出 Claude/Codex 会话
- OpenCode 没有会话历史可列出/恢复
