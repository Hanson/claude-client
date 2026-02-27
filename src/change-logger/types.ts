/**
 * 变更记录类型定义
 */

/**
 * 变更记录
 */
export interface ChangeRecord {
  id: string;
  chatId: string;
  workingDirectory: string;
  userMessage: string;
  claudeResponse: string;
  filesChanged: string[];
  timestamp: number;
  duration: number;
  success: boolean;
  error?: string;
}

/**
 * 变更记录器配置
 */
export interface ChangeLoggerConfig {
  enabled: boolean;
  type: 'git' | 'feishu-doc' | 'console' | 'none';
  git?: GitLoggerConfig;
  feishuDoc?: FeishuDocLoggerConfig;
}

/**
 * Git 记录器配置
 */
export interface GitLoggerConfig {
  /** 是否自动提交 */
  autoCommit: boolean;
  /** 提交消息模板 */
  commitMessageTemplate: string;
  /** 是否包含 diff */
  includeDiff: boolean;
  /** 排除的文件模式 */
  excludePatterns: string[];
}

/**
 * 飞书文档记录器配置
 */
export interface FeishuDocLoggerConfig {
  /** 飞书文档 ID */
  documentId: string;
  /** 是否追加到文档末尾 */
  appendToEnd: boolean;
  /** 记录格式模板 */
  formatTemplate: string;
}

/**
 * 变更记录器接口
 */
export interface IChangeLogger {
  /**
   * 记录变更
   */
  logChange(record: ChangeRecord): Promise<void>;

  /**
   * 获取变更历史
   */
  getHistory?(options: { chatId?: string; limit?: number }): Promise<ChangeRecord[]>;

  /**
   * 初始化
   */
  init?(): Promise<void>;

  /**
   * 关闭
   */
  close?(): Promise<void>;
}
