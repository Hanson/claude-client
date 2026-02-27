/**
 * 应用核心逻辑
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { FeishuEventHandler, FeishuClient } from './feishu/index.js';
import { ClaudeAgent, formatClaudeResponse } from './claude/index.js';
import { SessionManager, getSessionManager } from './session/index.js';
import { TaskStore } from './session/task-store.js';
import { DirectoryStore } from './session/directory-store.js';
import { ChangeLoggerManager } from './change-logger/index.js';
import { getConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import {
  formatClaudeMessageForFeishu,
  truncateMessage,
  detectSpecialCommand,
  generateHelpMessage,
  generateHelpCard,
  generateTaskListCard,
  formatHistoryForContext,
  type TaskInfo,
} from './utils/formatter.js';
import type { FeishuMessageContext, ClaudePermissionMode, Session, ClaudeMessage, ClaudeAssistantMessage } from './types/index.js';

export interface ClaudeClientAppOptions {
  workingDirectory?: string;
}

export class ClaudeClientApp {
  private config: ReturnType<typeof getConfig>;
  private feishuHandler: FeishuEventHandler;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager;
  private taskStore: TaskStore;
  private directoryStore: DirectoryStore;
  private changeLogger: ChangeLoggerManager;
  private server: http.Server | null = null;
  private agents: Map<string, ClaudeAgent> = new Map();
  private defaultWorkingDirectory: string;
  private chatWorkingDirectories: Map<string, string> = new Map(); // 持久化每个聊天的工作目录
  private chatPermissionModes: Map<string, ClaudePermissionMode> = new Map(); // 持久化每个聊天的权限模式
  private settingsPath: string = './data/settings.json';

  constructor(options: ClaudeClientAppOptions = {}) {
    this.config = getConfig();
    this.sessionManager = getSessionManager();
    this.taskStore = new TaskStore('./data');
    this.directoryStore = new DirectoryStore('./data');
    this.changeLogger = new ChangeLoggerManager(ChangeLoggerManager.loadConfig(), './data');
    this.defaultWorkingDirectory = options.workingDirectory ?? process.cwd();

    // 加载持久化设置
    this.loadSettings();

    // 初始化飞书事件处理器
    this.feishuHandler = new FeishuEventHandler(this.config.feishu, {
      onMessage: (ctx) => this.handleMessage(ctx),
    });

    this.feishuClient = this.feishuHandler.getFeishuClient();
  }

  /**
   * 加载持久化设置
   */
  private loadSettings(): void {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const settings = JSON.parse(data);

        // 加载工作目录
        if (settings.workingDirectories) {
          for (const [chatId, dir] of Object.entries(settings.workingDirectories)) {
            this.chatWorkingDirectories.set(chatId, dir as string);
          }
        }

        // 加载权限模式
        if (settings.permissionModes) {
          for (const [chatId, mode] of Object.entries(settings.permissionModes)) {
            this.chatPermissionModes.set(chatId, mode as ClaudePermissionMode);
          }
        }

        logger.info('Settings loaded from file');
      }
    } catch (error) {
      logger.warn('Failed to load settings', { error });
    }
  }

  /**
   * 保存持久化设置
   */
  private saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const settings = {
        workingDirectories: Object.fromEntries(this.chatWorkingDirectories),
        permissionModes: Object.fromEntries(this.chatPermissionModes),
      };

      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
      logger.error('Failed to save settings', { error });
    }
  }

  /**
   * 获取指定聊天的工作目录（持久化，不随会话过期重置）
   */
  private getWorkingDirectory(chatId: string): string {
    return this.chatWorkingDirectories.get(chatId) ?? this.defaultWorkingDirectory;
  }

  /**
   * 设置指定聊天的工作目录
   */
  private setWorkingDirectory(chatId: string, directory: string): void {
    this.chatWorkingDirectories.set(chatId, directory);
    this.saveSettings(); // 持久化保存
  }

  /**
   * 获取指定聊天的权限模式
   */
  private getPermissionMode(chatId: string): ClaudePermissionMode {
    return this.chatPermissionModes.get(chatId) ?? this.config.claude.defaultPermissionMode;
  }

  /**
   * 设置指定聊天的权限模式
   */
  private setPermissionMode(chatId: string, mode: ClaudePermissionMode): void {
    this.chatPermissionModes.set(chatId, mode);
    this.saveSettings(); // 持久化保存
    logger.info('Permission mode set', { chatId, mode });
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    // 初始化飞书机器人
    await this.feishuHandler.initialize();

    // 初始化变更记录器
    this.changeLogger.setFeishuClient(this.feishuClient);
    await this.changeLogger.init();

    // 启动 WebSocket 客户端 (长连接模式)
    this.feishuHandler.startWebSocket();

    // 创建 HTTP 服务器 (用于健康检查)
    this.server = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.server.port, this.config.server.host, () => {
        logger.info(`Server started on ${this.config.server.host}:${this.config.server.port}`);
        logger.info('Claude Client is ready!');
        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    // 停止 WebSocket 客户端
    this.feishuHandler.stopWebSocket();

    // 停止所有 Agent
    for (const agent of this.agents.values()) {
      agent.abort();
    }
    this.agents.clear();

    // 停止会话管理器
    this.sessionManager.stop();

    // 关闭 HTTP 服务器
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * 处理飞书消息
   */
  private async handleMessage(ctx: FeishuMessageContext): Promise<void> {
    logger.info('Processing message', {
      messageId: ctx.messageId,
      chatId: ctx.chatId,
      senderId: ctx.senderOpenId,
      content: ctx.content.substring(0, 100),
    });

    try {
      // 检测特殊命令
      const command = detectSpecialCommand(ctx.content);
      if (command) {
        logger.info('Handling command', { messageId: ctx.messageId, command: command.type });
        await this.handleSpecialCommand(ctx, command);
        return;
      }

      // 获取持久化的工作目录
      const workingDirectory = this.getWorkingDirectory(ctx.chatId);

      // 获取或创建会话
      const session = this.sessionManager.getOrCreateSession({
        userId: ctx.senderOpenId,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        workingDirectory,
      });

      // 检查是否正在处理中
      if (session.status === 'processing') {
        // 使用表情回复表示忙碌
        try {
          await this.feishuClient.addReaction(ctx.messageId, 'CROSS');
        } catch {
          // 忽略表情回复失败
        }
        return;
      }

      // 处理消息
      await this.processMessage(session, ctx);
    } catch (error) {
      logger.error('Error processing message', { error, ctx });
      // 确保会话状态被重置
      this.sessionManager.updateSession(ctx.chatId, { status: 'idle' });
      try {
        await this.feishuClient.addReaction(ctx.messageId, 'ANGRY');
      } catch {
        // 忽略表情回复失败
      }
    }
  }

  /**
   * 处理特殊命令
   */
  private async handleSpecialCommand(
    ctx: FeishuMessageContext,
    command: { type: string; args: string }
  ): Promise<void> {
    switch (command.type) {
      case 'clear': {
        this.sessionManager.closeSession(ctx.chatId);
        // 清除对应的 Agent
        this.agents.delete(ctx.chatId);
        // 清除所有任务
        const taskCount = this.taskStore.clearChatTasks(ctx.chatId);
        await this.feishuClient.sendTextMessage(
          ctx.chatId,
          `✅ 会话上下文已清除\n🗑️ 已删除 ${taskCount} 个历史任务`,
          { replyToMessageId: ctx.messageId }
        );
        break;
      }

      case 'status': {
        const session = this.sessionManager.getSession(ctx.chatId);
        const workingDir = this.getWorkingDirectory(ctx.chatId);
        const status = session
          ? `📊 **会话状态**\n\n` +
            `• 会话 ID: \`${session.id}\`\n` +
            `• Claude 会话: ${session.claudeSessionId ? `\`${session.claudeSessionId}\`` : '未连接'}\n` +
            `• 工作目录: \`${workingDir}\`\n` +
            `• 状态: ${session.status}\n` +
            `• 创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}\n` +
            `• 最后活动: ${new Date(session.lastActivityAt).toLocaleString('zh-CN')}`
          : `📭 当前没有活跃会话\n\n• 工作目录: \`${workingDir}\``;

        await this.feishuClient.sendTextMessage(ctx.chatId, status, {
          replyToMessageId: ctx.messageId,
        });
        break;
      }

      case 'pwd': {
        const workingDir = this.getWorkingDirectory(ctx.chatId);
        await this.feishuClient.sendTextMessage(
          ctx.chatId,
          `📁 当前工作目录: \`${workingDir}\``,
          { replyToMessageId: ctx.messageId }
        );
        break;
      }

      case 'help': {
        const currentDir = this.getWorkingDirectory(ctx.chatId);
        // 记录当前目录访问
        this.directoryStore.recordAccess(currentDir);
        const recentDirs = this.directoryStore.getRecentDirectories(5);
        await this.feishuClient.sendCardMessage(
          ctx.chatId,
          generateHelpCard(currentDir, recentDirs),
          { replyToMessageId: ctx.messageId }
        );
        break;
      }

      case 'cd': {
        const inputDir = command.args.trim();
        const currentDir = this.getWorkingDirectory(ctx.chatId);

        // 解析相对路径为绝对路径
        let newDir = path.resolve(currentDir, inputDir);

        // 检查目录是否存在
        if (!fs.existsSync(newDir)) {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `❌ 目录不存在: \`${newDir}\``,
            { replyToMessageId: ctx.messageId }
          );
          break;
        }

        // 检查是否是目录
        try {
          const stats = fs.statSync(newDir);
          if (!stats.isDirectory()) {
            await this.feishuClient.sendTextMessage(
              ctx.chatId,
              `❌ 不是有效的目录: \`${newDir}\``,
              { replyToMessageId: ctx.messageId }
            );
            break;
          }
        } catch {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `❌ 无法访问目录: \`${newDir}\``,
            { replyToMessageId: ctx.messageId }
          );
          break;
        }

        // 设置持久化工作目录
        this.setWorkingDirectory(ctx.chatId, newDir);

        // 记录目录访问
        this.directoryStore.recordAccess(newDir);

        // 清除会话上下文和 Agent
        this.sessionManager.closeSession(ctx.chatId);
        this.agents.delete(ctx.chatId);

        await this.feishuClient.sendTextMessage(
          ctx.chatId,
          `✅ 工作目录已切换到: \`${newDir}\`\n📝 会话上下文已清除`,
          { replyToMessageId: ctx.messageId }
        );
        break;
      }

      case 'mode': {
        const validModes: ClaudePermissionMode[] = [
          'default',
          'acceptEdits',
          'bypassPermissions',
          'plan',
        ];
        if (validModes.includes(command.args as ClaudePermissionMode)) {
          // 保存权限模式
          this.setPermissionMode(ctx.chatId, command.args as ClaudePermissionMode);
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `✅ 权限模式已切换到: \`${command.args}\``,
            { replyToMessageId: ctx.messageId }
          );
        } else {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `❌ 无效的权限模式。可选: ${validModes.join(', ')}`,
            { replyToMessageId: ctx.messageId }
          );
        }
        break;
      }

      case 'tasklist': {
        const allTasks = this.taskStore.getTasksByChat(ctx.chatId);
        const currentDir = this.getWorkingDirectory(ctx.chatId);

        const taskInfos: TaskInfo[] = allTasks.map(t => ({
          id: t.id,
          workingDirectory: t.workingDirectory,
          claudeSessionId: t.claudeSessionId,
          lastMessage: t.lastMessage,
          updatedAt: t.updatedAt,
        }));
        const card = generateTaskListCard(taskInfos, currentDir);
        await this.feishuClient.sendCardMessage(ctx.chatId, card, {
          replyToMessageId: ctx.messageId,
        });
        break;
      }

      case 'resume': {
        const targetDir = command.args.trim();
        const task = this.taskStore.getTask(ctx.chatId, targetDir);

        if (!task) {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `❌ 未找到任务: \`${targetDir}\``,
            { replyToMessageId: ctx.messageId }
          );
          break;
        }

        // 切换到任务的工作目录
        this.setWorkingDirectory(ctx.chatId, task.workingDirectory);

        // 清除当前会话
        this.sessionManager.closeSession(ctx.chatId);
        this.agents.delete(ctx.chatId);

        // 创建新会话并设置 Claude Session ID
        const session = this.sessionManager.getOrCreateSession({
          userId: ctx.senderOpenId,
          chatId: ctx.chatId,
          chatType: ctx.chatType,
          workingDirectory: task.workingDirectory,
        });

        // 恢复 Claude Session ID
        this.sessionManager.updateSession(ctx.chatId, {
          claudeSessionId: task.claudeSessionId
        });

        await this.feishuClient.sendTextMessage(
          ctx.chatId,
          `✅ 已恢复任务\n\n📁 工作目录: \`${task.workingDirectory}\`\n📝 可以继续之前的对话`,
          { replyToMessageId: ctx.messageId }
        );
        break;
      }

      case 'taskdelete': {
        const targetDir = command.args.trim();
        const deleted = this.taskStore.deleteTask(ctx.chatId, targetDir);

        if (deleted) {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `✅ 已删除任务: \`${targetDir}\``,
            { replyToMessageId: ctx.messageId }
          );
        } else {
          await this.feishuClient.sendTextMessage(
            ctx.chatId,
            `❌ 未找到任务: \`${targetDir}\``,
            { replyToMessageId: ctx.messageId }
          );
        }
        break;
      }

    }
  }

  /**
   * 处理消息 (发送给 Claude)
   */
  private async processMessage(session: Session, ctx: FeishuMessageContext): Promise<void> {
    // 更新会话状态
    this.sessionManager.updateSession(ctx.chatId, { status: 'processing' });

    // 添加用户消息到历史
    this.sessionManager.addMessage(session.id, {
      role: 'user',
      content: ctx.content,
    });

    // 添加"思考中"表情
    let thinkingReactionId: string | null = null;
    try {
      thinkingReactionId = await this.feishuClient.addReaction(ctx.messageId, 'THINKING');
      logger.info('Added THINKING reaction', { reactionId: thinkingReactionId });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error('Failed to add THINKING reaction', { error: errMsg });
    }

    logger.info('After THINKING reaction, continuing to process');

    // 记录开始时间（用于计算执行时长）
    const startTime = Date.now();

    try {
      logger.info('Before directoryStore.recordAccess');
      // 记录目录访问
      this.directoryStore.recordAccess(session.workingDirectory);
      logger.info('After directoryStore.recordAccess');

      // 创建或获取 Agent
      let agent = this.agents.get(session.id);
      const permissionMode = this.getPermissionMode(ctx.chatId);
      if (!agent) {
        agent = new ClaudeAgent({
          workingDirectory: session.workingDirectory,
          permissionMode,
          allowedTools: this.config.claude.allowedTools,
        });
        this.agents.set(session.id, agent);
      } else {
        // 更新现有 Agent 的权限模式（修复权限模式缓存 bug）
        agent.updateOptions({
          permissionMode,
          allowedTools: this.config.claude.allowedTools,
        });
      }

      // 检查是否有正在处理的任务，如果有则中止
      if (agent.getIsProcessing()) {
        logger.warn('Agent is still processing, aborting previous task', {
          sessionId: session.id,
          pid: agent.getCurrentPid()
        });
        agent.abort();
        // 等待一小段时间让进程完全终止
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      logger.info('Starting Claude agent', { sessionId: session.id, permissionMode });

      let responseBuffer = '';
      let progressMessageId: string | null = null;
      const progressSteps: string[] = [];
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 2000; // 飞书消息更新间隔（2秒）
      let updatePending = false;

      // 发送初始进度消息
      const progressResult = await this.feishuClient.sendTextMessage(
        ctx.chatId,
        '🔄 正在处理...',
        { replyToMessageId: ctx.messageId }
      );
      progressMessageId = progressResult.messageId;

      // 更新飞书消息的节流函数
      const updateFeishuMessage = async (force: boolean = false) => {
        const now = Date.now();
        if (!force && now - lastUpdateTime < UPDATE_INTERVAL) {
          if (!updatePending) {
            updatePending = true;
            setTimeout(() => {
              updateFeishuMessage(true);
              updatePending = false;
            }, UPDATE_INTERVAL - (now - lastUpdateTime));
          }
          return;
        }
        lastUpdateTime = now;

        if (!progressMessageId || !responseBuffer) return;

        const statusText = truncateMessage(responseBuffer);
        try {
          await this.feishuClient.updateMessageToMarkdown(progressMessageId, statusText);
          logger.info('Feishu progress updated', { length: statusText.length });
        } catch (updateError) {
          // 更新失败（可能达到编辑次数上限），发送新消息
          logger.warn('Progress update failed, sending new message');
          try {
            const newMsg = await this.feishuClient.sendMarkdownMessage(
              ctx.chatId,
              statusText,
              { replyToMessageId: ctx.messageId }
            );
            progressMessageId = newMsg.messageId;
          } catch {
            // 忽略发送失败
          }
        }
      };

      // 用于追踪最后一次更新的 Promise，确保更新按顺序完成
      let lastUpdatePromise: Promise<void> = Promise.resolve();

      // 监听流式消息事件
      const streamHandler = (message: ClaudeMessage) => {
        logger.info('Received streaming message', { type: message.type });

        // 处理系统消息 (获取 Claude 会话 ID)
        if (message.type === 'system' && 'session_id' in message) {
          this.sessionManager.setClaudeSessionId(ctx.chatId, message.session_id as string);
          // 显示系统状态让用户知道在处理
          responseBuffer = '🔄 正在连接 Claude...';
          lastUpdatePromise = lastUpdatePromise.then(() => updateFeishuMessage());
        }

        // 处理工具调用和文本
        if (message.type === 'assistant') {
          const assistantMsg = message as ClaudeAssistantMessage;
          if (assistantMsg.content) {
            for (const block of assistantMsg.content) {
              if (block.type === 'tool_use' && block.name) {
                const toolEmoji = this.getToolEmoji(block.name);
                const toolDesc = this.getToolDescription(block.name, block.input || {});
                progressSteps.push(`${toolEmoji} ${block.name}: ${toolDesc}`);
              }
            }
          }

          const formatted = formatClaudeMessageForFeishu(message);
          if (formatted) {
            responseBuffer += (responseBuffer ? '\n\n' : '') + formatted;
            // 实时更新飞书消息，链接到更新链
            lastUpdatePromise = lastUpdatePromise.then(() => updateFeishuMessage());
          }
        }

        // 处理完成消息
        if (message.type === 'result') {
          const finalMessage = formatClaudeMessageForFeishu(message);
          if (finalMessage) {
            // result 消息追加到末尾，不要覆盖已有内容
            responseBuffer = responseBuffer ? responseBuffer + '\n\n' + finalMessage : finalMessage;
            // 立即更新飞书消息，确保最终结果被发送
            lastUpdatePromise = lastUpdatePromise.then(() => updateFeishuMessage(true));
          }
        }
      };

      agent.on('stream:message', streamHandler);

      try {
        // 使用流式执行方法
        logger.info('Calling agent.executeStreaming', { sessionId: session.id, contentPreview: ctx.content.substring(0, 50) });
        // 使用 --continue 继续对话（保持上下文）
        const messages = await agent.executeStreaming(ctx.content, true);
        logger.info('agent.executeStreaming completed', { messageCount: messages.length });

        // 等待所有之前的更新完成，然后最终更新一次
        await lastUpdatePromise;
        await updateFeishuMessage(true);
      } finally {
        agent.off('stream:message', streamHandler);
      }

      logger.info('Claude agent completed', { responseLength: responseBuffer.length, responsePreview: responseBuffer.substring(0, 300) });

      // 添加助手响应到历史
      if (responseBuffer) {
        this.sessionManager.addMessage(session.id, {
          role: 'assistant',
          content: responseBuffer,
        });
      }

      // 发送最终响应到飞书
      const finalText = truncateMessage(responseBuffer || '✅ 任务完成');
      logger.info('Sending final response to Feishu', { chatId: ctx.chatId, messageLength: finalText.length });

      if (progressMessageId) {
        try {
          // 尝试更新为富文本格式
          await this.feishuClient.updateMessageToMarkdown(progressMessageId, finalText);
          logger.info('Feishu message updated successfully', { messageId: progressMessageId });
        } catch (updateError) {
          // 更新失败（可能达到编辑次数上限），发送新消息
          logger.warn('Failed to update message, sending new one', { error: String(updateError) });
          try {
            const sendResult = await this.feishuClient.sendMarkdownMessage(
              ctx.chatId,
              finalText,
              { replyToMessageId: ctx.messageId }
            );
            logger.info('New Feishu message sent successfully', { messageId: sendResult.messageId });
          } catch (sendError) {
            logger.error('Failed to send new message to Feishu', { error: String(sendError) });
          }
        }
      } else {
        try {
          const sendResult = await this.feishuClient.sendMarkdownMessage(
            ctx.chatId,
            finalText,
            { replyToMessageId: ctx.messageId }
          );
          logger.info('Feishu message sent successfully', { messageId: sendResult.messageId });
        } catch (sendError) {
          logger.error('Failed to send message to Feishu', { error: String(sendError) });
        }
      }

      // 保存任务到历史记录
      const updatedSession = this.sessionManager.getSession(ctx.chatId);
      if (updatedSession?.claudeSessionId) {
        this.taskStore.saveTask(
          ctx.chatId,
          session.workingDirectory,
          updatedSession.claudeSessionId,
          ctx.content
        );
        // 更新最后消息
        this.taskStore.updateLastMessage(ctx.chatId, session.workingDirectory, responseBuffer);
      }

      // 记录变更
      const changeRecord = this.changeLogger.createRecord({
        chatId: ctx.chatId,
        workingDirectory: session.workingDirectory,
        userMessage: ctx.content,
        claudeResponse: responseBuffer,
        duration: Date.now() - startTime,
        success: true,
      });
      this.changeLogger.logChange(changeRecord).catch(err => {
        logger.warn('Failed to log change', { error: String(err) });
      });

      // 移除"思考中"表情，添加"完成"表情
      if (thinkingReactionId) {
        try {
          await this.feishuClient.removeReaction(ctx.messageId, thinkingReactionId);
        } catch {
          // 忽略
        }
      }
      try {
        await this.feishuClient.addReaction(ctx.messageId, 'THUMBSUP');
      } catch {
        // 忽略
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Claude processing error', { error: errorMsg });

      // 记录失败的变更
      const changeRecord = this.changeLogger.createRecord({
        chatId: ctx.chatId,
        workingDirectory: session.workingDirectory,
        userMessage: ctx.content,
        claudeResponse: '',
        duration: Date.now() - startTime,
        success: false,
        error: errorMsg,
      });
      this.changeLogger.logChange(changeRecord).catch(err => {
        logger.warn('Failed to log change', { error: String(err) });
      });

      // 移除"思考中"表情
      if (thinkingReactionId) {
        try {
          await this.feishuClient.removeReaction(ctx.messageId, thinkingReactionId);
        } catch {
          // 忽略
        }
      }

      // 添加"错误"表情
      try {
        await this.feishuClient.addReaction(ctx.messageId, 'CROSS');
      } catch {
        // 忽略
      }

      // 发送错误消息
      await this.feishuClient.sendTextMessage(
        ctx.chatId,
        `❌ 处理失败: ${errorMsg}`,
        { replyToMessageId: ctx.messageId }
      );
    } finally {
      // 更新会话状态
      this.sessionManager.updateSession(ctx.chatId, { status: 'idle' });
    }
  }

  /**
   * 获取工具表情符号
   */
  private getToolEmoji(toolName: string): string {
    const emojiMap: Record<string, string> = {
      Read: '📖',
      Write: '✏️',
      Edit: '📝',
      Bash: '💻',
      Glob: '🔍',
      Grep: '🔎',
      WebSearch: '🌐',
      WebFetch: '📡',
      Task: '🤖',
      TodoWrite: '📋',
      AskUserQuestion: '❓',
    };
    return emojiMap[toolName] || '🔧';
  }

  /**
   * 获取工具描述
   */
  private getToolDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Read':
        return `\`${(input.file_path as string)?.split('/').pop() || 'file'}\``;
      case 'Write':
      case 'Edit':
        return `\`${(input.file_path as string)?.split('/').pop() || 'file'}\``;
      case 'Bash':
        const cmd = (input.command as string) || '';
        return `\`${cmd.substring(0, 40)}${cmd.length > 40 ? '...' : ''}\``;
      case 'Glob':
        return `\`${input.pattern || 'pattern'}\``;
      case 'Grep':
        return `\`${input.pattern || 'pattern'}\``;
      case 'WebSearch':
        return `\`${(input.query as string)?.substring(0, 30) || 'query'}\``;
      case 'WebFetch':
        return `\`${(input.url as string)?.substring(0, 40) || 'url'}\``;
      case 'Task':
        return (input.description as string)?.substring(0, 40) || (input.name as string) || 'subtask';
      case 'TodoWrite':
        return '更新任务列表';
      case 'AskUserQuestion':
        return '等待用户输入';
      default:
        return '';
    }
  }
}

/**
 * 创建应用实例
 */
export function createApp(options?: ClaudeClientAppOptions): ClaudeClientApp {
  return new ClaudeClientApp(options);
}
