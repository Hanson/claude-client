#!/usr/bin/env node

/**
 * Claude Client CLI 入口
 */

import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { createApp } from './app.js';
import { getConfig } from './utils/config.js';
import { checkClaudeAvailable } from './claude/index.js';

// 加载环境变量
dotenvConfig({ path: resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  try {
    switch (command) {
      case 'start':
        await startServer();
        break;

      case 'config':
        showConfig();
        break;

      case 'check':
        await checkClaude();
        break;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        showHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function startServer(): Promise<void> {
  const workingDir = args[1] ? resolve(args[1]) : process.cwd();

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🤖 Claude Client - 飞书远程控制 Claude Code                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  console.log(`📁 工作目录: ${workingDir}`);
  console.log('');

  // 检查 Claude CLI 是否可用
  console.log('🔍 检查 Claude Code CLI...');
  const claudeCheck = await checkClaudeAvailable();
  if (!claudeCheck.available) {
    console.error('❌ Claude Code CLI 不可用!');
    console.error('');
    console.error('请先安装 Claude Code CLI:');
    console.error('  macOS/Linux: brew install claude');
    console.error('  或访问: https://docs.anthropic.com/en/docs/claude-code');
    console.error('');
    console.error(`错误: ${claudeCheck.error}`);
    process.exit(1);
  }
  console.log(`✅ Claude Code CLI 可用 (${claudeCheck.version})`);
  console.log('');

  const app = createApp({ workingDirectory: workingDir });

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal} 信号，正在关闭...`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.start();

  console.log('');
  console.log('🚀 服务已启动!');
  console.log('');
  console.log('使用方法:');
  console.log('  1. 在飞书中找到机器人');
  console.log('  2. 发送消息给机器人 (群聊需要 @ 机器人)');
  console.log('  3. Claude 会帮你处理任务');
  console.log('');
  console.log('按 Ctrl+C 停止服务');
  console.log('');
}

function showConfig(): void {
  try {
    const config = getConfig();

    console.log('当前配置:\n');
    console.log('飞书配置:');
    console.log(`  App ID: ${config.feishu.appId}`);
    console.log(`  域名: ${config.feishu.domain}`);
    console.log('');
    console.log('Claude 配置:');
    console.log(`  默认模型: ${config.claude.defaultModel || '默认'}`);
    console.log(`  权限模式: ${config.claude.defaultPermissionMode}`);
    console.log(`  允许工具: ${config.claude.allowedTools.join(', ')}`);
    console.log('');
    console.log('服务器配置:');
    console.log(`  地址: ${config.server.host}:${config.server.port}`);
    console.log('');
    console.log('会话配置:');
    console.log(`  超时: ${config.session.timeoutMinutes} 分钟`);
    console.log(`  最大历史: ${config.session.maxHistoryLength} 条`);
  } catch (error) {
    console.error('加载配置失败:', error instanceof Error ? error.message : error);
    console.log('\n请确保已创建 .env 文件，可以参考 .env.example');
  }
}

async function checkClaude(): Promise<void> {
  console.log('🔍 检查 Claude Code CLI...\n');

  const result = await checkClaudeAvailable();

  if (result.available) {
    console.log('✅ Claude Code CLI 可用');
    console.log(`   版本: ${result.version}`);
  } else {
    console.log('❌ Claude Code CLI 不可用');
    console.log(`   错误: ${result.error}`);
    console.log('');
    console.log('安装方法:');
    console.log('  macOS/Linux: brew install claude');
    console.log('  或访问: https://docs.anthropic.com/en/docs/claude-code');
  }
}

function showHelp(): void {
  console.log(`
Claude Client - 通过飞书远程控制本地 Claude Code

用法: claude-client <command> [options]

命令:
  start [directory]    启动服务
                       directory - 工作目录 (默认: 当前目录)
  config               显示当前配置
  check                检查 Claude Code CLI 是否可用
  help                 显示帮助信息

选项:
  -h, --help           显示帮助信息

前置要求:
  1. 安装 Claude Code CLI
     macOS/Linux: brew install claude
     或访问: https://docs.anthropic.com/en/docs/claude-code

  2. 配置 Claude Code
     在终端运行: claude
     按提示完成登录和 API 密钥配置

环境变量:
  FEISHU_APP_ID        飞书应用 ID
  FEISHU_APP_SECRET    飞书应用密钥
  FEISHU_DOMAIN        飞书域名 (feishu 或 lark)
  ANTHROPIC_API_KEY    Claude API 密钥 (通常由 CLI 管理)

示例:
  claude-client check                   # 检查 CLI 是否可用
  claude-client start                   # 在当前目录启动
  claude-client start /path/to/project  # 在指定目录启动
  claude-client config                  # 查看配置

更多信息请访问: https://github.com/your-repo/claude-client
  `);
}

// 运行 CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
