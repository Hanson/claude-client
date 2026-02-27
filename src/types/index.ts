/**
 * 核心类型定义
 */

// ============ 飞书相关类型 ============

export type FeishuDomain = 'feishu' | 'lark';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
}

export interface FeishuMessageContext {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  chatType: 'p2p' | 'group';
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
}

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export interface FeishuSendResult {
  messageId: string;
  chatId: string;
}

// 飞书卡片按钮点击事件
export interface FeishuCardActionEvent {
  open_message_id: string;
  open_chat_id: string;
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  action: {
    value: Record<string, unknown>;
  };
  token?: string;
}

// ============ Claude Agent SDK 类型 ============

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface ClaudeSessionOptions {
  workingDirectory: string;
  permissionMode: ClaudePermissionMode;
  allowedTools?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  systemPrompt?: string;
  model?: string;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
}

// Claude Agent SDK 消息类型
export type ClaudeMessageType = 'system' | 'assistant' | 'user' | 'result';

export interface ClaudeMessage {
  type: ClaudeMessageType;
  subtype?: string;
  content?: unknown;
  session_id?: string;
}

export interface ClaudeAssistantMessage extends ClaudeMessage {
  type: 'assistant';
  content: AssistantContentBlock[];
}

export interface ClaudeResultMessage extends ClaudeMessage {
  type: 'result';
  subtype: 'success' | 'error' | 'error_during_execution';
  result?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
}

export interface ClaudeSystemMessage extends ClaudeMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  mcp_servers?: MCPServerStatus[];
}

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface MCPServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'pending';
  error?: string;
}

// ============ 会话管理类型 ============

export interface Session {
  id: string;
  userId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  claudeSessionId?: string;
  workingDirectory: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  status: 'idle' | 'processing' | 'waiting_permission';
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    toolCalls?: ToolCallInfo[];
    thinking?: string;
  };
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'executing' | 'completed' | 'failed';
  result?: string;
}

// ============ 应用配置类型 ============

export interface AppConfig {
  feishu: FeishuConfig;
  claude: {
    apiKey?: string;
    defaultModel?: string;
    defaultPermissionMode: ClaudePermissionMode;
    allowedTools: string[];
  };
  server: {
    port: number;
    host: string;
  };
  session: {
    timeoutMinutes: number;
    maxHistoryLength: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

// ============ 权限请求类型 ============

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied';
  mode?: ClaudePermissionMode;
  allowedTools?: string[];
}

// ============ 事件类型 ============

export type AppEventType =
  | 'message_received'
  | 'message_sent'
  | 'session_created'
  | 'session_closed'
  | 'claude_thinking'
  | 'claude_tool_call'
  | 'permission_request'
  | 'permission_response'
  | 'error';

export interface AppEvent {
  type: AppEventType;
  timestamp: number;
  data: unknown;
}
