#!/usr/bin/env node
// One-click Feishu app provisioning for dsh-im-notify.
//
// Uses the official @larksuiteoapi/node-sdk device-authorization flow
// (lark.registerApp, see SDK README.zh.md "一键创建应用"): the script prints a
// QR code, you scan it with Feishu and confirm once on the landing page, and
// the SDK polls until the platform hands back client_id/client_secret. The
// addons payload pre-requests the minimal scopes + the im.message.receive_v1
// event subscription, so no developer-console visit is needed afterwards.
//
// Written credentials land in <dshHome>/integrations/dsh-im-notify/config.json
// (same file the host plugin reads; package-independent, survives reinstalls).
//
// Usage:
//   npm run setup                          # create a new app (default)
//   npm run setup -- --domain lark         # international Lark accounts
//   npm run setup -- --app-id cli_xxx      # re-scan to update an existing app
//   npm run setup -- --dsh-home D:\path    # non-default DSH home
//   npm run setup -- --check               # offline env/config inspection
//   npm run setup -- --force               # overwrite existing credentials

import * as Lark from '@larksuiteoapi/node-sdk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../plugin-src/host/state.mjs';

const APP_PRESET = {
  name: 'DSH Notify',
  desc: 'DeepSeek Harness 会话完成通知：watch 任意会话，回合结束推送飞书，引用回复即可把消息送回该会话。',
};

// Minimal permission set for notify + route-back (dsh-im requests the full
// IM suite; we only need to receive DMs / group @-mentions and send messages).
const ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message:send_as_bot',
    ],
  },
  events: { items: { tenant: ['im.message.receive_v1'] } },
};

function usage() {
  console.log(`dsh-im-notify setup — 飞书应用一键接入

用法: npm run setup [-- 参数]

  (无参数)            创建新应用：终端出二维码 → 飞书扫码确认 → 凭据自动写入
  --domain lark      国际版 Lark 账号（accounts.larksuite.com）
  --app-id cli_xxx   已有应用增量更新/补权限（落地页展示权限 diff 后确认）
  --dsh-home PATH    指定 DSH home（默认 \$DSH_HOME 或 ~/.dsh）
  --force            覆盖已存在的凭据（默认拒绝覆盖）
  --check            离线自检：环境、SDK 导出、当前配置状态
  -h, --help         本帮助`);
}

