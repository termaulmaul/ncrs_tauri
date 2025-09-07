import { isTauri } from '@tauri-apps/api/core';
import * as fs from '@tauri-apps/plugin-fs';
import dayjs from 'dayjs';
import { APP_NAME } from '../../tauri/TauriProvider';
import type { CallRecordV2, HistoryV2File } from './types';

function nowIso() { return dayjs().toISOString(); }

function getBase() {
  // For dev reliability, prefer Downloads; switch to Documents for prod later if desired.
  return { baseDir: fs.BaseDirectory.Download as const, dir: `${APP_NAME}`, path: `${APP_NAME}/history_v2.json`, label: 'Downloads' };
}

export async function readHistoryV2(): Promise<HistoryV2File> {
  if (!isTauri()) return { version: 2, calls: [] };
  const base = getBase();
  try {
    await fs.mkdir(base.dir, { baseDir: base.baseDir, recursive: true });
    const text = await fs.readTextFile(base.path, { baseDir: base.baseDir });
    const json = JSON.parse(text);
    if (json && Array.isArray(json.calls)) return json as HistoryV2File;
  } catch {}
  return { version: 2, calls: [] };
}

export async function writeHistoryV2(data: HistoryV2File) {
  if (!isTauri()) return;
  const base = getBase();
  await fs.mkdir(base.dir, { baseDir: base.baseDir, recursive: true });
  await fs.writeTextFile(base.path, JSON.stringify(data, null, 2), { baseDir: base.baseDir });
}

export type LegacyRec = { id: string; code: string; roomName: string; bedName: string; callTime: string; responseTime?: string; status: 'active' | 'completed' };

export async function upsertFromLegacy(records: LegacyRec[]): Promise<HistoryV2File> {
  const existing = await readHistoryV2();
  const byId = new Map(existing.calls.map(c => [c.id, c] as const));
  for (const r of records) {
    const id = `${r.code || 'code'}-${r.callTime || r.id}`;
    const startedAt = r.callTime || nowIso();
    const endedAt = r.responseTime;
    const status = r.status === 'completed' || endedAt ? 'completed' : 'active';
    const durationSec = (endedAt && startedAt) ? dayjs(endedAt).diff(dayjs(startedAt), 'second') : undefined;
    const next: CallRecordV2 = {
      id,
      direction: 'system',
      code: r.code,
      room: r.roomName,
      bed: r.bedName,
      startedAt,
      endedAt,
      status,
      durationSec,
    };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, next);
    } else {
      // upgrade existing with end info/status if newly available
      const merged: CallRecordV2 = { ...prev };
      if (!merged.endedAt && next.endedAt) {
        merged.endedAt = next.endedAt;
        merged.status = 'completed';
        merged.durationSec = next.durationSec;
      }
      // don't resurrect soft-deleted
      byId.set(id, merged);
    }
  }
  const out: HistoryV2File = { version: 2, calls: Array.from(byId.values()) };
  await writeHistoryV2(out);
  return out;
}

export async function softDeleteRange(start?: string, end?: string, reason = 'range-clear') {
  const data = await readHistoryV2();
  const s = start ? dayjs(start).startOf('day') : null;
  const e = end ? dayjs(end).endOf('day') : null;
  const now = nowIso();
  data.calls = data.calls.map(c => {
    const t = dayjs(c.startedAt);
    const inFrom = s ? (t.isAfter(s) || t.isSame(s)) : true;
    const inTo = e ? (t.isBefore(e) || t.isSame(e)) : true;
    if (inFrom && inTo) {
      if (!c.deletedAt) { c.deletedAt = now; c.deletedReason = reason; }
    }
    return c;
  });
  await writeHistoryV2(data);
}

