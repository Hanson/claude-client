/**
 * 飞书事件处理器
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import type { FeishuConfig, FeishuMessageContext, FeishuMessageEvent, FeishuCardActionEvent } from '../types/index.js';
import { FeishuClient, getFeishuClient } from './client.js';
import { logger } from '../utils/logger.js';

export type MessageHandler = (ctx: FeishuMessageContext) => Promise<void>;

export interface FeishuEventHandlerOptions {
  onMessage?: MessageHandler;
  onBotAdded?: (chatId: string, operatorId: string) => Promise<void>;
  onBotRemoved?: (chatId: string, operatorId: string) => Promise<void>;
}

export class FeishuEventHandler {
  private client: FeishuClient;
  private nativeClient: Lark.Client;
  private eventDispatcher: Lark.EventDispatcher;
  private wsClient: Lark.WSClient | null = null;
  private config: FeishuConfig;
  private options: FeishuEventHandlerOptions;
  private botOpenId: string | null = null;
  private processedMessageIds: Set<string> = new Set(); // 消息去重
  private readonly maxProcessedMessages = 5000; // 最多缓存 5000 条消息 ID
  private serviceStartTime: number = Date.now(); // 服务启动时间，用于忽略历史消息
  private processedIdsPath: string = './data/processed_ids.json';
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(config: FeishuConfig, options: FeishuEventHandlerOptions = {}) {
    this.config = config;
    this.client = new FeishuClient(config);
    this.nativeClient = this.client.getNativeClient();
    this.options = options;
    this.eventDispatcher = new Lark.EventDispatcher({
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    });

    // 加载已处理的消息 ID
    this.loadProcessedIds();

    this.setupEventHandlers();
  }

  /**
   * 从文件加载已处理的消息 ID
   */
  private loadProcessedIds(): void {
    try {
      if (fs.existsSync(this.processedIdsPath)) {
        const data = fs.readFileSync(this.processedIdsPath, 'utf-8');
        const ids = JSON.parse(data) as string[];
        for (const id of ids) {
          this.processedMessageIds.add(id);
        }
        logger.info(`Loaded ${this.processedMessageIds.size} processed message IDs from cache`);
      }
    } catch (error) {
      logger.warn('Failed to load processed message IDs', { error });
    }
  }

  /**
   * 保存已处理的消息 ID 到文件
   */
  private saveProcessedIds(): void {
    try {
      const dir = path.dirname(this.processedIdsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const ids = Array.from(this.processedMessageIds);
      fs.writeFileSync(this.processedIdsPath, JSON.stringify(ids, null, 2));
    } catch (error) {
      logger.error('Failed to save processed message IDs', { error });
    }
  }

  /**
   * 获取事件处理器
   */
  getEventDispatcher(): Lark.EventDispatcher {
    return this.eventDispatcher;
  }

  /**
   * 初始化 - 获取机器人信息
   */
  async initialize(): Promise<void> {
    try {
      const botInfo = await this.client.getBotInfo();
      this.botOpenId = botInfo.botOpenId;
      this.client.setBotOpenId(botInfo.botOpenId);
      logger.info(`Bot initialized: ${botInfo.botName} (${botInfo.botOpenId})`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize Feishu bot: ${errorMsg}`);
      throw new Error(
        `飞书机器人初始化失败。请检查 .env 文件中的 FEISHU_APP_ID 和 FEISHU_APP_SECRET 是否正确。\n` +
        `错误详情: ${errorMsg}`
      );
    }
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 处理消息接收事件
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceived(data as FeishuMessageEvent);
        } catch (error) {
          logger.error('Error handling message received event', { error, data });
        }
      },
    });

    // 处理机器人被添加到群聊事件
    this.eventDispatcher.register({
      'im.chat.member.bot_added_v1': async (data: unknown) => {
        try {
          const event = data as { chat_id: string; operator_id: { open_id: string } };
          if (this.options.onBotAdded) {
            await this.options.onBotAdded(event.chat_id, event.operator_id.open_id);
          }
          logger.info(`Bot added to chat: ${event.chat_id}`);
        } catch (error) {
          logger.error('Error handling bot added event', { error });
        }
      },
    });

    // 处理机器人被移除事件
    this.eventDispatcher.register({
      'im.chat.member.bot_deleted_v1': async (data: unknown) => {
        try {
          const event = data as { chat_id: string; operator_id: { open_id: string } };
          if (this.options.onBotRemoved) {
            await this.options.onBotRemoved(event.chat_id, event.operator_id.open_id);
          }
          logger.info(`Bot removed from chat: ${event.chat_id}`);
        } catch (error) {
          logger.error('Error handling bot removed event', { error });
        }
      },
    });

    // 处理卡片按钮点击事件
    this.eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.handleCardAction(data as FeishuCardActionEvent);
        } catch (error) {
          logger.error('Error handling card action event', { error, data });
        }
      },
    });
  }

  /**
   * 处理接收到的消息
   */
  private async handleMessageReceived(event: FeishuMessageEvent): Promise<void> {
    const ctx = this.client.parseMessageEvent(event);

    // 记录原始事件用于调试
    logger.info('Raw message event received', {
      messageId: ctx.messageId,
      chatId: ctx.chatId,
      content: ctx.content.substring(0, 50),
      serviceStartTime: this.serviceStartTime,
      currentTime: Date.now(),
    });

    // 消息去重：检查是否已处理过
    if (this.processedMessageIds.has(ctx.messageId)) {
      logger.info('Message already processed, skipping', { messageId: ctx.messageId });
      return;
    }

    // 添加到已处理集合
    this.processedMessageIds.add(ctx.messageId);

    // 限制缓存大小，防止内存泄漏
    if (this.processedMessageIds.size > this.maxProcessedMessages) {
      // 删除最旧的一半
      const idsArray = Array.from(this.processedMessageIds);
      const toDelete = idsArray.slice(0, Math.floor(this.maxProcessedMessages / 2));
      for (const id of toDelete) {
        this.processedMessageIds.delete(id);
      }
    }

    // 保存到文件（每次处理后都保存，确保不丢失）
    this.saveProcessedIds();

    logger.info('Processing new message', {
      messageId: ctx.messageId,
      chatId: ctx.chatId,
      senderId: ctx.senderOpenId,
      chatType: ctx.chatType,
      mentionedBot: ctx.mentionedBot,
      content: ctx.content.substring(0, 100),
    });

    // 群聊消息需要 @ 机器人
    if (ctx.chatType === 'group' && !ctx.mentionedBot) {
      logger.debug('Group message without mention, ignoring');
      return;
    }

    // 忽略机器人自己发送的消息
    if (ctx.senderOpenId === this.botOpenId) {
      logger.debug('Ignoring message from bot itself');
      return;
    }

    // 调用消息处理器
    if (this.options.onMessage) {
      await this.options.onMessage(ctx);
    }
  }

  /**
   * 处理卡片按钮点击事件
   */
  private async handleCardAction(event: FeishuCardActionEvent): Promise<void> {
    const command = event.action?.value?.command as string | undefined;

    if (!command) {
      logger.debug('Card action without command, ignoring');
      return;
    }

    // 打印完整事件结构用于调试
    logger.debug('Card action event', { event: JSON.stringify(event) });

    // 获取 chatId - 可能在不同字段中
    const eventAny = event as unknown as Record<string, unknown>;
    const context = eventAny.context as Record<string, unknown> | undefined;
    const chatId = event.open_chat_id || context?.open_chat_id as string | undefined;

    if (!chatId) {
      logger.error('Card action missing chatId', { event: JSON.stringify(event) });
      return;
    }

    logger.info('Card action received', {
      chatId,
      messageId: event.open_message_id,
      operatorId: event.operator.open_id,
      command,
    });

    // 忽略机器人自己的点击
    if (event.operator.open_id === this.botOpenId) {
      logger.debug('Ignoring card action from bot itself');
      return;
    }

    // 构造消息上下文，将按钮点击转换为等效的文本消息
    const ctx: FeishuMessageContext = {
      chatId: chatId as string,
      messageId: event.open_message_id,
      senderId: event.operator.open_id,
      senderOpenId: event.operator.open_id,
      chatType: 'p2p', // 卡片点击通常是私聊，默认设置为 p2p
      mentionedBot: true, // 卡片点击视为明确意图
      content: command,
      contentType: 'text',
    };

    // 调用消息处理器
    if (this.options.onMessage) {
      await this.options.onMessage(ctx);
    }
  }

  /**
   * 获取飞书客户端
   */
  getFeishuClient(): FeishuClient {
    return this.client;
  }

  /**
   * 启动 WebSocket 客户端 (长连接模式)
   */
  startWebSocket(): void {
    if (this.wsClient) {
      logger.warn('WebSocket client already started');
      return;
    }

    const domain = this.config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    logger.info('WebSocket client started');
  }

  /**
   * 停止 WebSocket 客户端
   */
  stopWebSocket(): void {
    if (this.wsClient) {
      // WSClient 没有 stop 方法，直接置空
      this.wsClient = null;
      logger.info('WebSocket client stopped');
    }
  }
}

/**
 * 创建 HTTP 适配器 (用于 webhook 模式)
 */
export function createHTTPAdapter(
  eventHandler: FeishuEventHandler,
  path: string = '/feishu/events'
): (req: unknown, res: unknown) => void {
  // 使用 adaptDefault 创建 HTTP 请求处理器
  return Lark.adaptDefault(path, eventHandler.getEventDispatcher(), { autoChallenge: true });
}
