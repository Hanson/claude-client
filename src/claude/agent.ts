/**
 * Claude Agent SDK 集成模块
 *
 * 重要说明:
 * - SDK 底层是通过 spawn 启动 Claude Code CLI (claude 命令)
 * - 通过 --output-format stream-json 让 CLI 输出 JSON 流
 * - 用户需要先安装 Claude Code CLI
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, createReadStream, unlinkSync, mkdirSync, openSync, closeSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'events';
import type {
  ClaudeSessionOptions,
  ClaudeMessage,
  ClaudeAssistantMessage,
  ClaudeResultMessage,
  ClaudeSystemMessage,
  MCPServerConfig,
  ToolCallInfo,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

// ============ SDK 类型定义 ============

export interface SDKMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface SDKAssistantMessage extends SDKMessage {
  type: 'assistant';
  parent_tool_use_id?: string;
  message: {
    role: 'assistant';
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
}

export interface SDKSystemMessage extends SDKMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string; error?: string }>;
}

export interface SDKResultMessage extends SDKMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result?: string;
  num_turns: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  total_cost_usd: number;
  duration_ms: number;
  is_error: boolean;
  session_id: string;
}

export interface QueryOptions {
  cwd?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  model?: string;
  fallbackModel?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  resume?: string;
  abort?: AbortSignal;
}

// ============ Claude Agent 类 ============

export class ClaudeAgent extends EventEmitter {
  private options: ClaudeSessionOptions;
  private isProcessing: boolean = false;
  private childProcess: ChildProcess | ChildProcessWithoutNullStreams | null = null;
  private stderrOutput: string = '';

  constructor(options: ClaudeSessionOptions) {
    super();
    this.options = options;
  }

  /**
   * 发送消息并流式处理响应
   * @param prompt 用户输入
   * @param continueConversation 是否继续对话（保持上下文）
   */
  async *sendMessage(prompt: string, continueConversation?: boolean): AsyncGenerator<ClaudeMessage, void, unknown> {
    if (this.isProcessing) {
      throw new Error('Agent is already processing a message');
    }

    this.isProcessing = true;
    this.stderrOutput = '';

    try {
      logger.debug('Starting Claude agent query', {
        prompt: prompt.substring(0, 100),
        cwd: this.options.workingDirectory,
        continueConversation,
      });

      const args = this.buildArgs(prompt, continueConversation);
      const claudePath = this.getClaudePath();

      // 记录完整的命令参数（用于调试）
      logger.info('Executing Claude CLI', {
        claudePath,
        argsCount: args.length,
        permissionMode: this.options.permissionMode,
        hasSystemPrompt: args.includes('--append-system-prompt'),
        cwd: this.options.workingDirectory,
        promptPreview: prompt.substring(0, 200),
      });

      const env = { ...process.env };
      // 必须删除 CLAUDECODE 环境变量，否则 Claude CLI 会拒绝在嵌套会话中运行
      delete env.CLAUDECODE;

      // 使用 spawnSync，在 Windows 上需要 shell 来执行 .cmd 文件
      const { spawnSync } = await import('child_process');

      const startTime = Date.now();
      const result = spawnSync(claudePath, args, {
        cwd: this.options.workingDirectory,
        encoding: 'utf8',
        shell: true,
        env,
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      const duration = Date.now() - startTime;

      // 记录执行结果
      logger.info('Claude CLI execution finished', {
        exitCode: result.status,
        duration: `${Math.floor(duration / 1000)}s`,
        stdoutLength: result.stdout?.length || 0,
        stderrLength: result.stderr?.length || 0,
        pid: result.pid,
      });

      if (result.error) {
        throw new Error(`Failed to execute Claude: ${result.error.message}`);
      }

      if (result.stderr) {
        this.stderrOutput = result.stderr;
        logger.debug('Claude stderr:', result.stderr);
      }

      if (result.status !== 0) {
        throw new Error(`Claude process exited with code ${result.status}: ${this.stderrOutput}`);
      }

      const stdout = result.stdout || '';
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const sdkMessage = JSON.parse(line) as SDKMessage;
          const message = this.convertSDKMessage(sdkMessage);

          if (message) {
            this.emitMessageEvent(message);
            yield message;
          }
        } catch (parseError) {
          logger.debug('Failed to parse line:', { line: line.substring(0, 100) });
        }
      }

      this.emit('complete');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Claude agent query error', { error: err.message });
      this.emit('error', err);
      throw err;
    } finally {
      this.isProcessing = false;
      this.childProcess = null;
    }
  }

  /**
   * 中止当前处理
   */
  abort(): void {
    if (this.childProcess && !this.childProcess.killed) {
      logger.debug('Killing Claude process');
      this.childProcess.kill('SIGTERM');
    }
  }

  /**
   * 检查是否正在处理
   */
  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * 获取当前进程 PID
   */
  getCurrentPid(): number | null {
    return this.childProcess?.pid || null;
  }

  /**
   * 异步执行并返回 Promise（支持进度监控）
   * 使用 spawnSync 在 Promise 中执行，避免 Windows 上 spawn 的兼容性问题
   */
  async executeAsync(prompt: string, continueConversation?: boolean): Promise<ClaudeMessage[]> {
    if (this.isProcessing) {
      throw new Error('Agent is already processing a message');
    }

    this.isProcessing = true;
    this.stderrOutput = '';
    const messages: ClaudeMessage[] = [];

    // 超时时间：30 分钟（复杂任务可能需要更长时间）
    const TIMEOUT_MS = 30 * 60 * 1000;

    try {
      const args = this.buildArgs(prompt, continueConversation);
      const claudePath = this.getClaudePath();

      logger.info('Executing Claude CLI (async)', {
        claudePath,
        argsCount: args.length,
        permissionMode: this.options.permissionMode,
        cwd: this.options.workingDirectory,
        promptPreview: prompt.substring(0, 100),
      });

      const env = { ...process.env };
      // 必须删除 CLAUDECODE 环境变量，否则 Claude CLI 会拒绝在嵌套会话中运行
      delete env.CLAUDECODE;

      // 记录命令参数（调试用）
      logger.info('Claude CLI args', { args });

      const startTime = Date.now();

      // 使用 spawnSync 执行，用 Promise 包装以支持异步
      const stdout = await new Promise<string>((resolve, reject) => {
        // 使用 setImmediate 确保 Promise 不会阻塞
        setImmediate(() => {
          try {
            const result = spawnSync(claudePath, args, {
              cwd: this.options.workingDirectory,
              encoding: 'utf8',
              shell: true,
              env,
              windowsHide: true,
              maxBuffer: 50 * 1024 * 1024,
              timeout: TIMEOUT_MS,
            });

            const duration = Date.now() - startTime;

            if (result.error) {
              logger.error('Claude CLI spawn error', { error: result.error.message });
              reject(new Error(`Failed to execute Claude: ${result.error.message}`));
              return;
            }

            if (result.stderr) {
              this.stderrOutput = result.stderr;
              logger.debug('Claude stderr:', { stderr: result.stderr.substring(0, 200) });
            }

            logger.info('Claude CLI execution finished', {
              exitCode: result.status,
              duration: `${Math.floor(duration / 1000)}s`,
              stdoutLength: result.stdout?.length || 0,
              stderrLength: result.stderr?.length || 0,
              pid: result.pid,
            });

            if (result.status !== 0) {
              const errorMsg = this.stderrOutput
                ? `Claude process exited with code ${result.status}: ${this.stderrOutput}`
                : `Claude process exited with code ${result.status}`;
              logger.error('Claude CLI process error', { code: result.status, duration: `${Math.floor(duration / 1000)}s` });
              reject(new Error(errorMsg));
              return;
            }

            resolve(result.stdout || '');
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error('Claude CLI execution error', { error: error.message });
            reject(error);
          }
        });
      });

      // 解析输出
      const lines = stdout.split('\n');
      logger.debug('Parsing output lines', { lineCount: lines.length, totalLength: stdout.length });

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const sdkMessage = JSON.parse(line) as SDKMessage;
          const message = this.convertSDKMessage(sdkMessage);

          if (message) {
            this.emitMessageEvent(message);
            messages.push(message);
          }
        } catch (parseError) {
          logger.debug('Failed to parse line:', { line: line.substring(0, 100) });
        }
      }

      this.emit('complete');
      return messages;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Claude agent query error', { error: err.message, stack: err.stack });
      this.emit('error', err);
      throw err;
    } finally {
      this.isProcessing = false;
      this.childProcess = null;
    }
  }

  /**
   * 流式执行 - 输出到文件并实时发射消息事件
   * 解决 stdout 管道缓冲问题，实现准实时流式输出
   *
   * @param prompt 用户输入
   * @param continueConversation 是否继续对话（保持上下文）
   * @returns Promise<ClaudeMessage[]> 所有消息
   */
  async executeStreaming(prompt: string, continueConversation?: boolean): Promise<ClaudeMessage[]> {
    if (this.isProcessing) {
      throw new Error('Agent is already processing a message');
    }

    this.isProcessing = true;
    this.stderrOutput = '';
    const messages: ClaudeMessage[] = [];

    // 创建临时输出文件
    const outputDir = join(tmpdir(), 'claude-client-streams');
    const outputFile = join(outputDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    let outputFileHandle: number | null = null;

    try {
      // 确保目录存在
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const args = this.buildArgs(prompt, continueConversation);
      const claudePath = this.getClaudePath();

      logger.info('Executing Claude CLI (streaming)', {
        claudePath,
        argsCount: args.length,
        permissionMode: this.options.permissionMode,
        cwd: this.options.workingDirectory,
        outputFile,
        promptPreview: prompt.substring(0, 100),
      });

      const env = { ...process.env };
      delete env.CLAUDECODE;

      // 启动文件监控器
      let lastPosition = 0;
      let isReading = false;

      const readNewLines = async () => {
        if (isReading) {
          logger.debug('Stream poll: already reading, skip');
          return;
        }
        if (!existsSync(outputFile)) {
          logger.debug('Stream poll: file not exists yet');
          return;
        }
        isReading = true;

        try {
          const { statSync } = await import('fs');
          const stats = statSync(outputFile);
          const currentSize = stats.size;

          // 如果文件大小没有变化，跳过
          if (currentSize === lastPosition) {
            return;
          }

          logger.info('Stream poll: reading file', {
            currentSize,
            lastPosition,
            newBytes: currentSize - lastPosition
          });

          const stream = createReadStream(outputFile, {
            encoding: 'utf8',
            start: lastPosition,
          });

          let buffer = '';
          for await (const chunk of stream) {
            buffer += chunk;
          }

          const lines = buffer.split('\n');
          // 最后一行可能不完整，保留到下次读取
          buffer = lines.pop() || '';

          let newMessagesCount = 0;
          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const sdkMessage = JSON.parse(line) as SDKMessage;
              const message = this.convertSDKMessage(sdkMessage);

              if (message) {
                this.emitMessageEvent(message);
                messages.push(message);
                // 发射流式消息事件
                this.emit('stream:message', message);
                newMessagesCount++;
              }
            } catch (parseError) {
              logger.debug('Failed to parse streaming line:', { line: line.substring(0, 100) });
            }
          }

          if (newMessagesCount > 0) {
            logger.info('Stream poll: new messages', { count: newMessagesCount, total: messages.length });
          }

          // 更新位置
          lastPosition = currentSize - buffer.length;
        } catch (err) {
          logger.info('Error reading stream file', { error: String(err) });
        } finally {
          isReading = false;
        }
      };

      // 使用轮询方式监控文件变化（更可靠）
      const pollInterval = setInterval(readNewLines, 500);

      // 打开文件用于写入
      outputFileHandle = openSync(outputFile, 'w');

      logger.debug('Executing with file redirect', {
        claudePath,
        argsCount: args.length,
        outputFile
      });

      // 使用异步 spawn，用 stdio 重定向到文件
      const startTime = Date.now();

      const exitCode = await new Promise<number>((resolve, reject) => {
        this.childProcess = spawn(claudePath, args, {
          cwd: this.options.workingDirectory,
          shell: true,
          env,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', outputFileHandle, outputFileHandle], // stdin, stdout, stderr
        });

        this.childProcess.on('error', (err) => {
          logger.error('Claude CLI spawn error', { error: err.message });
          reject(err);
        });

        this.childProcess.on('close', (code) => {
          resolve(code ?? 0);
        });

        // 设置超时
        const timeout = setTimeout(() => {
          if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill('SIGTERM');
          }
          reject(new Error('Claude CLI timeout after 30 minutes'));
        }, 30 * 60 * 1000);

        // 清理超时
        this.childProcess.on('close', () => {
          clearTimeout(timeout);
        });
      });

      const duration = Date.now() - startTime;

      // 停止轮询
      clearInterval(pollInterval);

      // 读取剩余内容
      await readNewLines();

      logger.info('Claude CLI streaming execution finished', {
        exitCode,
        duration: `${Math.floor(duration / 1000)}s`,
        messageCount: messages.length,
      });

      if (exitCode !== 0) {
        throw new Error(`Claude process exited with code ${exitCode}`);
      }

      this.emit('complete');

      // 清理临时文件
      try {
        if (existsSync(outputFile)) {
          unlinkSync(outputFile);
        }
      } catch {
        // 忽略清理错误
      }

      return messages;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Claude agent streaming error', { error: err.message, stack: err.stack });
      this.emit('error', err);
      throw err;
    } finally {
      this.isProcessing = false;
      this.childProcess = null;

      // 关闭文件句柄
      if (outputFileHandle !== null) {
        try {
          closeSync(outputFileHandle);
        } catch {
          // 忽略
        }
      }

      // 确保清理临时文件
      try {
        if (existsSync(outputFile)) {
          unlinkSync(outputFile);
        }
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 获取 Claude 可执行文件路径
   */
  private getClaudePath(): string {
    // 优先使用环境变量指定的路径
    if (process.env.CLAUDE_CODE_PATH) {
      return process.env.CLAUDE_CODE_PATH;
    }

    // 默认使用 claude 命令
    return 'claude';
  }

  /**
   * 构建命令行参数
   * 在 shell: true 模式下，包含空格或特殊字符的参数需要被引号包裹
   */
  private buildArgs(prompt: string, continueConversation?: boolean): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // 继续对话（保持上下文）
    if (continueConversation) {
      args.push('--continue');
    }

    // 权限模式
    if (this.options.permissionMode) {
      args.push('--permission-mode', this.options.permissionMode);

      // 对于激进模式，同时添加 --dangerously-skip-permissions 标志
      if (this.options.permissionMode === 'bypassPermissions') {
        args.push('--dangerously-skip-permissions');
      }
    }

    // 允许的工具 - 需要引号包裹（特别是 * 通配符）
    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      const toolsList = this.options.allowedTools.join(',');
      args.push('--allowedTools', `"${toolsList}"`);
    }

    // 模型
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // 系统提示 - 需要引号包裹
    let systemPrompt = this.options.systemPrompt || '';

    // 对于激进模式，添加自动执行提示
    if (this.options.permissionMode === 'bypassPermissions') {
      const autoExecutePrompt = 'IMPORTANT: Execute tasks directly without asking for confirmation or clarification. If the user provides a path, directory name, or any specific detail, use it exactly as provided. Do not ask follow-up questions - just proceed with the task. Make reasonable assumptions when needed rather than asking.';
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${autoExecutePrompt}` : autoExecutePrompt;
    }

    if (systemPrompt) {
      // 转义引号并包裹
      args.push('--append-system-prompt', `"${systemPrompt.replace(/"/g, '""')}"`);
    }

    // MCP 服务器 - 需要引号包裹
    if (this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0) {
      const mcpConfig = JSON.stringify({ mcpServers: this.options.mcpServers });
      args.push('--mcp-config', `"${mcpConfig.replace(/"/g, '""')}"`);
    }

    // 提示词 - 需要引号包裹
    args.push('--print', `"${prompt.trim().replace(/"/g, '""')}"`);

    return args;
  }

  /**
   * 等待进程结束
   */
  private waitForProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.childProcess) {
        resolve();
        return;
      }

      this.childProcess.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          const errorMsg = this.stderrOutput
            ? `Claude process exited with code ${code}: ${this.stderrOutput}`
            : `Claude process exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });

      this.childProcess.on('error', (error) => {
        reject(new Error(`Failed to spawn Claude process: ${error.message}`));
      });
    });
  }

  /**
   * 转换 SDK 消息为内部格式
   */
  private convertSDKMessage(sdkMessage: SDKMessage): ClaudeMessage | null {
    switch (sdkMessage.type) {
      case 'system': {
        const sysMsg = sdkMessage as SDKSystemMessage;
        return {
          type: 'system',
          subtype: sysMsg.subtype,
          session_id: sysMsg.session_id,
        } as ClaudeSystemMessage;
      }

      case 'assistant': {
        const astMsg = sdkMessage as SDKAssistantMessage;
        return {
          type: 'assistant',
          content: astMsg.message?.content || [],
        } as ClaudeAssistantMessage;
      }

      case 'result': {
        const resMsg = sdkMessage as SDKResultMessage;
        return {
          type: 'result',
          subtype: resMsg.subtype || 'success',
          result: resMsg.result,
          usage: resMsg.usage,
          total_cost_usd: resMsg.total_cost_usd,
          duration_ms: resMsg.duration_ms,
          num_turns: resMsg.num_turns,
          is_error: resMsg.is_error,
          session_id: resMsg.session_id,
        } as ClaudeResultMessage;
      }

      default:
        logger.debug('Unknown SDK message type', { type: sdkMessage.type });
        return null;
    }
  }

  /**
   * 发送消息事件
   */
  private emitMessageEvent(message: ClaudeMessage): void {
    switch (message.type) {
      case 'system':
        this.emit('message:system', message as ClaudeSystemMessage);
        break;

      case 'assistant': {
        const assistantMsg = message as ClaudeAssistantMessage;
        this.emit('message:assistant', assistantMsg);

        // 处理内容块
        if (assistantMsg.content) {
          for (const block of assistantMsg.content) {
            if (block.type === 'thinking' && 'thinking' in block) {
              this.emit('thinking', (block as { thinking: string }).thinking);
            } else if (block.type === 'tool_use') {
              this.emit('tool_call', {
                id: (block as { id: string }).id,
                name: (block as { name: string }).name,
                input: (block as { input: Record<string, unknown> }).input,
                status: 'pending',
              } as ToolCallInfo);
            }
          }
        }
        break;
      }

      case 'result':
        this.emit('message:result', message as ClaudeResultMessage);
        break;
    }
  }

  /**
   * 更新选项
   */
  updateOptions(options: Partial<ClaudeSessionOptions>): void {
    this.options = { ...this.options, ...options };
  }
}

// ============ 辅助函数 ============

/**
 * 创建 Claude Agent 实例
 */
export function createClaudeAgent(options: ClaudeSessionOptions): ClaudeAgent {
  return new ClaudeAgent(options);
}

/**
 * 检查 Claude CLI 是否可用
 */
export async function checkClaudeAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      shell: process.platform === 'win32',
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          available: true,
          version: output.trim(),
        });
      } else {
        resolve({
          available: false,
          error: `Claude CLI exited with code ${code}`,
        });
      }
    });

    child.on('error', (error) => {
      resolve({
        available: false,
        error: `Claude CLI not found: ${error.message}. Please install Claude Code first.`,
      });
    });
  });
}

/**
 * 格式化 Claude 响应为文本
 */
export function formatClaudeResponse(message: ClaudeAssistantMessage): string {
  const parts: string[] = [];

  if (message.content) {
    for (const block of message.content) {
      if (block.type === 'text' && 'text' in block) {
        parts.push((block as { text: string }).text);
      } else if (block.type === 'tool_use') {
        parts.push(`🔧 使用工具: ${(block as { name: string }).name}`);
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * 提取工具调用信息
 */
export function extractToolCalls(message: ClaudeAssistantMessage): ToolCallInfo[] {
  const toolCalls: ToolCallInfo[] = [];

  if (message.content) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block as { id: string }).id,
          name: (block as { name: string }).name,
          input: (block as { input: Record<string, unknown> }).input,
          status: 'pending',
        });
      }
    }
  }

  return toolCalls;
}
