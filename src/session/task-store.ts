/**
 * 任务存储管理器
 * 保存会话历史，支持任务恢复
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface SavedTask {
  id: string;
  chatId: string;
  workingDirectory: string;
  claudeSessionId: string;
  lastMessage: string;
  createdAt: number;
  updatedAt: number;
}

export class TaskStore {
  private tasks: Map<string, SavedTask> = new Map();
  private storePath: string;
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string = './data') {
    this.storePath = path.join(dataDir, 'tasks.json');
    this.load();
  }

  /**
   * 从文件加载任务
   */
  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const tasks = JSON.parse(data) as SavedTask[];
        for (const task of tasks) {
          this.tasks.set(task.id, task);
        }
        logger.info(`Loaded ${this.tasks.size} tasks from store`);
      }
    } catch (error) {
      logger.error('Failed to load tasks', { error });
    }
  }

  /**
   * 保存任务到文件
   */
  private save(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tasks = Array.from(this.tasks.values());
      fs.writeFileSync(this.storePath, JSON.stringify(tasks, null, 2));
    } catch (error) {
      logger.error('Failed to save tasks', { error });
    }
  }

  /**
   * 生成任务 ID
   */
  private generateTaskId(chatId: string, workingDirectory: string): string {
    // 使用 chatId 和目录的组合作为 ID
    const normalizedDir = workingDirectory.replace(/[\\/:]/g, '_');
    return `${chatId}::${normalizedDir}`;
  }

  /**
   * 保存或更新任务
   */
  saveTask(
    chatId: string,
    workingDirectory: string,
    claudeSessionId: string,
    lastMessage: string = ''
  ): SavedTask {
    const id = this.generateTaskId(chatId, workingDirectory);
    const now = Date.now();

    const existingTask = this.tasks.get(id);
    const task: SavedTask = {
      id,
      chatId,
      workingDirectory,
      claudeSessionId,
      lastMessage: lastMessage || existingTask?.lastMessage || '',
      createdAt: existingTask?.createdAt || now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    this.save();

    logger.debug('Task saved', { taskId: id, workingDirectory, claudeSessionId });
    return task;
  }

  /**
   * 更新任务的最后消息
   */
  updateLastMessage(chatId: string, workingDirectory: string, lastMessage: string): void {
    const id = this.generateTaskId(chatId, workingDirectory);
    const task = this.tasks.get(id);
    if (task) {
      task.lastMessage = lastMessage.substring(0, 200);
      task.updatedAt = Date.now();
      this.save();
    }
  }

  /**
   * 获取任务
   */
  getTask(chatId: string, workingDirectory: string): SavedTask | undefined {
    const id = this.generateTaskId(chatId, workingDirectory);
    return this.tasks.get(id);
  }

  /**
   * 获取聊天的所有任务
   */
  getTasksByChat(chatId: string): SavedTask[] {
    const tasks: SavedTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.chatId === chatId) {
        tasks.push(task);
      }
    }
    return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 删除任务
   */
  deleteTask(chatId: string, workingDirectory: string): boolean {
    const id = this.generateTaskId(chatId, workingDirectory);
    const deleted = this.tasks.delete(id);
    if (deleted) {
      this.save();
      logger.info('Task deleted', { taskId: id });
    }
    return deleted;
  }

  /**
   * 清除聊天的所有任务
   */
  clearChatTasks(chatId: string): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.chatId === chatId) {
        this.tasks.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.save();
      logger.info('Cleared tasks for chat', { chatId, count });
    }
    return count;
  }

  /**
   * 获取任务数量
   */
  getTaskCount(chatId: string): number {
    return this.getTasksByChat(chatId).length;
  }
}
