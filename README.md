# dsh-im-notify

飞书专用的 **DeepSeek Harness 任务完成通知器**。关注（watch）任意 DSH 会话，任务回合结束时飞书收到推送卡片；**引用推送消息直接回复**，内容直达对应会话——多会话并行开发时，人离开电脑也能及时推进下一阶段。

与 `@xmanrui/dsh-im` 完全独立、互不干扰（可共存：日常聊天用 dsh-im，任务通知用本插件）。

## 功能

- `/watch <会话ID前缀 或 /sessions 序号>` — 关注会话，完成后推送卡片（作为对 /watch 消息的回复）
- `/sessions` — 列出最近 15 个会话
- `/watchlist` / `/unwatch` — 管理关注
- `/status` — 插件状态
- **GUI 设置面板**：DSH 设置 → 「IM 通知」— 未接入时扫码一键接入；已接入时查看连接状态、管理全部关注（含 Web 侧移除/清空）
- **引用回程**：引用任意推送卡片直接回复 → 空闲会话用 `queue`（恢复其 Agent 继续），运行中会话用 `steer`（注入为补充指令），并回执确认
- 重启补偿：插件/Host 重启后，按 seq 游标补发漏掉的完成事件（最多最近 3 条）

## 前置：飞书应用接入（三种方式）

### 方式 A：GUI 扫码接入（推荐，约 1 分钟）

1. DSH Web GUI → **设置 → IM 通知** → 「扫码接入飞书」
2. 手机飞书扫页面上的二维码，在落地页点一次"创建/授权"
3. 显示 ✅ 接入完成 → **重启 DeepSeek Harness** 生效

扫码者自动成为 owner；权限（读私聊/@消息、发消息）与事件订阅（`im.message.receive_v1`）在落地页一次勾齐，**无需访问开发者后台**。原理：官方 SDK `lark.registerApp()` 设备授权流（RFC 8628），与 dsh-im 设置页的扫码接入同一机制。

### 方式 B：终端扫码接入

```bash
# 源码仓库里（开发/clone 用户）：
npm install        # 首次需安装依赖（含 qrcode）
npm run setup

# 或：已通过 DSH 插件管理器安装（无需 clone）：
node <DSH配置目录>/node_modules/dsh-im-notify/scripts/setup.mjs
# Windows 示例：node C:\Users\<你>\.dsh\profiles\<profile>\node_modules\dsh-im-notify\scripts\setup.mjs
```

凭据自动写入 `<dshHome>/integrations/dsh-im-notify/config.json`，与方式 A 完全等价。

- 国际版账号：`npm run setup -- --domain lark`（feishu 域扫到国际账号也会自动切换）
- 为已有应用补权限：`npm run setup -- --app-id cli_xxx`（落地页展示权限 diff）
- 离线自检：`npm run setup -- --check`
- 覆盖已有凭据：`npm run setup -- --force`
- 企业禁用个人创建应用时 → 用方式 C

### 方式 B：手动创建（兜底）

1. [飞书开放平台](https://open.feishu.cn/) → 创建**企业自建应用**
2. **添加应用能力** → 机器人
3. **权限管理** 开通：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`
4. **事件与回调** → 选择 **使用长连接接收事件**，订阅 `im.message.receive_v1`
5. 发布应用（版本管理 → 创建版本 → 可用范围自己）
6. 记下 **App ID / App Secret**，把自己（或管理员）的 `open_id` 加入配置（可先不填 = 不限管理员）

## 安装

```bash
git clone https://github.com/NecroDriver/dsh-im-notify.git
cd dsh-im-notify
npm install          # 安装 @larksuiteoapi/node-sdk + esbuild
npm run build        # 产出 lib/index.js
npm run setup        # 方式 A：扫码接入，自动写 config.json（见上）

# 方式 B 手动凭据（包外存放，重装/升级不丢失）：
# Windows PowerShell:
ni "$env:USERPROFILE\.dsh\integrations\dsh-im-notify" -Force -Type Directory
@'
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "ownerOpenIds": ["ou_xxx"],
  "domain": "feishu"
}
'@ | Set-Content "$env:USERPROFILE\.dsh\integrations\dsh-im-notify\config.json"

npm run dev:link     # junction 进 profile node_modules + 注册 dsh.profile.bundles
```

然后**重启 DSH Host**（或在插件管理中停用/启用 dsh-im-notify）。日志出现
`[dsh-im-notify] started — feishu long connection ready` 即成功。

> 手动安装等价步骤：把本目录链接/复制到 `<profile>/node_modules/dsh-im-notify`，
> 并在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组加入 `"dsh-im-notify"`。

## 配置

`<dshHome>/integrations/dsh-im-notify/config.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 必填 | 飞书自建应用凭据 |
| `domain` | `feishu` | 国际版用 `lark` |
| `ownerOpenIds` | `[]` | 允许执行命令的管理员；空数组 = 不限制（引用回程不受限，推送到的聊天天然可回） |
| `maxWatchesPerChat` | `8` | 每个聊天的关注上限（超出淘汰最旧） |
| `mappingTtlMs` | `86400000` | 推送消息 → 会话映射的有效期（引用回程窗口） |

也可把 `appId`/`appSecret`/`ownerOpenIds` 写进 `cordis.patch.yml` 的 `config:` 块（优先级更高）。

## 状态

`state.json`（同目录）保存 watches（含 seq 游标）与回程映射；删除该文件即重置。

## 开发

```bash
npm run build                 # esbuild bundle → lib/index.js
node scripts/dev-link.mjs     # 链接进 profile（DSH_PROFILE_DIR 可覆盖）
```

改 `plugin-src/host/*` → build → 重启/切换插件生效。代码结构：

| 文件 | 职责 |
|---|---|
| `index.mjs` | 插件入口：命令路由 + 装配 |
| `feishu.mjs` | 飞书 SDK 长连接、卡片构建、入站归一化 |
| `watch-engine.mjs` | `session/event` 全局订阅 → `turn/end` 推送 + 重启补偿 |
| `route-back.mjs` | 引用命中 → `session.prompt` 直达会话 + 回执 |
| `gateway.mjs` | Host gateway 封装（follow/prompt，owner peer） |
| `state.mjs` | 配置 + 持久化（防抖原子写） |

## 路线图（M3+）

- 完成卡片按钮直达（`card.action.trigger` 已订阅面预留）
- 审批/待答问题转发飞书（`approval/request` / `user-questions/request` 全局拦截，dsh-im 同款原语）
- 推送正文节选（最后一条 assistant 回答）
- 多语言（lark 域文案）

## 已知边界

- 内部 Host API（`typertGateway`/`session/event`）无跨版本兼容承诺，DSH 大版本升级后需回归。
- 投递为尽力而为：飞书 `{sent:true}` 仅代表平台受理；断线期间的完成事件靠重启补偿兜底。
- 本插件不感知 dsh-im 的会话绑定；若同一会话被两边推送，`/watch` 二选一即可。

## License

MIT
