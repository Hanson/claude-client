/**
 * Git 变更记录器
 * 使用 git 命令记录变更
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IChangeLogger, ChangeRecord, GitLoggerConfig } from './types.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG: GitLoggerConfig = {
  autoCommit: true,
  commitMessageTemplate: 'feat(claude-client): {userMessage}',
  includeDiff: true,
  excludePatterns: ['node_modules', '.git', 'dist', '*.log', 'data/*'],
};

export class GitChangeLogger implements IChangeLogger {
  private config: GitLoggerConfig;
  private recordsDir: string;

  constructor(config: Partial<GitLoggerConfig> = {}, dataDir: string = './data') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.recordsDir = path.join(dataDir, 'change-records');
  }

  async init(): Promise<void> {
    // 确保记录目录存在
    if (!fs.existsSync(this.recordsDir)) {
      fs.mkdirSync(this.recordsDir, { recursive: true });
    }
  }

  async logChange(record: ChangeRecord): Promise<void> {
    try {
      const workDir = record.workingDirectory;

      // 检查是否是 git 仓库
      if (!this.isGitRepo(workDir)) {
        logger.info('Not a git repo, skipping git logging', { workDir });
        await this.saveRecordToFile(record);
        return;
      }

      // 获取变更的文件
      const changedFiles = this.getChangedFiles(workDir);
      record.filesChanged = changedFiles;

      // 获取 diff
      let diff = '';
      if (this.config.includeDiff && changedFiles.length > 0) {
        diff = this.getDiff(workDir);
      }

      // 自动提交
      if (this.config.autoCommit && changedFiles.length > 0) {
        this.commit(workDir, record);
      }

      // 保存记录
      await this.saveRecordToFile(record, diff);

      logger.info('Change logged via git', {
        recordId: record.id,
        filesChanged: changedFiles.length,
      });
    } catch (error) {
      logger.error('Failed to log change via git', { error: String(error) });
    }
  }

  private isGitRepo(dir: string): boolean {
    try {
      execSync('git rev-parse --git-dir', { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  private getChangedFiles(dir: string): string[] {
    try {
      // 获取已修改的文件（包括未暂存的）
      const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' });
      const files = status
        .split('\n')
        .filter(line => line.trim())
        .map(line => line.substring(3).trim())
        .filter(file => !this.shouldExclude(file));
      return files;
    } catch {
      return [];
    }
  }

  private getDiff(dir: string): string {
    try {
      return execSync('git diff HEAD', { cwd: dir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      return '';
    }
  }

  private shouldExclude(file: string): boolean {
    return this.config.excludePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(file);
      }
      return file.includes(pattern);
    });
  }

  private commit(dir: string, record: ChangeRecord): void {
    try {
      // 添加所有变更
      execSync('git add -A', { cwd: dir, encoding: 'utf8' });

      // 生成提交消息
      const message = this.config.commitMessageTemplate
        .replace('{userMessage}', record.userMessage.substring(0, 50))
        .replace('{timestamp}', new Date(record.timestamp).toISOString());

      // 提交
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: dir,
        encoding: 'utf8',
      });

      logger.info('Git commit created', { message: message.substring(0, 50) });
    } catch (error) {
      // 可能是没有变更需要提交
      logger.debug('Git commit skipped or failed', { error: String(error) });
    }
  }

  private async saveRecordToFile(record: ChangeRecord, diff?: string): Promise<void> {
    const recordPath = path.join(this.recordsDir, `${record.id}.json`);
    const recordData = {
      ...record,
      diff: diff || undefined,
    };
    fs.writeFileSync(recordPath, JSON.stringify(recordData, null, 2));
  }

  async getHistory(options: { chatId?: string; limit?: number } = {}): Promise<ChangeRecord[]> {
    if (!fs.existsSync(this.recordsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.recordsDir)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a)); // 按时间倒序

    const records: ChangeRecord[] = [];
    const limit = options.limit || 50;

    for (const file of files.slice(0, limit)) {
      try {
        const content = fs.readFileSync(path.join(this.recordsDir, file), 'utf8');
        const record = JSON.parse(content) as ChangeRecord;
        if (!options.chatId || record.chatId === options.chatId) {
          records.push(record);
        }
      } catch {
        // 忽略解析错误
      }
    }

    return records;
  }
}
