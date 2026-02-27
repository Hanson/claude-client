/**
 * 变更记录管理器
 * 管理多个记录器，根据配置选择记录方式
 */

import fs from 'fs';
import path from 'path';
import type { IChangeLogger, ChangeRecord, ChangeLoggerConfig } from './types.js';
import { GitChangeLogger } from './git-logger.js';
import { FeishuDocChangeLogger } from './feishu-doc-logger.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG: ChangeLoggerConfig = {
  enabled: true,
  type: 'git',
  git: {
    autoCommit: false, // 默认不自动提交，避免意外提交
    commitMessageTemplate: 'feat(claude-client): {userMessage}',
    includeDiff: true,
    excludePatterns: ['node_modules', '.git', 'dist', '*.log', 'data/*'],
  },
  feishuDoc: {
    documentId: '',
    appendToEnd: true,
    formatTemplate: '',
  },
};

/**
 * 控制台记录器（用于调试）
 */
class ConsoleChangeLogger implements IChangeLogger {
  async logChange(record: ChangeRecord): Promise<void> {
    console.log('\n========== 变更记录 ==========');
    console.log(`ID: ${record.id}`);
    console.log(`时间: ${new Date(record.timestamp).toLocaleString('zh-CN')}`);
    console.log(`目录: ${record.workingDirectory}`);
    console.log(`用户: ${record.userMessage.substring(0, 100)}`);
    console.log(`状态: ${record.success ? '成功' : '失败'}`);
    console.log(`变更文件: ${record.filesChanged.length} 个`);
    record.filesChanged.forEach(f => console.log(`  - ${f}`));
    console.log('==============================\n');
  }
}

export class ChangeLoggerManager {
  private config: ChangeLoggerConfig;
  private loggers: IChangeLogger[] = [];
  private dataDir: string;
  private feishuClient: any;

  constructor(config: Partial<ChangeLoggerConfig> = {}, dataDir: string = './data') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataDir = dataDir;
  }

  /**
   * 设置飞书客户端
   */
  setFeishuClient(client: any): void {
    this.feishuClient = client;
  }

  /**
   * 初始化管理器
   */
  async init(): Promise<void> {
    if (!this.config.enabled || this.config.type === 'none') {
      logger.info('Change logger disabled');
      return;
    }

    // 根据配置创建记录器
    switch (this.config.type) {
      case 'git':
        this.loggers.push(new GitChangeLogger(this.config.git || {}, this.dataDir));
        break;

      case 'feishu-doc':
        const feishuLogger = new FeishuDocChangeLogger(this.config.feishuDoc || {}, this.feishuClient);
        this.loggers.push(feishuLogger);
        break;

      case 'console':
        this.loggers.push(new ConsoleChangeLogger());
        break;
    }

    // 初始化所有记录器
    for (const logger of this.loggers) {
      if (logger.init) {
        await logger.init();
      }
    }

    logger.info('Change logger manager initialized', { type: this.config.type });
  }

  /**
   * 记录变更
   */
  async logChange(record: ChangeRecord): Promise<void> {
    if (!this.config.enabled || this.loggers.length === 0) {
      return;
    }

    // 并行调用所有记录器
    await Promise.allSettled(
      this.loggers.map(logger => logger.logChange(record))
    );
  }

  /**
   * 创建变更记录
   */
  createRecord(params: {
    chatId: string;
    workingDirectory: string;
    userMessage: string;
    claudeResponse: string;
    filesChanged?: string[];
    duration: number;
    success: boolean;
    error?: string;
  }): ChangeRecord {
    return {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      chatId: params.chatId,
      workingDirectory: params.workingDirectory,
      userMessage: params.userMessage,
      claudeResponse: params.claudeResponse,
      filesChanged: params.filesChanged || [],
      timestamp: Date.now(),
      duration: params.duration,
      success: params.success,
      error: params.error,
    };
  }

  /**
   * 获取变更历史
   */
  async getHistory(options?: { chatId?: string; limit?: number }): Promise<ChangeRecord[]> {
    for (const logger of this.loggers) {
      if (logger.getHistory) {
        return logger.getHistory(options || {});
      }
    }
    return [];
  }

  /**
   * 关闭管理器
   */
  async close(): Promise<void> {
    for (const logger of this.loggers) {
      if (logger.close) {
        await logger.close();
      }
    }
  }

  /**
   * 从文件加载配置
   */
  static loadConfig(configPath: string = './data/change-logger-config.json'): ChangeLoggerConfig {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        return { ...DEFAULT_CONFIG, ...config };
      }
    } catch (error) {
      logger.warn('Failed to load change logger config, using defaults', { error: String(error) });
    }
    return DEFAULT_CONFIG;
  }

  /**
   * 保存配置到文件
   */
  static saveConfig(config: ChangeLoggerConfig, configPath: string = './data/change-logger-config.json'): void {
    try {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      logger.info('Change logger config saved', { path: configPath });
    } catch (error) {
      logger.error('Failed to save change logger config', { error: String(error) });
    }
  }
}
