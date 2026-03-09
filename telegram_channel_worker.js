/**
 * Cloudflare Worker - Telegram Channel Config Collector
 *
 * Features:
 * - Telegram bot webhook
 * - Add/remove/list channel sources (username, t.me URL, raw name)
 * - Scrape last 24h messages from Telegram public channel pages
 * - Extract all protocols used in this repo
 * - Smart per-chat history: only sends unseen configs in current day window
 * - Subscription endpoint for clients: /sub/<chatId>?token=<token>
 *
 * Required bindings:
 * - BOT_TOKEN (secret)
 * - BOT_ADMIN_ID (optional, only this user can manage sources if set)
 * - SUB_TOKEN_SECRET (secret for sub-token generation)
 * - DATA_KV (KV namespace)
 */

const PROTOCOLS = [
  'vmess', 'vless', 'trojan', 'ss', 'ssr', 'tuic', 'hysteria', 'hysteria2',
  'hy2', 'juicity', 'snell', 'anytls', 'ssh', 'wireguard', 'wg',
  'warp', 'socks', 'socks4', 'socks5', 'tg',
  'dns', 'nm-dns', 'nm-vless', 'slipnet-enc', 'slipnet', 'slipstream', 'dnstt'
];

const DEFAULT_STATE = {
  sources: ['@filembad', 'https://t.me/IranProxyPlus', 'Capoit']
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response('OK');
    }

    if (url.pathname.startsWith('/sub/')) {
      const chatId = url.pathname.split('/')[2];
      const token = url.searchParams.get('token') || '';
      if (!chatId || token !== await createSubToken(chatId, env.SUB_TOKEN_SECRET || 'change-me')) {
        return new Response('Unauthorized', { status: 401 });
      }
      const lines = await collectForChat(chatId, env);
      return new Response(btoa(lines.join('\n')), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/setup-webhook') {
      const webhookUrl = `${url.origin}/webhook`;
      const tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const data = await tg.text();
      return new Response(data, { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Worker alive');
  }
};

async function handleUpdate(update, env) {
  const msg = update?.message;
  if (!msg?.chat?.id || !msg?.text) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id || '');
  if (env.BOT_ADMIN_ID && userId !== String(env.BOT_ADMIN_ID)) {
    await sendMessage(env.BOT_TOKEN, chatId, '⛔️ دسترسی ندارید.');
    return;
  }

  const text = msg.text.trim();
  if (text.startsWith('/start')) {
    const token = await createSubToken(chatId, env.SUB_TOKEN_SECRET || 'change-me');
    const hint = `${env.PUBLIC_BASE_URL || 'https://YOUR_WORKER_DOMAIN'}/sub/${chatId}?token=${token}`;
    await sendMessage(env.BOT_TOKEN, chatId,
      '✅ ربات آماده است.\n\n' +
      'دستورات:\n' +
      '/add <source>\n/remove <source>\n/list\n/fetch\n/sub\n/reset-day\n\n' +
      `لینک اشتراک شما:\n${hint}`
    );
    return;
  }

  if (text.startsWith('/add ')) {
    const source = normalizeSource(text.slice(5));
    if (!source) return void sendMessage(env.BOT_TOKEN, chatId, 'فرمت منبع نامعتبر است.');
    const state = await getState(env.DATA_KV);
    if (!state.sources.includes(source)) state.sources.push(source);
    await env.DATA_KV.put('state', JSON.stringify(state));
    await sendMessage(env.BOT_TOKEN, chatId, `✅ اضافه شد: ${source}`);
    return;
  }

  if (text.startsWith('/remove ')) {
    const source = normalizeSource(text.slice(8));
    const state = await getState(env.DATA_KV);
    state.sources = state.sources.filter(s => s !== source);
    await env.DATA_KV.put('state', JSON.stringify(state));
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 حذف شد: ${source}`);
    return;
  }

  if (text === '/list') {
    const state = await getState(env.DATA_KV);
    const body = state.sources.length ? state.sources.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'خالی';
    await sendMessage(env.BOT_TOKEN, chatId, `📚 منابع:\n${body}`);
    return;
  }

  if (text === '/fetch') {
    const lines = await collectForChat(chatId, env);
    if (!lines.length) {
      await sendMessage(env.BOT_TOKEN, chatId, 'چیزی جدید در ۲۴ ساعت اخیر پیدا نشد.');
      return;
    }
    await sendChunked(env.BOT_TOKEN, chatId, lines);
    return;
  }

  if (text === '/sub') {
    const token = await createSubToken(chatId, env.SUB_TOKEN_SECRET || 'change-me');
    const link = `${env.PUBLIC_BASE_URL || 'https://YOUR_WORKER_DOMAIN'}/sub/${chatId}?token=${token}`;
    await sendMessage(env.BOT_TOKEN, chatId, `🔗 لینک اشتراک:\n${link}`);
    return;
  }

  if (text === '/reset-day') {
    await env.DATA_KV.delete(historyKey(chatId, todayKey()));
    await sendMessage(env.BOT_TOKEN, chatId, '♻️ تاریخچه امروز ریست شد.');
  }
}

async function collectForChat(chatId, env) {
  const state = await getState(env.DATA_KV);
  await cleanupOldHistory(chatId, env.DATA_KV);

  const dKey = todayKey();
  const sent = await getJson(env.DATA_KV, historyKey(chatId, dKey), []);
  const sentSet = new Set(sent);

  const fresh = [];
  for (const source of state.sources) {
    const channel = extractChannelName(source);
    if (!channel) continue;
    const messages = await scrapeChannelLastDay(channel);
    for (const line of extractConfigs(messages.join('\n'))) {
      const hash = await sha256(line);
      if (!sentSet.has(hash)) {
        sentSet.add(hash);
        fresh.push(line);
      }
    }
  }

  await env.DATA_KV.put(historyKey(chatId, dKey), JSON.stringify([...sentSet]), { expirationTtl: 60 * 60 * 36 });
  return fresh;
}

function extractConfigs(text) {
  const escaped = PROTOCOLS
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?:${escaped.join('|')}):(?://|/)[^\\s"'<>]+`, 'gi');
  const matches = text.match(pattern) || [];
  return [...new Set(matches.map(v => v.trim()))];
}

async function scrapeChannelLastDay(channelName) {
  const now = Date.now();
  const threshold = now - 24 * 60 * 60 * 1000;
  const out = [];

  let before = '';
  for (let page = 0; page < 8; page++) {
    const u = `https://t.me/s/${channelName}${before ? `?before=${before}` : ''}`;
    const res = await fetch(u, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CFWorker/1.0)' }
    });
    if (!res.ok) break;

    const html = await res.text();
    const blocks = [...html.matchAll(/<div class="tgme_widget_message[\s\S]*?<\/div>\s*<\/div>/g)];
    if (!blocks.length) break;

    let reachedOld = false;
    for (const block of blocks) {
      const b = block[0];
      const idMatch = b.match(/data-post="[^"]+\/(\d+)"/);
      if (idMatch) before = idMatch[1];

      const dt = b.match(/datetime="([^"]+)"/i)?.[1];
      const ts = dt ? Date.parse(dt) : NaN;
      if (!Number.isNaN(ts) && ts < threshold) {
        reachedOld = true;
        continue;
      }

      const textMatches = [...b.matchAll(/tgme_widget_message_text[\s\S]*?<\/div>/g)];
      for (const tm of textMatches) {
        out.push(stripHtml(tm[0]));
      }
    }

    if (reachedOld) break;
  }

  return out;
}