function parseArgs(argv) {
  const out = { domain: 'feishu' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--check') out.check = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--domain') out.domain = argv[++i];
    else if (arg === '--app-id') out.appId = argv[++i];
    else if (arg === '--dsh-home') out.dshHome = argv[++i];
    else {
      console.error(`未知参数: ${arg}\n`);
      usage();
      process.exit(2);
    }
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function fail(message, code = 1) {
  console.error(`\n✖ ${message}`);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (args.domain !== 'feishu' && args.domain !== 'lark') {
    fail(`--domain 仅支持 feishu 或 lark，收到: ${args.domain}`);
  }

  if (typeof Lark.registerApp !== 'function') {
    fail('当前 @larksuiteoapi/node-sdk 未导出 registerApp，请升级依赖 (>=1.45.0)');
  }

  const dir = stateDirectory(args.dshHome ? { dshHome: args.dshHome } : undefined);
  const configFile = join(dir, 'config.json');
  const existing = (await readJson(configFile)) ?? {};
  const alreadyConfigured = Boolean(existing.appId && existing.appSecret);

  if (args.check) {
    console.log('环境自检');
    console.log(`  node ${process.version}`);
    console.log(`  registerApp 导出: ${typeof Lark.registerApp}`);
    console.log(`  配置文件: ${configFile}`);
    console.log(`  当前状态: ${alreadyConfigured ? `已配置 (appId=${existing.appId})` : '未配置'}`);
    if (Array.isArray(existing.ownerOpenIds)) {
      console.log(`  ownerOpenIds: ${existing.ownerOpenIds.join(', ')}`);
    }
    console.log(`  domain: ${existing.domain ?? 'feishu (默认)'}`);
    return;
  }

  console.log('dsh-im-notify 飞书一键接入');
  console.log(`配置文件: ${configFile}\n`);

  if (alreadyConfigured && !args.force && !args.appId) {
    fail(`已存在凭据 (appId=${existing.appId})。覆盖请加 --force；为该应用补权限请用 --app-id ${existing.appId}`);
  }

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\n收到中断，取消本次注册…');
    controller.abort();
  });

  let domainSwitched = false;

  // Render the QR with the `qrcode` devDependency when available; otherwise
  // (e.g. running from a profile-installed copy without devDeps) fall back to
  // the raw URL, which opens the same landing page on the phone directly.
  const printQr = async (url) => {
    try {
      const { default: QRCode } = await import('qrcode');
      console.log('请用飞书扫描下方二维码（或在手机上打开链接）：\n');
      console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    } catch {
      console.log('未安装 qrcode 依赖（devDependency），请直接在手机上打开链接：\n');
    }
    console.log(`链接: ${url}`);
  };

  try {
    const result = await Lark.registerApp({
      // SDK expects the full host; feishu is the default and omitted, lark
      // polls accounts.larksuite.com directly (domain_switched also handles
      // feishu-domain scans by international accounts automatically).
      ...(args.domain === 'lark' ? { domain: 'accounts.larksuite.com' } : {}),
      source: 'dsh-im-notify',
      // createOnly hides "select existing app" so a stray scan cannot
      // overwrite an unrelated app; --app-id is the explicit update path.
      ...(args.appId ? { appId: args.appId } : { createOnly: true }),
      appPreset: APP_PRESET,
      addons: ADDONS,
      signal: controller.signal,
      onQRCodeReady: ({ url, expireIn }) => {
        const seconds = Number(expireIn) || 600;
        void printQr(url)
          .then(() => {
            console.log(`有效期 ${Math.round(seconds / 60)} 分钟；扫码后在落地页点一次"创建/授权"即完成。`);
            console.log('\n等待确认…（Ctrl-C 取消）');
          })
          .catch(() => console.log('等待确认…（Ctrl-C 取消）'));
      },
      onStatusChange: ({ status, interval }) => {
        if (status === 'polling') process.stdout.write('.');
        else if (status === 'slow_down') console.log(`\n轮询间隔调整为 ${interval}s`);
        else if (status === 'domain_switched') {
          domainSwitched = true;
          console.log('\n检测到国际版账号，已切换到 Lark (larksuite.com)');
        }
      },
    });

    const clientId = result?.client_id;
    const clientSecret = result?.client_secret;
    const openId = result?.user_info?.open_id;
    if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
      fail('注册流程返回的凭据不完整，请重试。');
    }

    const domain = domainSwitched || args.domain === 'lark' ? 'lark' : 'feishu';
    const nextConfig = {
      ...existing,
      appId: clientId,
      appSecret: clientSecret,
      domain,
      ...(Array.isArray(existing.ownerOpenIds) && existing.ownerOpenIds.length
        ? {}
        : openId ? { ownerOpenIds: [openId] } : {}),
    };

    await mkdir(dir, { recursive: true });
    await writeFile(configFile, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

    console.log('\n✅ 完成！凭据已写入:');
    console.log(`   ${configFile}`);
    console.log(`   appId=${clientId}  domain=${domain}`);
    if (openId && nextConfig.ownerOpenIds?.includes(openId)) console.log(`   扫码者 ${openId} 已设为 owner`);
    console.log('\n下一步:');
    console.log('  1. 重启 DeepSeek Harness（让插件加载新凭据）');
    console.log('  2. 在飞书里给机器人发 /help 验证连通');
    console.log('  3. 用 /sessions 查会话列表，/watch <序号或ID> 开始接收完成推送');
  } catch (error) {
    const code = error?.code ?? error?.failure?.code;
    if (code === 'expired_token' || error?.message?.includes('expired_token')) {
      fail('二维码已过期，请重新运行 npm run setup。');
    }
    if (code === 'access_denied') fail('授权被拒绝（落地页上取消了）。');
    if (controller.signal.aborted || code === 'abort' || error?.name === 'AbortError') {
      process.exit(130);
    }
    fail(`注册失败: ${error?.message ?? error}`);
  }
}

main();
