/**
 * 配置管理模块
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import type { AppConfig, FeishuDomain, ClaudePermissionMode } from '../types/index.js';

// 加载环境变量
dotenvConfig({ path: resolve(process.cwd(), '.env') });

function getEnvString(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return num;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value === 'true' || value === '1';
}

function parseFeishuDomain(value: string): FeishuDomain {
  if (value === 'feishu' || value === 'lark') {
    return value;
  }
  throw new Error(`Invalid FEISHU_DOMAIN: ${value}. Must be 'feishu' or 'lark'`);
}

function parsePermissionMode(value: string): ClaudePermissionMode {
  const validModes: ClaudePermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
  if (validModes.includes(value as ClaudePermissionMode)) {
    return value as ClaudePermissionMode;
  }
  throw new Error(`Invalid permission mode: ${value}. Must be one of: ${validModes.join(', ')}`);
}

function parseLogLevel(value: string): 'debug' | 'info' | 'warn' | 'error' {
  const validLevels = ['debug', 'info', 'warn', 'error'] as const;
  if (validLevels.includes(value as typeof validLevels[number])) {
    return value as typeof validLevels[number];
  }
  throw new Error(`Invalid log level: ${value}. Must be one of: ${validLevels.join(', ')}`);
}

export function loadConfig(): AppConfig {
  return {
    feishu: {
      appId: getEnvString('FEISHU_APP_ID'),
      appSecret: getEnvString('FEISHU_APP_SECRET'),
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      domain: parseFeishuDomain(getEnvString('FEISHU_DOMAIN', 'feishu')),
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultModel: process.env.CLAUDE_DEFAULT_MODEL,
      defaultPermissionMode: parsePermissionMode(getEnvString('CLAUDE_PERMISSION_MODE', 'acceptEdits')),
      allowedTools: getEnvString('CLAUDE_ALLOWED_TOOLS', 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
    },
    server: {
      port: getEnvNumber('PORT', 3000),
      host: getEnvString('HOST', '0.0.0.0'),
    },
    session: {
      timeoutMinutes: getEnvNumber('SESSION_TIMEOUT_MINUTES', 30),
      maxHistoryLength: getEnvNumber('MAX_HISTORY_LENGTH', 50),
    },
    logging: {
      level: parseLogLevel(getEnvString('LOG_LEVEL', 'info')),
    },
  };
}

// 单例配置实例
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
