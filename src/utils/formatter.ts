/**
 * 消息格式化和转换工具
 */

import type { ClaudeMessage, ClaudeAssistantMessage, ClaudeResultMessage, SessionMessage } from '../types/index.js';

/**
 * 将 Claude 消息转换为飞书消息格式
 */
export function formatClaudeMessageForFeishu(message: ClaudeMessage): string {
  switch (message.type) {
    case 'assistant':
      return formatAssistantMessage(message as ClaudeAssistantMessage);

    case 'result': {
      const resultMsg = message as ClaudeResultMessage;
      // 只显示状态信息，不重复显示内容（内容已通过 assistant 消息显示）
      if (resultMsg.subtype === 'success') {
        return `✅ 任务完成`;
      } else {
        return `❌ 任务失败`;
      }
    }

    default:
      return '';
  }
}

/**
 * 格式化助手消息
 */
function formatAssistantMessage(message: ClaudeAssistantMessage): string {
  const parts: string[] = [];

  if (message.content) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text);
          break;

        case 'thinking':
          // 可选：显示思考过程
          // parts.push(`💭 *思考中...*\n${block.thinking}`);
          break;

        case 'tool_use':
          parts.push(formatToolCall(block.id, block.name, block.input));
          break;
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * 格式化工具调用
 */
function formatToolCall(id: string, name: string, input: Record<string, unknown>): string {
  const toolEmoji = getToolEmoji(name);
  const description = getToolDescription(name, input);

  return `${toolEmoji} **${name}**\n${description}`;
}

/**
 * 获取工具表情符号
 */
function getToolEmoji(toolName: string): string {
  const emojiMap: Record<string, string> = {
    Read: '📖',
    Write: '✏️',
    Edit: '📝',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    WebSearch: '🌐',
    WebFetch: '📡',
    Task: '🤖',
  };

  return emojiMap[toolName] || '🔧';
}

/**
 * 获取工具描述
 */
function getToolDescription(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `读取文件: \`${input.file_path || input.file || 'unknown'}\``;

    case 'Write':
      return `写入文件: \`${input.file_path || input.file || 'unknown'}\``;

    case 'Edit':
      return `编辑文件: \`${input.file_path || input.file || 'unknown'}\``;

    case 'Bash':
      return `执行命令: \`${(input.command as string)?.substring(0, 50) || 'unknown'}\``;

    case 'Glob':
      return `搜索文件: \`${input.pattern || 'unknown'}\``;

    case 'Grep':
      return `搜索内容: \`${input.pattern || 'unknown'}\``;

    case 'WebSearch':
      return `搜索网络: \`${(input.query as string)?.substring(0, 50) || 'unknown'}\``;

    case 'WebFetch':
      return `获取网页: \`${(input.url as string)?.substring(0, 50) || 'unknown'}\``;

    case 'Task':
      return `子任务: ${(input.description as string)?.substring(0, 50) || (input.prompt as string)?.substring(0, 50) || 'unknown'}`;

    default:
      return `\`\`\`json\n${JSON.stringify(input, null, 2).substring(0, 200)}\n\`\`\``;
  }
}

/**
 * 格式化会话历史为上下文字符串
 */
export function formatHistoryForContext(messages: SessionMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  const parts: string[] = ['--- 对话历史 ---'];

  for (const msg of messages) {
    const role = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 助手' : '系统';
    const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    parts.push(`[${time}] ${role}:`);
    parts.push(msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : ''));
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * 截断消息以适应飞书消息长度限制
 */
export function truncateMessage(message: string, maxLength: number = 4000): string {
  if (message.length <= maxLength) {
    return message;
  }

  // 尝试在句子边界截断
  const truncated = message.substring(0, maxLength);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('\n')
  );

  if (lastPeriod > maxLength * 0.8) {
    return truncated.substring(0, lastPeriod + 1) + '\n\n... (消息过长，已截断)';
  }

  return truncated + '\n\n... (消息过长，已截断)';
}

/**
 * 检测消息中的特殊命令
 */
export function detectSpecialCommand(message: string): { type: string; args: string } | null {
  const trimmed = message.trim();

  // /clear - 清除会话
  if (trimmed === '/clear' || trimmed === '/reset') {
    return { type: 'clear', args: '' };
  }

  // /status - 查看状态
  if (trimmed === '/status') {
    return { type: 'status', args: '' };
  }

  // /pwd - 查看当前目录
  if (trimmed === '/pwd') {
    return { type: 'pwd', args: '' };
  }

  // /help - 帮助 (支持 ?, ??, /?, /help, 中文问号)
  if (trimmed === '/help' || trimmed === '/?' || trimmed === '?' || trimmed === '？' || trimmed === '??' || trimmed === '？？') {
    return { type: 'help', args: '' };
  }

  // /cd - 切换目录
  const cdMatch = trimmed.match(/^\/cd\s+(.+)$/);
  if (cdMatch) {
    return { type: 'cd', args: cdMatch[1] };
  }

  // /mode - 切换权限模式
  const modeMatch = trimmed.match(/^\/mode\s+(.+)$/);
  if (modeMatch) {
    return { type: 'mode', args: modeMatch[1] };
  }

  // /tasklist - 查看任务列表
  if (trimmed === '/tasklist' || trimmed === '/tasks') {
    return { type: 'tasklist', args: '' };
  }

  // /resume - 恢复任务
  const resumeMatch = trimmed.match(/^\/resume\s+(.+)$/);
  if (resumeMatch) {
    return { type: 'resume', args: resumeMatch[1] };
  }

  // /taskdelete - 删除任务
  const taskDeleteMatch = trimmed.match(/^\/taskdelete\s+(.+)$/);
  if (taskDeleteMatch) {
    return { type: 'taskdelete', args: taskDeleteMatch[1] };
  }

  return null;
}

