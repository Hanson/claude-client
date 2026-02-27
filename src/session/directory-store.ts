/**
 * 目录历史存储管理器
 * 记录用户最近访问的目录
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface DirectoryRecord {
  path: string;
  lastAccessedAt: number;
  accessCount: number;
}

export class DirectoryStore {
  private directories: Map<string, DirectoryRecord> = new Map();
  private storePath: string;
  private maxDirectories: number = 10; // 最多保存10个目录

  constructor(dataDir: string = './data') {
    this.storePath = path.join(dataDir, 'directories.json');
    this.load();
  }

  /**
   * 从文件加载目录历史
   */
  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const directories = JSON.parse(data) as DirectoryRecord[];
        for (const dir of directories) {
          this.directories.set(dir.path, dir);
        }
        logger.info(`Loaded ${this.directories.size} directories from store`);
      }
    } catch (error) {
      logger.error('Failed to load directories', { error });
    }
  }

  /**
   * 保存目录历史到文件
   */
  private save(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const directories = Array.from(this.directories.values());
      fs.writeFileSync(this.storePath, JSON.stringify(directories, null, 2));
    } catch (error) {
      logger.error('Failed to save directories', { error });
    }
  }

  /**
   * 记录目录访问
   */
  recordAccess(directoryPath: string): void {
    const normalizedPath = path.resolve(directoryPath);
    const existing = this.directories.get(normalizedPath);
    const now = Date.now();

    const record: DirectoryRecord = {
      path: normalizedPath,
      lastAccessedAt: now,
      accessCount: (existing?.accessCount || 0) + 1,
    };

    this.directories.set(normalizedPath, record);

    // 如果超过最大数量，删除最旧的
    if (this.directories.size > this.maxDirectories) {
      const sorted = this.getRecentDirectories();
      const toRemove = sorted.slice(this.maxDirectories);
      for (const item of toRemove) {
        this.directories.delete(item.path);
      }
    }

    this.save();
    logger.debug('Directory access recorded', { path: normalizedPath });
  }

  /**
   * 获取最近访问的目录（按访问时间排序）
   */
  getRecentDirectories(limit: number = 5): DirectoryRecord[] {
    return Array.from(this.directories.values())
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, limit);
  }

  /**
   * 删除目录记录
   */
  removeDirectory(directoryPath: string): boolean {
    const normalizedPath = path.resolve(directoryPath);
    const deleted = this.directories.delete(normalizedPath);
    if (deleted) {
      this.save();
      logger.info('Directory removed from history', { path: normalizedPath });
    }
    return deleted;
  }

  /**
   * 清空所有记录
   */
  clear(): void {
    this.directories.clear();
    this.save();
    logger.info('Directory history cleared');
  }
}
