/**
 * 会话管理器
 *
 * 管理多用户独立上下文的会话
 */

import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionMessage, ToolCallInfo, ClaudePermissionMode } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

export interface SessionManagerOptions {
  timeoutMinutes?: number;
  maxHistoryLength?: number;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private messages: Map<string, SessionMessage[]> = new Map();
  private pendingPermissions: Map<string, ToolCallInfo[]> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private options: Required<SessionManagerOptions>;

  constructor(options: SessionManagerOptions = {}) {
    const config = getConfig();
    this.options = {
      timeoutMinutes: options.timeoutMinutes ?? config.session.timeoutMinutes,
      maxHistoryLength: options.maxHistoryLength ?? config.session.maxHistoryLength,
    };

    // 启动定期清理
    this.startCleanupTimer();
  }

  /**
   * 创建或获取会话
   */
  getOrCreateSession(params: {
    userId: string;
    chatId: string;
    chatType: 'p2p' | 'group';
    workingDirectory?: string;
  }): Session {
    // 使用 chatId 作为会话键 (群聊共享会话)
    const sessionKey = params.chatId;

    let session = this.sessions.get(sessionKey);

    if (!session || this.isSessionExpired(session)) {
      session = {
        id: uuidv4(),
        userId: params.userId,
        chatId: params.chatId,
        chatType: params.chatType,
        workingDirectory: params.workingDirectory ?? process.cwd(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'idle',
      };

      this.sessions.set(sessionKey, session);
      this.messages.set(session.id, []);
      this.pendingPermissions.set(session.id, []);

      logger.info('Session created', {
        sessionId: session.id,
        chatId: params.chatId,
        chatType: params.chatType,
      });
    } else {
      // 更新活动时间
      session.lastActivityAt = Date.now();
      session.updatedAt = Date.now();
    }

    return session;
  }

  /**
   * 获取会话
   */
  getSession(chatId: string): Session | undefined {
    const session = this.sessions.get(chatId);
    if (session && !this.isSessionExpired(session)) {
      return session;
    }
    return undefined;
  }

  /**
   * 通过会话 ID 获取会话
   */
  getSessionById(sessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId && !this.isSessionExpired(session)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * 更新会话
   */
  updateSession(chatId: string, updates: Partial<Session>): Session | undefined {
    const session = this.sessions.get(chatId);
    if (session) {
      Object.assign(session, updates, { updatedAt: Date.now() });
      return session;
    }
    return undefined;
  }

  /**
   * 设置 Claude 会话 ID
   */
  setClaudeSessionId(chatId: string, claudeSessionId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      session.updatedAt = Date.now();
    }
  }

  /**
   * 添加消息到会话历史
   */
  addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'sessionId' | 'timestamp'>): SessionMessage {
    const messages = this.messages.get(sessionId);
    if (!messages) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const sessionMessage: SessionMessage = {
      id: uuidv4(),
      sessionId,
      timestamp: Date.now(),
      ...message,
    };

    messages.push(sessionMessage);

    // 限制历史长度
    if (messages.length > this.options.maxHistoryLength) {
      messages.splice(0, messages.length - this.options.maxHistoryLength);
    }

    return sessionMessage;
  }

  /**
   * 获取会话历史
   */
  getMessageHistory(sessionId: string): SessionMessage[] {
    return this.messages.get(sessionId) ?? [];
  }

  /**
   * 获取最近的消息历史 (用于上下文)
   */
  getRecentHistory(sessionId: string, count?: number): SessionMessage[] {
    const messages = this.messages.get(sessionId) ?? [];
    const limit = count ?? Math.min(this.options.maxHistoryLength, 20);
    return messages.slice(-limit);
  }

  /**
   * 添加待处理权限请求
   */
  addPendingPermission(sessionId: string, toolCall: ToolCallInfo): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (pending) {
      pending.push(toolCall);
    }
  }

  /**
   * 获取待处理权限请求
   */
  getPendingPermissions(sessionId: string): ToolCallInfo[] {
    return this.pendingPermissions.get(sessionId) ?? [];
  }

  /**
   * 更新权限请求状态
   */
  updatePermissionStatus(
    sessionId: string,
    toolCallId: string,
    status: ToolCallInfo['status'],
    result?: string
  ): ToolCallInfo | undefined {
    const pending = this.pendingPermissions.get(sessionId);
    if (pending) {
      const toolCall = pending.find(tc => tc.id === toolCallId);
      if (toolCall) {
        toolCall.status = status;
        if (result !== undefined) {
          toolCall.result = result;
        }
        return toolCall;
      }
    }
    return undefined;
  }

  /**
   * 清除待处理权限请求
   */
  clearPendingPermissions(sessionId: string): void {
    this.pendingPermissions.set(sessionId, []);
  }

  /**
   * 关闭会话
   */
  closeSession(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      this.sessions.delete(chatId);
      this.messages.delete(session.id);
      this.pendingPermissions.delete(session.id);

      logger.info('Session closed', {
        sessionId: session.id,
        chatId,
      });
    }
  }

  /**
   * 检查会话是否过期
   */
  private isSessionExpired(session: Session): boolean {
    const timeoutMs = this.options.timeoutMinutes * 60 * 1000;
    return Date.now() - session.lastActivityAt > timeoutMs;
  }

  /**
   * 启动定期清理计时器
   */
  private startCleanupTimer(): void {
    // 每 5 分钟清理一次过期会话
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const expiredChatIds: string[] = [];

    for (const [chatId, session] of this.sessions) {
      if (this.isSessionExpired(session)) {
        expiredChatIds.push(chatId);
      }
    }

    for (const chatId of expiredChatIds) {
      this.closeSession(chatId);
    }

    if (expiredChatIds.length > 0) {
      logger.debug(`Cleaned up ${expiredChatIds.length} expired sessions`);
    }
  }

  /**
   * 停止会话管理器
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 获取活跃会话数量
   */
  getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!this.isSessionExpired(session)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取所有活跃会话
   */
  getActiveSessions(): Session[] {
    const active: Session[] = [];
    for (const session of this.sessions.values()) {
      if (!this.isSessionExpired(session)) {
        active.push(session);
      }
    }
    return active;
  }
}

// 单例实例
let _sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!_sessionManager) {
    _sessionManager = new SessionManager();
  }
  return _sessionManager;
}

export function resetSessionManager(): void {
  if (_sessionManager) {
    _sessionManager.stop();
    _sessionManager = null;
  }
}
