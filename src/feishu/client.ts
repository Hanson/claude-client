/**
 * 飞书客户端模块
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig, FeishuDomain, FeishuMessageContext, FeishuMessageEvent, FeishuSendResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

function resolveDomain(domain: FeishuDomain): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export class FeishuClient {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private config: FeishuConfig;
  private botOpenId: string | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: resolveDomain(config.domain),
    });
  }

  /**
   * 获取原生 Lark 客户端
   */
  getNativeClient(): Lark.Client {
    return this.client;
  }

  /**
   * 创建 WebSocket 客户端 (用于长连接)
   */
  createWSClient(): Lark.WSClient {
    if (!this.wsClient) {
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: resolveDomain(this.config.domain),
        loggerLevel: Lark.LoggerLevel.info,
      });
    }
    return this.wsClient;
  }

  /**
   * 获取机器人信息
   */
  async getBotInfo(): Promise<{ botOpenId: string; botName: string }> {
    try {
      // 使用 bot/v3/info API 获取机器人信息
      const response = await (this.client as unknown as { request: (opts: { method: string; url: string; data: Record<string, unknown> }) => Promise<{ code: number; msg?: string; bot?: { open_id?: string; bot_name?: string }; data?: { bot?: { open_id?: string; bot_name?: string } } }> }).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });

      if (response.code !== 0) {
        throw new Error(`Failed to get bot info: ${response.msg || `code ${response.code}`}`);
      }

      const bot = response.bot || response.data?.bot;
      this.botOpenId = bot?.open_id ?? null;
      return {
        botOpenId: bot?.open_id ?? '',
        botName: bot?.bot_name ?? '',
      };
    } catch (error) {
      logger.error('Failed to get bot info', error);
      throw error;
    }
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(
    to: string,
    text: string,
    options?: { replyToMessageId?: string }
  ): Promise<FeishuSendResult> {
    const content = JSON.stringify({ text });

    try {
      if (options?.replyToMessageId) {
        const response = await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: {
            content,
            msg_type: 'text',
          },
        });

        if (response.code !== 0) {
          throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
        }

        return {
          messageId: response.data?.message_id ?? 'unknown',
          chatId: to,
        };
      }

      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: to,
          content,
          msg_type: 'text',
        },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
      }

      return {
        messageId: response.data?.message_id ?? 'unknown',
        chatId: to,
      };
    } catch (error) {
      logger.error('Failed to send message', { to, error });
      throw error;
    }
  }

  /**
   * 发送富文本消息 (Markdown)
   */
  async sendMarkdownMessage(
    to: string,
    markdown: string,
    options?: { replyToMessageId?: string; title?: string }
  ): Promise<FeishuSendResult> {
    // 飞书富文本格式
    const content = JSON.stringify({
      zh_cn: {
        title: options?.title ?? '',
        content: this.markdownToFeishuRichText(markdown),
      },
    });

    try {
      if (options?.replyToMessageId) {
        const response = await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: {
            content,
            msg_type: 'post',
          },
        });

        if (response.code !== 0) {
          // 如果富文本失败，回退到纯文本
          logger.warn('Rich text reply failed, falling back to plain text', { error: response.msg });
          return this.sendTextMessage(to, markdown, options);
        }

        return {
          messageId: response.data?.message_id ?? 'unknown',
          chatId: to,
        };
      }

      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: to,
          content,
          msg_type: 'post',
        },
      });

      if (response.code !== 0) {
        logger.warn('Rich text send failed, falling back to plain text', { error: response.msg });
        return this.sendTextMessage(to, markdown, options);
      }

      return {
        messageId: response.data?.message_id ?? 'unknown',
        chatId: to,
      };
    } catch (error) {
      logger.warn('Markdown send failed, falling back to plain text', { error });
      return this.sendTextMessage(to, markdown, options);
    }
  }

  /**
   * 发送卡片消息
   */
  async sendCardMessage(
    to: string,
    card: Record<string, unknown>,
    options?: { replyToMessageId?: string }
  ): Promise<FeishuSendResult> {
    const content = JSON.stringify(card);
    logger.debug('Sending card message', { content: content.substring(0, 500) });

    try {
      if (options?.replyToMessageId) {
        const response = await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: {
            content,
            msg_type: 'interactive',
          },
        });

        if (response.code !== 0) {
          logger.error('Card reply failed', { code: response.code, msg: response.msg, content: content.substring(0, 1000) });
          throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
        }

        return {
          messageId: response.data?.message_id ?? 'unknown',
          chatId: to,
        };
      }

      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: to,
          content,
          msg_type: 'interactive',
        },
      });

      if (response.code !== 0) {
        logger.error('Card send failed', { code: response.code, msg: response.msg, content: content.substring(0, 1000) });
        throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
      }

      return {
        messageId: response.data?.message_id ?? 'unknown',
        chatId: to,
      };
    } catch (error) {
      logger.error('Failed to send card message', { to, error });
      throw error;
    }
  }

  /**
   * 获取消息详情
   */
  async getMessage(messageId: string): Promise<FeishuMessageContext | null> {
    try {
      const response = (await this.client.im.message.get({
        path: { message_id: messageId },
      })) as {
        code?: number;
        msg?: string;
        data?: {
          items?: Array<{
            message_id?: string;
            chat_id?: string;
            msg_type?: string;
            body?: { content?: string };
            sender?: {
              id?: string;
              id_type?: string;
              sender_type?: string;
            };
            create_time?: string;
          }>;
        };
      };

      if (response.code !== 0 || !response.data?.items?.[0]) {
        return null;
      }

      const item = response.data.items[0];
      let content = item.body?.content ?? '';

      // 解析消息内容
      try {
        const parsed = JSON.parse(content);
        if (item.msg_type === 'text' && parsed.text) {
          content = parsed.text;
        }
      } catch {
        // 保持原始内容
      }

      return {
        messageId: item.message_id ?? messageId,
        chatId: item.chat_id ?? '',
        senderId: item.sender?.id ?? '',
        senderOpenId: item.sender?.id_type === 'open_id' ? item.sender?.id ?? '' : '',
        content,
        contentType: item.msg_type ?? 'text',
        chatType: 'p2p', // 需要通过其他方式获取
        mentionedBot: false,
      };
    } catch (error) {
      logger.error('Failed to get message', { messageId, error });
      return null;
    }
  }

  /**
   * 更新消息
   */
  async updateMessage(messageId: string, text: string): Promise<void> {
    const content = JSON.stringify({ text });

    const response = await this.client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content,
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu message update failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * 更新消息为富文本格式
   */
  async updateMessageToMarkdown(messageId: string, markdown: string): Promise<void> {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: this.markdownToFeishuRichText(markdown),
      },
    });

    const response = await this.client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content,
      },
    });

    if (response.code !== 0) {
      // 回退到纯文本
      logger.warn('Rich text update failed, falling back to plain text', { error: response.msg });
      await this.updateMessage(messageId, markdown);
    }
  }

  /**
   * 添加表情回复
   * @param messageId 消息 ID
   * @param emojiType 表情类型，如 "THUMBSUP", "THINKING", "CHECK" 等
   * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const response = (await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    })) as {
      code?: number;
      msg?: string;
      data?: { reaction_id?: string };
    };

    if (response.code !== 0) {
      throw new Error(`Feishu add reaction failed: ${response.msg || `code ${response.code}`}`);
    }

    return response.data?.reaction_id ?? '';
  }

  /**
   * 移除表情回复
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = (await this.client.im.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    })) as { code?: number; msg?: string };

    if (response.code !== 0) {
      throw new Error(`Feishu remove reaction failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * 解析飞书消息事件
   */
  parseMessageEvent(event: FeishuMessageEvent): FeishuMessageContext {
    const rawContent = this.parseMessageContent(event.message.content, event.message.message_type);
    const mentionedBot = this.checkBotMentioned(event);
    const content = this.stripBotMention(rawContent, event.message.mentions);

    return {
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || '',
      senderOpenId: event.sender.sender_id.open_id || '',
      chatType: event.message.chat_type,
      mentionedBot,
      rootId: event.message.root_id || undefined,
      parentId: event.message.parent_id || undefined,
      content,
      contentType: event.message.message_type,
    };
  }

  /**
   * 解析消息内容
   */
  private parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      }
      // 处理富文本消息
      if (messageType === 'post' && parsed.zh_cn?.content) {
        return this.feishuRichTextToMarkdown(parsed.zh_cn.content);
      }
      return content;
    } catch {
      return content;
    }
  }

  /**
   * 检查是否 @ 了机器人
   */
  private checkBotMentioned(event: FeishuMessageEvent): boolean {
    const mentions = event.message.mentions ?? [];
    if (mentions.length === 0) return false;
    if (!this.botOpenId) return mentions.length > 0;
    return mentions.some(m => m.id.open_id === this.botOpenId);
  }

  /**
   * 移除消息中的 @ 机器人
   */
  private stripBotMention(
    text: string,
    mentions?: FeishuMessageEvent['message']['mentions']
  ): string {
    if (!mentions || mentions.length === 0) return text;
    let result = text;
    for (const mention of mentions) {
      result = result.replace(new RegExp(`@${mention.name}\\s*`, 'g'), '').trim();
      result = result.replace(new RegExp(mention.key, 'g'), '').trim();
    }
    return result;
  }

  /**
   * 将 Markdown 转换为飞书富文本格式
   */
  private markdownToFeishuRichText(markdown: string): unknown[][] {
    const lines = markdown.split('\n');
    const result: unknown[][] = [];

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      // 处理标题
      if (line.startsWith('### ')) {
        const segments = this.parseInlineMarkdown(line.slice(4));
        for (const seg of segments) {
          if (!seg.style) seg.style = [];
          if (!seg.style.includes('bold')) seg.style.push('bold');
        }
        result.push(segments);
        continue;
      }
      if (line.startsWith('## ')) {
        const segments = this.parseInlineMarkdown(line.slice(3));
        for (const seg of segments) {
          if (!seg.style) seg.style = [];
          if (!seg.style.includes('bold')) seg.style.push('bold');
        }
        result.push(segments);
        continue;
      }
      if (line.startsWith('# ')) {
        const segments = this.parseInlineMarkdown(line.slice(2));
        for (const seg of segments) {
          if (!seg.style) seg.style = [];
          if (!seg.style.includes('bold')) seg.style.push('bold');
        }
        result.push(segments);
        continue;
      }

      // 处理列表
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const segments = this.parseInlineMarkdown(line.slice(2));
        segments.unshift({ tag: 'text', text: '• ' });
        result.push(segments);
        continue;
      }

      // 处理有序列表
      const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
      if (olMatch) {
        const segments = this.parseInlineMarkdown(olMatch[2]);
        segments.unshift({ tag: 'text', text: `${olMatch[1]}. ` });
        result.push(segments);
        continue;
      }

      // 处理代码块标记
      if (line.startsWith('```')) {
        continue;
      }

      // 普通文本 - 解析行内格式
      result.push(this.parseInlineMarkdown(line));
    }

    return result;
  }

  /**
   * 解析行内 Markdown（粗体、斜体、代码、链接）
   */
  private parseInlineMarkdown(text: string): Array<{ tag: string; text?: string; href?: string; style?: string[] }> {
    const segments: Array<{ tag: string; text?: string; href?: string; style?: string[] }> = [];
    let remaining = text;

    while (remaining.length > 0) {
      // 尝试匹配行内代码
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        segments.push({ tag: 'text', text: codeMatch[1], style: ['inline_code'] });
        remaining = remaining.slice(codeMatch[0].length);
        continue;
      }

      // 尝试匹配链接
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        segments.push({ tag: 'a', text: linkMatch[1], href: linkMatch[2] });
        remaining = remaining.slice(linkMatch[0].length);
        continue;
      }

      // 尝试匹配粗体 **text**
      const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
      if (boldMatch) {
        segments.push({ tag: 'text', text: boldMatch[1], style: ['bold'] });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }

      // 尝试匹配斜体 *text*（单个星号）
      const italicMatch = remaining.match(/^\*([^*]+)\*/);
      if (italicMatch) {
        segments.push({ tag: 'text', text: italicMatch[1], style: ['italic'] });
        remaining = remaining.slice(italicMatch[0].length);
        continue;
      }

      // 尝试匹配删除线 ~~text~~
      const strikeMatch = remaining.match(/^~~([^~]+)~~/);
      if (strikeMatch) {
        segments.push({ tag: 'text', text: strikeMatch[1], style: ['strikethrough'] });
        remaining = remaining.slice(strikeMatch[0].length);
        continue;
      }

      // 普通文本，找到下一个特殊字符
      let nextSpecial = remaining.length;
      const patterns = ['`', '[', '**', '*', '~~'];
      for (const pattern of patterns) {
        const idx = remaining.indexOf(pattern);
        if (idx !== -1 && idx < nextSpecial) {
          nextSpecial = idx;
        }
      }

      if (nextSpecial > 0) {
        segments.push({ tag: 'text', text: remaining.slice(0, nextSpecial) });
        remaining = remaining.slice(nextSpecial);
      } else if (nextSpecial === 0) {
        // 无法解析的特殊字符，作为普通文本处理
        segments.push({ tag: 'text', text: remaining[0] });
        remaining = remaining.slice(1);
      } else {
        break;
      }
    }

    return segments;
  }

  /**
   * 将飞书富文本转换为 Markdown
   */
  private feishuRichTextToMarkdown(content: unknown[][]): string {
    const lines: string[] = [];

    for (const block of content) {
      if (!Array.isArray(block)) continue;

      const textParts: string[] = [];
      for (const item of block) {
        if (typeof item !== 'object' || item === null) continue;
        const { tag, text, style } = item as { tag?: string; text?: string; style?: string[] };

        if (tag === 'text' && text) {
          if (style?.includes('bold')) {
            textParts.push(`**${text}**`);
          } else if (style?.includes('italic')) {
            textParts.push(`*${text}*`);
          } else if (style?.includes('code')) {
            textParts.push(`\`${text}\``);
          } else {
            textParts.push(text);
          }
        } else if (tag === 'a' && text) {
          const href = (item as { href?: string }).href;
          textParts.push(href ? `[${text}](${href})` : text);
        }
      }

      if (textParts.length > 0) {
        lines.push(textParts.join(''));
      }
    }

    return lines.join('\n');
  }

  /**
   * 设置机器人 Open ID
   */
  setBotOpenId(openId: string): void {
    this.botOpenId = openId;
  }
}

// 单例实例
let _client: FeishuClient | null = null;

export function getFeishuClient(): FeishuClient {
  if (!_client) {
    const { feishu } = require('../utils/config.js').getConfig();
    _client = new FeishuClient(feishu);
  }
  return _client;
}

export function resetFeishuClient(): void {
  _client = null;
}
