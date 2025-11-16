/**
 * netlify/functions/telegram-webhook.js
 * Premium-style Telegram webhook handler for Netlify functions
 *
 * Features:
 * - Clean command routing (/start, /profile, /setpayment, /getpayments)
 * - Admin-only setpayment with validation
 * - Airtable read/write (if configured)
 * - Rate limiting (per-chat simple in-memory, suitable for light usage)
 * - Robust error handling & always-return-200 to prevent Telegram flooding
 * - Helpful logs for Netlify function console
 *
 * Env variables required:
 * - TELEGRAM_BOT_TOKEN
 * Optional for Airtable:
 * - AIRTABLE_API_KEY
 * - AIRTABLE_BASE_ID
 * - AIRTABLE_TABLE (default: Payments)
 * Optional admin control:
 * - TELEGRAM_ADMIN_IDS  (comma-separated numeric Telegram user IDs)
 *
 * Note: This is intended for Netlify serverless functions (short-living).
 * Keep handlers lightweight to avoid function timeouts (~10s).
 */

const fetch = require('node-fetch');

// ---- Config from environment ----
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Payments';
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Basic validations
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set! Webhook will not work.');
}

// ---- Utilities ----
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
async function tg(method, body) {
  const url = `${TELEGRAM_API_BASE}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Telegram API error ${res.status}:`, text);
  }
  return res.json().catch(() => null);
}

function safeText(s) {
  return String(s || '').replace(/[*_`[\]]/g, ''); // avoid markdown messing
}

// ---- Simple in-memory rate limiter (per-chat, short-lived) ----
const RATE_LIMIT_WINDOW_MS = 5000; // 5s window
const RATE_LIMIT_MAX = 3; // max messages
const rateMap = new Map(); // chatId -> {count, resetAt}

function allowRate(chatId) {
  try {
    const now = Date.now();
    let data = rateMap.get(chatId);
    if (!data || now > data.resetAt) {
      data = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateMap.set(chatId, data);
      return true;
    }
    if (data.count < RATE_LIMIT_MAX) {
      data.count += 1;
      return true;
    }
    return false;
  } catch (e) {
    return true;
  }
}

// ---- Airtable helpers (lightweight) ----
async function airtableGetAll() {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return [];
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?pageSize=50&view=Grid%20view`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  if (!res.ok) {
    console.error('Airtable GET failed', res.status);
    return [];
  }
  const j = await res.json();
  return j.records || [];
}

async function airtableCreateOrUpdate(provider, details) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) throw new Error('Airtable not configured');
  // Try find existing
  const filter = `AND({Provider}="${provider}")`;
  const findUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${encodeURIComponent(filter)}`;
  const found = await fetch(findUrl, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } });
  const foundJson = await found.json().catch(()=>({ records: [] }));
  if (foundJson.records && foundJson.records.length) {
    const rec = foundJson.records[0];
    const patchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${rec.id}`;
    const patched = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { Provider: provider, Details: details } })
    });
    return patched.json();
  } else {
    const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
    const created = await fetch(createUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { Provider: provider, Details: details } })
    });
    return created.json();
  }
}

// ---- Command router ----
const ALLOWED_PROVIDERS = ['jazzcash', 'easypaisa'];

