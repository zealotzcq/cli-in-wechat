# cli-in-wechat

在微信中运行主流 AI 编程 CLI 工具 —— 通过微信 ClawBot 官方 iLink Bot API 实现。

**支持的工具：** Claude Code / Codex CLI / Gemini CLI / Kimi Code / OpenCode / CCB
其他参见main分支readme

## 相对于主分支的更新 feature/ccb
增加了对于ccb的适配，支持通过cli而不是agent sdk来实现session resume和AskUserQuestion工具
需要配套定制版的ccb使用, https://github.com/zealotzcq/ccb/tree/feature/cli-weixin-ccb