function stripHtml(v) {
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSource(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) return s;
  if (/^https?:\/\/t\.me\//i.test(s)) return s;
  if (/^[a-zA-Z0-9_]{4,}$/.test(s)) return `@${s}`;
  return '';
}

function extractChannelName(source) {
  if (source.startsWith('@')) return source.slice(1);
  const m = source.match(/t\.me\/([A-Za-z0-9_]+)/i);
  return m?.[1] || '';
}

function historyKey(chatId, dayKey) {
  return `history:${chatId}:${dayKey}`;
}

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function cleanupOldHistory(chatId, kv) {
  const today = todayKey();
  const markerKey = `history-marker:${chatId}`;
  const old = await kv.get(markerKey);
  if (old && old !== today) {
    await kv.delete(historyKey(chatId, old));
  }
  await kv.put(markerKey, today, { expirationTtl: 60 * 60 * 36 });
}

async function getState(kv) {
  const raw = await kv.get('state');
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw);
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.map(normalizeSource).filter(Boolean) : [...DEFAULT_STATE.sources]
    };
  } catch {
    return DEFAULT_STATE;
  }
}

async function getJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function sendChunked(token, chatId, lines) {
  let chunk = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > 3500) {
      await sendMessage(token, chatId, chunk.join('\n'));
      chunk = [];
      length = 0;
    }
    chunk.push(line);
    length += line.length + 1;
  }
  if (chunk.length) await sendMessage(token, chatId, chunk.join('\n'));
}

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
}

async function createSubToken(chatId, secret) {
  const input = new TextEncoder().encode(`${chatId}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const bytes = [...new Uint8Array(digest)].slice(0, 12);
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
