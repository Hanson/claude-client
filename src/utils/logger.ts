/**
 * 日志模块
 */

import winston from 'winston';
import { getConfig } from './config.js';

let _logger: winston.Logger | null = null;

/**
 * 安全地将对象转换为 JSON 字符串，处理循环引用
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    if (obj && typeof obj === 'object') {
      const seen = new WeakSet();
      try {
        return JSON.stringify(
          obj,
          (_key, value) => {
            if (typeof value === 'object' && value !== null) {
              // 处理循环引用
              if (seen.has(value)) {
                return '[Circular]';
              }
              seen.add(value);
            }
            return value;
          },
          2
        );
      } catch {
        return String(obj);
      }
    }
    return String(obj);
  }
}

export function getLogger(): winston.Logger {
  if (!_logger) {
    const config = getConfig();

    _logger = winston.createLogger({
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'claude-client' },
      transports: [
        // 控制台输出
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...metadata }) => {
              let msg = `[${level}] ${message}`;
              if (Object.keys(metadata).length > 0) {
                msg += ` ${safeStringify(metadata)}`;
              }
              return msg;
            })
          ),
        }),
        // 文件输出 (错误日志)
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
        // 文件输出 (所有日志)
        new winston.transports.File({
          filename: 'logs/combined.log',
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
      ],
    });
  }

  return _logger;
}

// 便捷方法
export const logger = {
  debug: (message: string, ...args: unknown[]) => getLogger().debug(message, ...args),
  info: (message: string, ...args: unknown[]) => getLogger().info(message, ...args),
  warn: (message: string, ...args: unknown[]) => getLogger().warn(message, ...args),
  error: (message: string, ...args: unknown[]) => getLogger().error(message, ...args),
};