async function handleCommand(chatId, userId, text, message) {
  // rate limit
  if (!allowRate(chatId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Slow down, boss — too many commands at once. 😅' });
    return;
  }

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // /start
  if (cmd === '/start' || cmd === 'start') {
    const reply = [
      '*Welcome to VHub — Premium Edition!*',
      '',
      'Available commands:',
      '/start — show this help',
      '/profile — view your basic profile',
      '/setpayment <provider> <details> — admin only',
      '/getpayments — list payment methods',
      '',
      'Providers: jazzcash, easypaisa'
    ].join('\n');
    await tg('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'Markdown' });
    return;
  }

  // /profile
  if (cmd === '/profile' || cmd === '/me') {
    const name = (message.from && (message.from.first_name || message.from.username)) || 'User';
    const profileMsg = `*Profile*\nName: ${safeText(name)}\nID: ${userId}\nTelegram: ${message.from && message.from.username ? '@' + safeText(message.from.username) : '—'}`;
    await tg('sendMessage', { chat_id: chatId, text: profileMsg, parse_mode: 'Markdown' });
    return;
  }

  // /setpayment <provider> <details>
  if (cmd === '/setpayment' || cmd === 'setpayment') {
    // Admin check
    const isAdmin = ADMIN_IDS.length ? ADMIN_IDS.includes(String(userId)) : true;
    if (!isAdmin) {
      await tg('sendMessage', { chat_id: chatId, text: 'Only admin(s) can use /setpayment.' });
      return;
    }
    if (parts.length < 3) {
      await tg('sendMessage', { chat_id: chatId, text: 'Usage: /setpayment <provider> <details>\nExample: /setpayment easypaisa 03xx-xxxxxxx' });
      return;
    }
    const provider = parts[1].toLowerCase();
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      await tg('sendMessage', { chat_id: chatId, text: `Invalid provider. Allowed: ${ALLOWED_PROVIDERS.join(', ')}` });
      return;
    }
    const details = parts.slice(2).join(' ');
    try {
      if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
        await airtableCreateOrUpdate(provider, details);
        await tg('sendMessage', { chat_id: chatId, text: `✅ Updated *${provider}* details.`, parse_mode: 'Markdown' });
      } else {
        // fallback: echo back if no airtable
        await tg('sendMessage', { chat_id: chatId, text: `Configured ${provider}: ${details}` });
      }
    } catch (err) {
      console.error('setpayment error', err);
      await tg('sendMessage', { chat_id: chatId, text: 'Failed to update payment details — check server logs.' });
    }
    return;
  }

  // /getpayments
  if (cmd === '/getpayments' || cmd === '/payments') {
    try {
      const records = await airtableGetAll();
      if (!records || !records.length) {
        await tg('sendMessage', { chat_id: chatId, text: 'No payment details configured yet.' });
        return;
      }
      let out = '*Current Payment Details:*\n';
      records.forEach(r => {
        const f = r.fields || {};
        out += `\n- *${safeText(f.Provider || 'unknown')}*: ${safeText(f.Details || '')}`;
      });
      await tg('sendMessage', { chat_id: chatId, text: out, parse_mode: 'Markdown' });
    } catch (err) {
      console.error('getpayments error', err);
      await tg('sendMessage', { chat_id: chatId, text: 'Error reading payment details.' });
    }
    return;
  }

  // unknown slash
  if (text.startsWith('/')) {
    await tg('sendMessage', { chat_id: chatId, text: 'Unknown command. Use /start to see available commands.' });
    return;
  }

  // default: non-command message
  await tg('sendMessage', { chat_id: chatId, text: 'I only understand a few commands for now. Try /start.' });
}

// ---- Netlify handler ----
exports.handler = async function (event, context) {
  // Always respond 200 quickly to Telegram to avoid too many retries.
  // But we still try to process; if processing takes too long server may timeout — keep logic light.
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 200, body: 'ok' };
    }
    let body = {};
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }

    // Support common update shapes:
    const update = body;
    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message) || {};
    const text = (message.text || '').trim();
    const chatId = (message.chat && message.chat.id) || (update.message && update.message.chat && update.message.chat.id) || null;
    const fromId = (message.from && message.from.id) || (update.message && update.message.from && update.message.from.id) || null;

    // If there's no chat or text, just return success so Telegram stops retrying
    if (!chatId) {
      console.log('No chat id in update, ignoring.', JSON.stringify(Object.keys(update)).slice(0,200));
      return { statusCode: 200, body: 'ok' };
    }

    // Process command; do not block returning 200 (we still await for reliability)
    // IMPORTANT: Keep operations reasonably quick to avoid Netlify timeouts.
    // We'll process and then return.
    await handleCommand(chatId, fromId, text || '', message);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Handler top-level error', err);
    return { statusCode: 200, body: 'ok' }; // always 200 to assure Telegram
  }
};
