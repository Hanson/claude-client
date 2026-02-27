# 🤖 Claude Client

中文文档 | [English](./README_EN.md)

**通过飞书远程控制本地 Claude Code CLI。**

Claude Client 将飞书即时通讯平台与 Claude Code CLI 桥接，使您可以通过手机或任何安装了飞书的设备远程与 Claude AI 交互。

## 🌟 项目亮点

### 📱 随时随地写代码
通勤路上、会议间隙、离开工位时都能写代码、重构文件或调试问题。无需 VPN 或远程桌面 - 只需要飞书。

### 🔄 实时掌握任务状态
每 30 秒实时进度更新，显示进程 PID。即使使用手机，也能随时了解长时间任务是否在运行或已完成。

### 🔥 智能目录管理
- **热门目录**：快速访问最近使用的 5 个项目
- **目录级上下文**：每个项目维护独立的对话历史
- **一键恢复**：继续之前的任务，无需重新解释上下文

### 🎯 交互式体验
精美的飞书卡片配合可点击按钮 - 无需记忆命令。点击即可切换目录、更改模式或恢复任务。

### 📝 可配置的变更记录
自动记录所有变更：
- **Git 模式**：自动提交，可自定义消息模板，包含 diff
- **飞书文档**：直接写入飞书文档
- **可扩展**：易于添加更多记录后端

### 🛡️ 企业级就绪
- 消息去重防止重复处理
- 按聊天持久化工作目录
- 多种权限模式控制安全
- 会话超时自动过期

## ✨ 功能特性

- 📱 **飞书集成** - 通过飞书机器人与 Claude 交互（私聊或群聊）
- 🔄 **实时进度** - 每 30 秒更新进度，显示进程状态
- 📁 **目录管理** - 切换项目目录，热门目录快速访问
- 💬 **会话持久化** - 恢复之前的对话，保持上下文
- 🔐 **权限模式** - 多种权限模式满足不同安全需求
- 📝 **变更记录** - 可配置的变更记录（Git 提交、飞书文档等）
- 🛠️ **完整工具支持** - 文件操作、命令执行、网络搜索等
- 🎯 **交互式卡片** - 精美的飞书卡片，支持点击按钮

## 📋 环境要求

