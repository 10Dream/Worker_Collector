/**
 * Telegram Channel Config Collector Worker (Enhanced)
 * - Inspired by TG-Proxy_Assistant capabilities
 * - Source type is ONLY Telegram channels (no remote subscription source ingestion)
 */

const ALL_PROTOCOLS = [
  'vmess', 'vless', 'trojan', 'ss', 'ssr', 'tuic', 'hysteria', 'hysteria2',
  'juicity', 'snell', 'anytls', 'ssh', 'wireguard', 'socks', 'cloudflare'
];

const PROTOCOL_ALIASES = {
  hy2: 'hysteria2',
  wg: 'wireguard',
  warp: 'wireguard',
  socks4: 'socks',
  socks5: 'socks'
};

const RAW_PROTOCOLS_FOR_EXTRACT = [
  'vmess', 'vless', 'trojan', 'ss', 'ssr', 'tuic', 'hysteria', 'hysteria2',
  'hy2', 'juicity', 'snell', 'anytls', 'ssh', 'wireguard', 'wg', 'warp',
  'socks', 'socks4', 'socks5', 'tg', 'dns', 'nm-dns', 'nm-vless',
  'slipnet-enc', 'slipnet', 'slipstream', 'dnstt'
];

const TG_PROXY_REGEX = /(?:https:\/\/t\.me\/(?:proxy|socks)\?[^\s<>"']+|tg:\/\/(?:proxy|socks)\?[^\s<>"']+)/gi;
const CONFIG_REGEX = new RegExp(
  `(?:${RAW_PROTOCOLS_FOR_EXTRACT.map((p) => p.replace('-', '\\-')).join('|')}):(?:\\/\\/|\\/)[^\\s<>"')\]]+`,
  'gi'
);

const DEFAULT_PROTOCOLS_STATE = Object.fromEntries(
  ALL_PROTOCOLS.map((p) => [p, { enabled: ['vless', 'vmess', 'trojan', 'wireguard', 'cloudflare'].includes(p), qty: 10 }])
);

const DEFAULT_SETTINGS = {
  bot_mode_enabled: true,
  channel_mode_enabled: false,
  channel_id: '',
  admin_chat_id: '',
  rl_enabled: false,
  rl_time: 60,
  rl_reqs: 8,
  max_pages_per_channel: 10,
  channels: [],
  protocols: DEFAULT_PROTOCOLS_STATE
};

class SystemLogger {
  constructor(env, ctx, settings = null) {
    this.env = env;
    this.ctx = ctx;
    this.settings = settings;
  }

  async log(level, msg, notifyAdmin = false) {
    if (!this.env.BOT_KV) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg
    };
    this.ctx.waitUntil(this._persist(entry));

    if ((notifyAdmin || level === 'CRITICAL') && this.settings?.admin_chat_id && this.env.BOT_TOKEN) {
      this.ctx.waitUntil(sendTelegramMessage(this.env.BOT_TOKEN, this.settings.admin_chat_id, `⚠️ [${level}] ${msg}`));
    }
  }

  async _persist(entry) {
    const logs = (await this.env.BOT_KV.get('system_logs', { type: 'json' })) || [];
    logs.unshift(entry);
    await this.env.BOT_KV.put('system_logs', JSON.stringify(logs.slice(0, 80)));
  }

  async clear() {
    await this.env.BOT_KV.delete('system_logs');
  }
}

export default {
  async scheduled(event, env, ctx) {
    const settings = await getSettings(env.BOT_KV);
    const logger = new SystemLogger(env, ctx, settings);
    try {
      await processAutoPost(env, settings, logger);
    } catch (e) {
      await logger.log('CRITICAL', `scheduled failed: ${e.message}`, true);
    }
  },

  async fetch(request, env, ctx) {
    const settings = await getSettings(env.BOT_KV);
    const logger = new SystemLogger(env, ctx, settings);
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env, settings, logger));
      return new Response('ok');
    }

    if (url.pathname === '/setup-webhook') {
      const result = await setupWebhook(url.origin, env);
      if (!result.ok) await logger.log('ERROR', `webhook set failed: ${result.description || 'unknown'}`, true);
      return json(result);
    }

    if (url.pathname.startsWith('/sub/')) {
      return handleSubscription(url, env);
    }

    if (!checkAuth(request, env)) {
      return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin Panel"' } });
    }

    if (url.pathname === '/api/settings') {
      if (request.method === 'GET') return json(settings);
      if (request.method === 'POST') {
        const input = await request.json();
        const merged = mergeSettings(settings, input);
        await env.BOT_KV.put('app_settings', JSON.stringify(merged));
        await logger.log('INFO', 'settings updated by admin');
        return json({ success: true });
      }
    }

    if (url.pathname === '/api/logs') {
      const logs = (await env.BOT_KV.get('system_logs', { type: 'json' })) || [];
      return json({ logs });
    }

    if (url.pathname === '/api/clear-logs') {
      await logger.clear();
      return json({ success: true });
    }

    if (url.pathname === '/api/clear-history') {
      const state = await getState(env);
      state.users = {};
      await saveState(env, state);
      await logger.log('WARN', 'daily user history cleared by admin');
      return json({ success: true });
    }

    return new Response('Worker is running', { status: 200 });
  }
};