/**
 * 目录记录接口
 */
export interface DirectoryRecord {
  path: string;
  lastAccessedAt: number;
  accessCount: number;
}

/**
 * 生成帮助卡片（带按钮，可点击发送命令）
 */
export function generateHelpCard(
  currentDirectory?: string,
  recentDirectories: DirectoryRecord[] = []
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  // 基本介绍
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '直接发送消息给机器人，Claude 会帮你处理任务。',
    },
  });

  // 当前目录
  if (currentDirectory) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📍 **当前目录**\n\`${currentDirectory}\``,
      },
    });
  }

  // 最近访问的目录
  if (recentDirectories.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**🔥 热门目录**',
      },
    });

    for (const dir of recentDirectories) {
      const dirName = dir.path.split(/[\\/]/).pop() || dir.path;
      const timeStr = new Date(dir.lastAccessedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: `📁 ${dirName}`,
            },
            type: 'default',
            value: {
              command: `/cd ${dir.path}`,
            },
          },
        ],
      });
    }
  }

  // 目录管理
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '**📁 目录管理**',
    },
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '查看当前目录',
        },
        type: 'default',
        value: {
          command: '/pwd',
        },
      },
    ],
  });

  // 会话管理
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '**💬 会话管理**',
    },
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '清除上下文',
        },
        type: 'default',
        value: {
          command: '/clear',
        },
      },
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '查看状态',
        },
        type: 'default',
        value: {
          command: '/status',
        },
      },
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '上下文列表',
        },
        type: 'primary',
        value: {
          command: '/tasklist',
        },
      },
    ],
  });

  // 权限模式
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '**⚙️ 权限模式**',
    },
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '默认',
        },
        type: 'default',
        value: {
          command: '/mode default',
        },
      },
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '自动编辑',
        },
        type: 'primary',
        value: {
          command: '/mode acceptEdits',
        },
      },
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '跳过权限',
        },
        type: 'danger',
        value: {
          command: '/mode bypassPermissions',
        },
      },
    ],
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: '计划模式',
        },
        type: 'default',
        value: {
          command: '/mode plan',
        },
      },
    ],
  });

  // 提示
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '💡 群聊中需要 @ 机器人才能触发响应\n📝 切换目录: `/cd <目录路径>`',
    },
  });

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: 'Claude Client 使用指南',
      },
      template: 'blue',
    },
    elements,
  };
}

/**
 * 生成帮助消息（纯文本格式）
 */
export function generateHelpMessage(): string {
  return `🤖 **Claude Client 使用指南**

**基本用法:**
直接发送消息给机器人，Claude 会帮你处理任务。

**目录管理:**
• \`/cd <目录>\` - 切换工作目录（同时清除上下文）
• \`/pwd\` - 查看当前工作目录

**会话管理:**
• \`/clear\` - 清除当前会话上下文
• \`/status\` - 查看会话状态

**权限模式:**
• \`/mode <模式>\` - 切换权限模式
  - \`acceptEdits\`: 自动批准文件编辑
  - \`bypassPermissions\`: 跳过所有权限检查
  - \`default\`: 需要手动批准

**其他:**
• \`/help\` - 显示此帮助信息

**示例:**
\`\`\`
/cd D:/code/myproject
读取 src/index.ts 文件
在当前目录创建一个新的 Python 文件
\`\`\`

**注意:**
• 群聊中需要 @ 机器人才能触发响应
• 工作目录设置会持久保存，不会随会话过期重置
`;
}

/**
 * 任务信息接口
 */
export interface TaskInfo {
  id: string;
  workingDirectory: string;
  claudeSessionId: string;
  lastMessage: string;
  updatedAt: number;
}

/**
 * 生成任务列表卡片（只显示当前目录的上下文）
 */
export function generateTaskListCard(
  tasks: TaskInfo[],
  currentDirectory?: string
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  // 只显示当前目录的任务
  const currentDirTasks = tasks.filter(t => t.workingDirectory === currentDirectory);

  // 显示当前目录
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `📁 **${currentDirectory || '未知目录'}**`,
    },
  });

  if (currentDirTasks.length === 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '暂无上下文记录\n\n💡 开始新对话后，上下文会自动保存在这里',
      },
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📋 **上下文列表** (${currentDirTasks.length}个)`,
      },
    });

    for (const task of currentDirTasks) {
      const timeStr = new Date(task.updatedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${task.lastMessage ? task.lastMessage.substring(0, 100) + (task.lastMessage.length > 100 ? '...' : '') : '无最近消息'}`,
        },
      });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '恢复上下文',
            },
            type: 'primary',
            value: {
              command: `/resume ${task.workingDirectory}`,
              sessionId: task.claudeSessionId,
            },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '删除',
            },
            type: 'danger',
            value: {
              command: `/taskdelete ${task.workingDirectory}`,
            },
          },
        ],
      });
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `🕐 ${timeStr}`,
        },
      });
    }
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '📋 上下文列表',
      },
      template: 'blue',
    },
    elements,
  };
}
