/**
 * 飞书文档变更记录器
 * 将变更记录写入飞书文档
 */

import type { IChangeLogger, ChangeRecord, FeishuDocLoggerConfig } from './types.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG: FeishuDocLoggerConfig = {
  documentId: '',
  appendToEnd: true,
  formatTemplate: `## 📝 变更记录 - {date}

**用户消息:** {userMessage}

**工作目录:** \`{workingDirectory}\`

**执行时长:** {duration}秒

**状态:** {status}

**变更文件:**
{filesList}

**Claude 响应:**
> {claudeResponse}

---

`,
};

export class FeishuDocChangeLogger implements IChangeLogger {
  private config: FeishuDocLoggerConfig;
  private feishuClient: any; // FeishuClient 类型
  private pendingRecords: ChangeRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<FeishuDocLoggerConfig>, feishuClient?: any) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.feishuClient = feishuClient;
  }

  setFeishuClient(client: any): void {
    this.feishuClient = client;
  }

  async init(): Promise<void> {
    if (!this.config.documentId) {
      logger.warn('Feishu doc logger enabled but no document ID configured');
    }
  }

  async logChange(record: ChangeRecord): Promise<void> {
    if (!this.feishuClient || !this.config.documentId) {
      logger.warn('Feishu doc logger not properly configured, skipping');
      return;
    }

    try {
      const content = this.formatRecord(record);
      await this.appendToDocument(content);

      logger.info('Change logged to Feishu doc', {
        recordId: record.id,
        documentId: this.config.documentId,
      });
    } catch (error) {
      logger.error('Failed to log change to Feishu doc', { error: String(error) });
    }
  }

  private formatRecord(record: ChangeRecord): string {
    const filesList = record.filesChanged.length > 0
      ? record.filesChanged.map(f => `- \`${f}\``).join('\n')
      : '- 无文件变更';

    return this.config.formatTemplate
      .replace('{date}', new Date(record.timestamp).toLocaleString('zh-CN'))
      .replace('{userMessage}', record.userMessage.substring(0, 200))
      .replace('{workingDirectory}', record.workingDirectory)
      .replace('{duration}', Math.floor(record.duration / 1000).toString())
      .replace('{status}', record.success ? '✅ 成功' : '❌ 失败')
      .replace('{filesList}', filesList)
      .replace('{claudeResponse}', record.claudeResponse.substring(0, 500));
  }

  private async appendToDocument(content: string): Promise<void> {
    if (!this.feishuClient) {
      throw new Error('Feishu client not set');
    }

    // 使用飞书文档 API 追加内容
    // 注意：这里需要飞书文档 API 的具体实现
    // 参考: https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document

    try {
      // 由于飞书文档 API 比较复杂，这里使用简化版本
      // 实际实现需要调用飞书文档的 blocks API

      logger.debug('Appending to Feishu document', {
        documentId: this.config.documentId,
        contentLength: content.length,
      });

      // 如果有具体的飞书文档 API，可以这样调用：
      // await this.feishuClient.docx.documents.blocks.create({
      //   document_id: this.config.documentId,
      //   data: { ... }
      // });

      // 临时方案：记录到日志
      logger.info('Feishu doc content (not implemented)', { content: content.substring(0, 200) });
    } catch (error) {
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