function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !env.ADMIN_PASSWORD) return false;
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  try {
    const decoded = atob(encoded);
    const [, pass] = decoded.split(':');
    return pass === env.ADMIN_PASSWORD;
  } catch {
    return false;
  }
}

async function getSettings(kv) {
  if (!kv) return DEFAULT_SETTINGS;
  const raw = await kv.get('app_settings');
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function mergeSettings(base, incoming) {
  const mergedProtocols = { ...DEFAULT_PROTOCOLS_STATE };
  const protocolsInput = incoming?.protocols || {};
  for (const p of ALL_PROTOCOLS) {
    if (protocolsInput[p]) {
      mergedProtocols[p] = {
        enabled: !!protocolsInput[p].enabled,
        qty: Math.max(0, parseInt(protocolsInput[p].qty, 10) || 0)
      };
    }
  }
  return {
    ...base,
    ...incoming,
    channels: Array.isArray(incoming?.channels) ? incoming.channels.map(normalizeChannelRef).filter(Boolean) : base.channels,
    protocols: mergedProtocols
  };
}

async function handleTelegramUpdate(update, env, settings, logger) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);

  const adminAllowed = isAdminChat(chatId, env.ADMIN_CHAT_IDS) || chatId === String(settings.admin_chat_id || '');
  if (!adminAllowed) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, '⛔️ شما دسترسی ادمین ندارید.');
    return;
  }

  if (settings.rl_enabled) {
    const limited = await hitRateLimit(chatId, env, settings);
    if (limited) return sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ تعداد درخواست زیاد بود. کمی بعد تلاش کنید.');
  }

  const text = msg.text.trim();

  if (text === '/start' || text === '/help') {
    return sendTelegramMessage(env.BOT_TOKEN, chatId,
      '✅ ربات آماده است.\n\n' +
      '/addsource <@id|link|id>\n' +
      '/remsource <@id|link|id>\n' +
      '/listsources\n' +
      '/getnew [protocol|all] [qty]\n' +
      '/sub\n' +
      '/setchannel <chat_id>\n' +
      '/autopost on|off\n' +
      '/status\n'
    );
  }

  if (text.startsWith('/addsource')) {
    const ch = normalizeChannelRef(text.replace('/addsource', '').trim());
    if (!ch) return sendTelegramMessage(env.BOT_TOKEN, chatId, 'فرمت منبع معتبر نیست.');
    const s = await getState(env);
    if (!s.channels.includes(ch)) s.channels.push(ch);
    await saveState(env, s);
    await logger.log('INFO', `source added: ${ch}`);
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `✅ اضافه شد: ${ch}`);
  }

  if (text.startsWith('/remsource')) {
    const ch = normalizeChannelRef(text.replace('/remsource', '').trim());
    if (!ch) return sendTelegramMessage(env.BOT_TOKEN, chatId, 'فرمت منبع معتبر نیست.');
    const s = await getState(env);
    s.channels = s.channels.filter((x) => x !== ch);
    await saveState(env, s);
    await logger.log('INFO', `source removed: ${ch}`);
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `🗑 حذف شد: ${ch}`);
  }

  if (text === '/listsources') {
    const s = await getState(env);
    return sendTelegramMessage(env.BOT_TOKEN, chatId, s.channels.length ? s.channels.map((x) => `• ${x}`).join('\n') : 'هیچ منبعی ثبت نشده.');
  }

  if (text.startsWith('/setchannel')) {
    const target = text.replace('/setchannel', '').trim();
    if (!target) return sendTelegramMessage(env.BOT_TOKEN, chatId, 'chat_id را وارد کنید.');
    const next = { ...settings, channel_id: target };
    await env.BOT_KV.put('app_settings', JSON.stringify(next));
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `✅ channel_id تنظیم شد: ${target}`);
  }

  if (text.startsWith('/autopost')) {
    const mode = text.replace('/autopost', '').trim().toLowerCase();
    const enabled = mode === 'on';
    const next = { ...settings, channel_mode_enabled: enabled };
    await env.BOT_KV.put('app_settings', JSON.stringify(next));
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `✅ ارسال خودکار ${enabled ? 'فعال' : 'غیرفعال'} شد.`);
  }

  if (text === '/status') {
    const s = await getState(env);
    return sendTelegramMessage(env.BOT_TOKEN, chatId,
      `bot_mode: ${settings.bot_mode_enabled}\n` +
      `channel_mode: ${settings.channel_mode_enabled}\n` +
      `channel_id: ${settings.channel_id || '-'}\n` +
      `sources: ${s.channels.length}`
    );
  }

  if (text === '/sub') {
    const token = await getUserToken(chatId, env);
    const link = `https://${env.PUBLIC_HOSTNAME}/sub/${chatId}?token=${token}`;
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `🔗 لینک اشتراک:\n${link}`);
  }

  if (text.startsWith('/getnew')) {
    const [, rawProto = 'all', rawQty = '0'] = text.split(/\s+/);
    const requestedProto = normalizeProtocol(rawProto);
    const qty = Math.max(0, parseInt(rawQty, 10) || 0);
    const links = await collectTodaysNewConfigsForUser(chatId, env, settings, requestedProto, qty);
    if (!links.length) return sendTelegramMessage(env.BOT_TOKEN, chatId, 'امروز کانفیگ جدیدی پیدا نشد.');
    return sendChunked(env.BOT_TOKEN, chatId, links.join('\n'));
  }

  const direct = normalizeChannelRef(text);
  if (direct) {
    const s = await getState(env);
    if (!s.channels.includes(direct)) s.channels.push(direct);
    await saveState(env, s);
    return sendTelegramMessage(env.BOT_TOKEN, chatId, `✅ اضافه شد: ${direct}`);
  }
}