- Node.js >= 18.0.0
- 已安装 Claude Code CLI ([安装指南](https://docs.anthropic.com/en/docs/claude-code))
- 飞书开发者账号 ([飞书开放平台](https://open.feishu.cn/))

## 🚀 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/YOUR_USERNAME/claude-client.git
cd claude-client
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 飞书机器人配置
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
FEISHU_DOMAIN=feishu  # 国际版使用 'lark'

# 服务器配置
PORT=3000
HOST=0.0.0.0

# 可选：Claude API Key（通常由 CLI 管理）
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

### 3. 安装 Claude Code CLI

```bash
# macOS/Linux
brew install claude

# 或通过 npm
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

### 4. 配置飞书机器人

#### 4.1 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn/) 并登录
2. 点击「创建企业自建应用」
3. 填写应用名称和描述，上传头像

#### 4.2 获取应用凭证

在应用详情页的「凭证与基础信息」中获取：
- **App ID** → 对应 `FEISHU_APP_ID`
- **App Secret** → 对应 `FEISHU_APP_SECRET`

#### 4.3 配置事件订阅

1. 进入「事件订阅」页面
2. **订阅方式**：选择「使用长连接接收事件」
3. 获取以下凭证：
   - **Encrypt Key** → 对应 `FEISHU_ENCRYPT_KEY`
   - **Verification Token** → 对应 `FEISHU_VERIFICATION_TOKEN`
4. **添加事件**：点击「添加事件」，搜索并订阅：
   - `im.message.receive_v1` - 接收消息（必需）
5. **配置卡片回调**：在「卡片配置」中添加：
   - `card.action.trigger` - 卡片按钮点击回调（用于帮助卡片交互）

#### 4.4 添加应用权限

在「权限管理」→「申请权限」中添加以下权限：

**方式一：批量导入（推荐）**

1. 点击「申请权限」页面右上角的「导入权限」按钮
2. 将 [imgs/feishu-permissions.json](./imgs/feishu-permissions.json) 文件内容粘贴到输入框
3. 点击确认导入

![导入权限](./imgs/feishu-permissions-import.jpg)

**方式二：手动添加**

在「应用能力」→「机器人」中：
1. 启用机器人功能
2. 搜索并添加以下权限：
   - `im:message` - 获取与发送单聊、群聊消息
   - `im:message:send_as_bot` - 以机器人身份发送消息
   - `im:message.group_at_msg:readonly` - 获取群组中@机器人消息
   - `im:chat` - 获取群组信息
   - `im:chat.members:bot_access` - 获取群成员列表
   - `cardkit:card:write` - 发送卡片消息（用于帮助卡片）

#### 4.5 发布应用

1. 在「版本管理与发布」中创建版本
2. 提交审核（企业内部应用可跳过审核）
3. 发布后，在飞书中搜索应用名称即可使用

#### 4.6 配置环境变量

将获取的凭证填入 `.env` 文件：

```env
# 飞书机器人配置
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxxxxxxxxxx
FEISHU_DOMAIN=feishu  # 国际版使用 'lark'
```

### 5. 构建并运行

```bash
npm run build
npm start
```

或开发模式运行：

```bash
npm run dev
```

## 📖 使用方法

### 交互式卡片预览

发送 `?` 或 `？` 会显示帮助卡片，包含热门目录和常用操作按钮：

![帮助卡片示例](./imgs/card.jpg)

### 基本交互

直接在飞书中给机器人发送消息：

```
读取 package.json 文件并解释其结构
```

群聊中需要 @ 机器人：

```
@Claude 帮我重构这个函数
```

### 命令

| 命令 | 说明 |
|------|------|
| `?` 或 `？` 或 `/help` | 显示帮助卡片（含热门目录按钮） |
| `/clear` 或 `/reset` | 清除当前会话上下文 |
| `/status` | 查看会话状态 |
| `/pwd` | 显示当前工作目录 |
| `/cd <路径>` | 切换工作目录（支持相对路径如 `../`） |
| `/mode <模式>` | 切换权限模式 |
| `/tasklist` 或 `/tasks` | 显示当前目录的上下文列表 |
| `/resume <目录>` | 恢复之前的任务 |
| `/taskdelete <目录>` | 删除指定目录的任务记录 |

### 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 所有操作需要手动批准 |
| `acceptEdits` | 自动批准文件编辑，其他需批准 |
| `bypassPermissions` | 跳过所有权限检查（谨慎使用） |
| `plan` | 计划模式，用于复杂任务规划 |

### 热门目录

帮助卡片会显示最近访问的 5 个目录，便于快速切换：

```
? → 显示热门目录 → 点击切换
```

### 任务管理

- 每个目录维护独立的对话上下文
- 使用 `/tasklist` 查看当前目录的历史上下文
- 一键恢复之前的任务

## ⚙️ 配置

### 变更记录

在 `data/change-logger-config.json` 中配置：

```json
{
  "enabled": true,
  "type": "git",
  "git": {
    "autoCommit": false,
    "commitMessageTemplate": "feat(claude-client): {userMessage}",
    "includeDiff": true,
    "excludePatterns": ["node_modules", ".git", "dist"]
  }
}
```

支持的记录类型：
- `git` - 使用 Git 记录变更
- `feishu-doc` - 记录到飞书文档
- `console` - 打印到控制台（调试用）
- `none` - 禁用记录

## 📁 项目结构

```
claude-client/
├── src/
│   ├── feishu/              # 飞书集成
│   │   ├── client.ts        # API 客户端
│   │   └── handler.ts       # 事件处理器
│   ├── claude/              # Claude CLI 集成
│   │   └── agent.ts         # Agent 封装
│   ├── session/             # 会话管理
│   │   ├── manager.ts       # 会话管理器
│   │   ├── task-store.ts    # 任务持久化
│   │   └── directory-store.ts # 目录历史
│   ├── change-logger/       # 变更记录系统
│   │   ├── manager.ts       # 记录管理器
│   │   ├── git-logger.ts    # Git 记录器
│   │   └── feishu-doc-logger.ts
│   ├── utils/               # 工具函数
│   │   ├── config.ts        # 配置管理
│   │   ├── logger.ts        # 日志
│   │   └── formatter.ts     # 消息格式化
│   ├── types/               # TypeScript 类型
│   ├── app.ts               # 主应用
│   └── cli.ts               # CLI 入口
├── data/                    # 持久化数据
├── config/                  # 配置文件
└── dist/                    # 编译后的 JavaScript
```

## 🔒 安全注意事项

1. **网络安全** - 不要将服务直接暴露在公网，建议使用 VPN 或内网穿透服务
2. **文件访问** - Claude 可以访问工作目录及其子目录中的文件
3. **API 限制** - 注意 Claude API 的速率限制
4. **会话超时** - 30 分钟无活动后会话过期
5. **权限模式** - 谨慎使用 `bypassPermissions` 模式

## 🛠️ 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 监听模式
npm run watch

# 运行测试
npm test

# 代码检查
npm run lint
```

## 📚 参考资料

- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Agent SDK](https://platform.claude.com/docs/agent-sdk/overview)
- [飞书开放平台](https://open.feishu.cn/)
- [Lark API 文档](https://open.larksuite.com/document)

## 🤝 参与贡献

欢迎贡献代码！请随时提交 Pull Request。

## 💬 交流群

欢迎加入交流群，一起讨论 Claude Client 的使用和开发：

![交流群二维码](./imgs/qr-group.jpg)

## 📄 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)

---

Made with ❤️ by the Claude Client Team
