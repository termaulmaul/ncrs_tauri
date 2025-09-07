import dayjs from 'dayjs';

type TelegramCfg = { bot?: string; idChat?: string };

let cachedCfg: TelegramCfg | null = null;
let lastLoad = 0;

async function loadCfg(): Promise<TelegramCfg> {
  const now = Date.now();
  if (cachedCfg && now - lastLoad < 10_000) return cachedCfg;
  try {
    const res = await fetch('/config.json?ts=' + now);
    if (!res.ok) return {};
    const json = await res.json();
    const ms = json?.masterSettings || {};
    cachedCfg = { bot: ms.bot || '', idChat: ms.idChat || '' };
    lastLoad = now;
    return cachedCfg;
  } catch {
    return {};
  }
}

export async function sendTelegram(text: string): Promise<boolean> {
  const { bot, idChat } = await loadCfg();
  if (!bot || !idChat) return false;
  const url = `https://api.telegram.org/bot${encodeURIComponent(bot)}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: idChat, text })
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function fmtTs(dt = new Date()) {
  return dayjs(dt).format('DD/MM/YY, HH:mm:ss');
}

export function buildTriggerMessage(room?: string, bed?: string, when?: Date) {
  const line2 = room ? `${room}${bed ? ' - ' + bed : ''}` : '';
  return [
    '🚨 NURSE CALL',
    line2,
    fmtTs(when),
  ].filter(Boolean).join('\n');
}

export function buildResponseMessage(room?: string, bed?: string, when?: Date, durationSec?: number) {
  const line2 = room ? `${room}${bed ? ' - ' + bed : ''}` : '';
  const dur = typeof durationSec === 'number' ? durationSec : undefined;
  const durLine = typeof dur === 'number' ? `Durasi : ${dur} detik` : undefined;
  return [
    '✅ NURSE RESPONSE',
    line2,
    fmtTs(when),
    durLine,
  ].filter(Boolean).join('\n');
}