async function processAutoPost(env, settings, logger) {
  if (!settings.channel_mode_enabled || !settings.channel_id || !env.BOT_TOKEN) return;
  const chatId = String(settings.channel_id);
  const lines = await collectTodaysNewConfigsForUser(chatId, env, settings, 'all', 0);
  if (!lines.length) return;
  await sendChunked(env.BOT_TOKEN, chatId, lines.join('\n'));
  await logger.log('INFO', `auto-posted ${lines.length} new configs to channel ${chatId}`);
}

async function collectTodaysNewConfigsForUser(chatId, env, settings, protocol = 'all', qty = 0) {
  const state = await getState(env);
  if (state.channels.length === 0) return [];

  const dateKey = todayKey();
  const userState = state.users[chatId] || { date: dateKey, sent: {} };
  if (userState.date !== dateKey) {
    userState.date = dateKey;
    userState.sent = {};
  }

  let out = [];
  for (const channel of state.channels) {
    const todayLinks = await scrapeTodayConfigs(channel, settings.max_pages_per_channel || 10);
    const sentSet = new Set(userState.sent[channel] || []);
    const fresh = todayLinks.filter((line) => !sentSet.has(hash(line)));
    fresh.forEach((line) => sentSet.add(hash(line)));
    userState.sent[channel] = [...sentSet];
    out.push(...fresh);
  }

  state.users[chatId] = userState;
  await saveState(env, state);

  out = [...new Set(out)];
  out = applyProtocolFilter(out, settings, protocol, qty);
  return out;
}

function applyProtocolFilter(lines, settings, protocol, qty) {
  const categorized = new Map();
  for (const line of lines) {
    const p = classifyProtocol(line);
    if (!categorized.has(p)) categorized.set(p, []);
    categorized.get(p).push(line);
  }

  if (protocol !== 'all') {
    const arr = categorized.get(protocol) || [];
    return qty > 0 ? arr.slice(0, qty) : arr;
  }

  const active = Object.entries(settings.protocols || {})
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => ({ p: k, qty: parseInt(v.qty, 10) || 0 }));

  if (active.length === 0) return lines;

  const result = [];
  for (const row of active) {
    const arr = categorized.get(row.p) || [];
    const take = qty > 0 ? qty : row.qty;
    if (take > 0) result.push(...arr.slice(0, take));
  }

  return [...new Set(result)];
}

