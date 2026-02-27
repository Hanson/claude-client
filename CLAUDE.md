# claude-client 开发指南

## 项目概述

claude-client 是一个飞书机器人，用于远程控制 Claude Code CLI。

## 关键技术要点

### 1. Claude CLI 执行方式

#### Windows 上的 stdout 管道缓冲问题

**问题描述**：
- 在 Windows 上使用 Node.js `spawn` 执行 `claude` 命令时，`--output-format stream-json` 的输出无法被实时接收
- 这是因为 stdout 在管道时是**块缓冲（~4-8KB）**而不是行缓冲
- 相关 Issue: https://github.com/anthropics/claude-code/issues/25670

**已测试的方案**：

| 方案 | 结果 |
|-----|------|
| `spawn` + `shell: true` | ❌ 无输出，进程卡住 |
| `spawn` + `shell: false` | ❌ ENOENT（找不到 .cmd 文件） |
| `spawn` + `cmd.exe /c` | ❌ 无输出 |
| `exec` | ❌ 无输出，超时 |
| `spawn` + PowerShell | ❌ 无输出 |
| `spawnSync` | ✅ 可用，但输出在完成后一次性返回 |
| **输出到文件 + 轮询读取** | ✅ 可用，实现准实时流式输出 |

**结论**：
1. 在 Windows 上，Node.js 对 `.cmd` 文件的 stdio 管道处理存在问题
2. 推荐使用 `spawnSync` 或 **输出到文件 + 轮询** 的方案

### 2. 命令行参数引号处理

**问题**：在 `shell: true` 模式下，参数中的空格和特殊字符需要被正确引用。

**正确的参数格式**：
```typescript
// buildArgs 方法中
args.push('--allowedTools', `"${toolsList}"`);
args.push('--append-system-prompt', `"${systemPrompt.replace(/"/g, '""')}"`);
args.push('--print', `"${prompt.trim().replace(/"/g, '""')}"`);
```

**注意**：
- 参数值需要用双引号包裹
- 内部的双引号需要转义为 `""`（Windows cmd 的转义方式）

### 3. CLAUDECODE 环境变量

**问题**：Claude CLI 会检测 `CLAUDECODE` 环境变量，如果在嵌套会话中运行会拒绝执行。

**解决方案**：
```typescript
const env = { ...process.env };
delete env.CLAUDECODE;  // 必须删除，不能只是设置为空字符串
```

### 4. ESM 模块语法

**问题**：项目使用 ES 模块（ESM），不能使用 CommonJS 的 `require()`。

**错误示例**：
```typescript
const { spawnSync } = require('child_process');  // ❌ Error: require is not defined
```

**正确示例**：
```typescript
import { spawn, spawnSync } from 'node:child_process';  // ✅
```

## 成功的执行方案

### 方案一：spawnSync（同步执行）

适用于不需要实时输出的场景：

```typescript
const result = spawnSync(claudePath, args, {
  cwd: this.options.workingDirectory,
  encoding: 'utf8',
  shell: true,
  env,
  windowsHide: true,
  maxBuffer: 50 * 1024 * 1024,
  timeout: 30 * 60 * 1000,
});

// 解析输出
const lines = result.stdout?.split('\n') || [];
for (const line of lines) {
  if (line.trim()) {
    const message = JSON.parse(line);
    // 处理消息
  }
}
```

### 方案二：输出到文件 + 轮询（流式执行）

适用于需要准实时输出的场景：

```typescript
// 1. 创建临时输出文件
const outputFile = join(tmpdir(), 'claude-client-streams', `${Date.now()}.jsonl`);

// 2. 构建命令，输出重定向到文件
const cmd = `claude ${args.join(' ')} > "${outputFile}"`;

// 3. 启动轮询读取文件
const pollInterval = setInterval(async () => {
  if (existsSync(outputFile)) {
    const content = await readFile(outputFile, 'utf8');
    // 解析新增的行
    const newLines = content.slice(lastPosition).split('\n');
    lastPosition = content.length;
    // 处理新行...
  }
}, 500);

// 4. 执行命令
spawnSync('cmd.exe', ['/c', cmd], { shell: false, ... });

// 5. 清理
clearInterval(pollInterval);
unlinkSync(outputFile);
```

## 消息类型

Claude CLI 使用 `--output-format stream-json` 时输出 JSON 流，每行一个 JSON 对象：

| 类型 | 说明 |
|-----|------|
| `system` | 系统消息，包含 `session_id` |
| `assistant` | 助手响应，包含工具调用信息 |
| `result` | 最终结果 |

## 调试技巧

1. **直接在 bash 中测试命令**：
   ```bash
   cd D:/code && env -u CLAUDECODE claude --output-format stream-json --print 'say hello'
   ```

2. **查看进程命令行**：
   ```bash
   wmic process where "Name='cmd.exe'" get ProcessId,CommandLine | grep -i claude
   ```

3. **检查参数是否正确**：
   - 查看日志中的 `Claude CLI args`
   - 确认引号是否正确包裹

## 常见错误

| 错误 | 原因 | 解决方案 |
|-----|------|---------|
| `spawn claude ENOENT` | 找不到 claude 命令 | 使用 `shell: true` |
| `require is not defined` | ESM 中使用了 require | 改用 import |
| `Claude Code cannot be launched inside another Claude Code session` | CLAUDECODE 环境变量 | `delete env.CLAUDECODE` |
| 进程卡住无输出 | Windows stdio 缓冲问题 | 使用文件输出或 spawnSync |
| 参数解析错误 | 引号处理不当 | 正确转义双引号 |