function classifyProtocol(line) {
  const low = line.toLowerCase();
  if (low.includes('.workers.dev') || low.includes('.pages.dev') || low.includes('.trycloudflare.com')) return 'cloudflare';
  const m = low.match(/^([a-z0-9\-]+):/);
  if (!m) return 'other';
  const raw = m[1];
  return PROTOCOL_ALIASES[raw] || raw;
}

async function scrapeTodayConfigs(channel, maxPages = 10) {
  const today = todayKey();
  const configs = [];
  let before = '';

  for (let i = 0; i < maxPages; i++) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) break;

    const html = await res.text();
    const messages = [...html.matchAll(/<div class="tgme_widget_message_wrap[\s\S]*?<\/div>\s*<\/div>/g)].map((m) => m[0]);
    if (!messages.length) break;

    let seenOlder = false;
    for (const msg of messages) {
      const dt = msg.match(/datetime="([^"]+)"/)?.[1] || '';
      const post = msg.match(/data-post="[^"]+\/(\d+)"/)?.[1] || '';
      if (post) before = post;

      if (!dt.startsWith(today)) {
        if (dt && dt < `${today}T00:00:00`) seenOlder = true;
        continue;
      }

      const decoded = decodeEntities(stripTags(msg));
      const links = [
        ...(decoded.match(CONFIG_REGEX) || []),
        ...(decoded.match(TG_PROXY_REGEX) || [])
      ].map((x) => x.trim());

      configs.push(...links);
    }

    if (seenOlder) break;
    await sleep(700);
  }

  return [...new Set(configs)];
}

async function handleSubscription(url, env) {
  const chatId = url.pathname.split('/').pop();
  const token = url.searchParams.get('token') || '';
  const expected = await getUserToken(chatId, env);
  if (!timingSafeEqual(token, expected)) return new Response('unauthorized', { status: 401 });

  const settings = await getSettings(env.BOT_KV);
  const lines = await collectTodaysNewConfigsForUser(chatId, env, settings, 'all', 0);
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function setupWebhook(origin, env) {
  const endpoint = `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${origin}/webhook` })
  });
  return res.json();
}

async function sendChunked(token, chatId, text) {
  for (let i = 0; i < text.length; i += 3500) {
    await sendTelegramMessage(token, chatId, text.slice(i, i + 3500));
  }
}

async function sendTelegramMessage(token, chatId, text) {
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function hitRateLimit(chatId, env, settings) {
  const key = `rl:${chatId}`;
  const now = Math.floor(Date.now() / 1000);
  const data = (await env.BOT_KV.get(key, { type: 'json' })) || { start: now, count: 0 };
  const windowSec = (parseInt(settings.rl_time, 10) || 60) * 60;
  const maxReq = parseInt(settings.rl_reqs, 10) || 8;

  if (now - data.start > windowSec) {
    data.start = now;
    data.count = 0;
  }

  data.count += 1;
  await env.BOT_KV.put(key, JSON.stringify(data), { expirationTtl: windowSec + 60 });
  return data.count > maxReq;
}

function normalizeChannelRef(input) {
  if (!input) return null;
  const clean = input.trim();
  if (!clean) return null;
  if (clean.startsWith('@')) return clean.slice(1).toLowerCase();
  if (/^https?:\/\/t\.me\//i.test(clean)) {
    const path = clean.replace(/^https?:\/\/t\.me\//i, '').split(/[/?#]/)[0];
    return path ? path.toLowerCase() : null;
  }
  if (/^[A-Za-z0-9_]{5,}$/.test(clean)) return clean.toLowerCase();
  return null;
}

function normalizeProtocol(input) {
  const val = String(input || 'all').toLowerCase();
  if (val === 'all') return 'all';
  return PROTOCOL_ALIASES[val] || val;
}

function stripTags(raw) {
  return raw.replace(/<[^>]*>/g, ' ');
}

function decodeEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function isAdminChat(chatId, rawAdmins) {
  const list = String(rawAdmins || '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.includes(String(chatId));
}

async function getState(env) {
  const raw = await env.BOT_KV.get('state', { type: 'json' });
  return raw || { channels: [], users: {} };
}

async function saveState(env, state) {
  await env.BOT_KV.put('state', JSON.stringify(state), { expirationTtl: 60 * 60 * 36 });
}

async function getUserToken(chatId, env) {
  const secret = env.SUBSCRIPTION_SECRET || 'change-me';
  return hash(`${chatId}:${secret}`);
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
