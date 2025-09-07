import { Button, Group, Space, Text, Title } from '@mantine/core';
import SimpleBar from 'simplebar-react';
import { useEffect } from 'react';
import dayjs from 'dayjs';
import { isTauri } from '@tauri-apps/api/core';
import * as fs from '@tauri-apps/plugin-fs';
import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { join, sanitizeFilename, downloadFile } from '../common/utils';
import { buildSimplePdf } from '../common/pdf';
import { APP_NAME, useTauriContext } from '../tauri/TauriProvider';
import { createStorage } from '../tauri/storage';
import classes from './CallHistory.module.css';
import { upsertFromLegacy, readHistoryV2, softDeleteRange } from '../lib/history/store';

type Status = 'active' | 'completed';
type CallRecord = {
  id: string;
  code: string;
  roomName: string;
  bedName: string;
  callTime: string; // ISO
  responseTime?: string; // ISO
  status: Status;
};

export default function CallHistory() {
  const { documents, fileSep } = useTauriContext();
  const storeName = isTauri() ? join(fileSep, documents!, APP_NAME, 'call_history.json') : 'call_history';
  const { use: useKVP, loading } = createStorage(storeName);
  const [callHistory, setCallHistory] = useKVP('callHistory', [] as CallRecord[]);
  const [callHistoryStorage, setCallHistoryStorage] = useKVP('callHistoryStorage', [] as CallRecord[]);

  // filters
  const [from, setFrom] = useKVP('filter_from', '');
  const [to, setTo] = useKVP('filter_to', '');

  // derived
  const records: CallRecord[] = (callHistory ?? []).slice().sort((a, b) => (b.callTime.localeCompare(a.callTime)));
  const filtered = records.filter(r => {
    const d = dayjs(r.callTime);
    const inFrom = from ? d.isAfter(dayjs(from).startOf('day')) || d.isSame(dayjs(from).startOf('day')) : true;
    const inTo = to ? d.isBefore(dayjs(to).endOf('day')) || d.isSame(dayjs(to).endOf('day')) : true;
    return inFrom && inTo;
  });
  const activeCount = filtered.filter(r => r.status === 'active').length;
  const totalCount = filtered.length;

  function fmt(ts?: string) {
    return ts ? dayjs(ts).format('DD/MM/YYYY HH:mm:ss') : '-';
  }
  function duration(a?: string, b?: string) {
    if (!a || !b) return '-';
    const diff = dayjs(b).diff(dayjs(a), 'second');
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
  }

  function printReport() {
    try {
      console.log('[PrintReport] clicked', { isTauri: isTauri(), rows: filtered.length });
    } catch {}
    // Build a friendly filename from date range and counts.
    const today = dayjs().format('YYYY-MM-DD');
    const range = from && to
      ? `${dayjs(from).format('YYYYMMDD')}-${dayjs(to).format('YYYYMMDD')}`
      : from
        ? `${dayjs(from).format('YYYYMMDD')}-to-present`
        : to
          ? `until-${dayjs(to).format('YYYYMMDD')}`
          : 'all';
    const count = filtered.length;
    const base = sanitizeFilename(`${today}_CallHistory_${range}_${count}rows`);

    // Prepare monospaced header + table text
    const header: string[] = [
      'Call History Report',
      `Printed: ${dayjs().format('DD/MM/YYYY HH:mm')}`,
      `Filter: ${from ? dayjs(from).format('DD/MM/YYYY') : 'All'} - ${to ? dayjs(to).format('DD/MM/YYYY') : 'All'}`,
      `Total: ${filtered.length}`,
      '',
    ];
    const columns = [
      { h: 'Room', w: 16, get: (r: CallRecord) => r.roomName || '' },
      { h: 'Bed', w: 10, get: (r: CallRecord) => r.bedName || '' },
      { h: 'Call Time', w: 19, get: (r: CallRecord) => fmt(r.callTime) },
      { h: 'Response', w: 19, get: (r: CallRecord) => fmt(r.responseTime) },
      { h: 'Durasi', w: 8, get: (r: CallRecord) => duration(r.callTime, r.responseTime) },
      { h: 'Status', w: 9, get: (r: CallRecord) => (r.status === 'active' ? 'Active' : 'Completed') },
    ];
    function fixWidth(text: string, width: number) {
      const s = (text ?? '').toString();
      return s.length > width ? s.slice(0, width) : s.padEnd(width, ' ');
    }
    const headerRow = columns.map(c => fixWidth(c.h, c.w)).join(' ');
    const sep = columns.map(c => ''.padEnd(c.w, '-')).join(' ');
    const body: string[] = [headerRow, sep, ...filtered.map(r => columns.map(c => fixWidth(c.get(r), c.w)).join(' '))];

    const pdfBlob = buildSimplePdf(header, body, {
      title: base,
      author: 'NCRS',
      pageWidth: 595.28,
      pageHeight: 841.89,
      margin: 36,
      fontSize: 10,
      lineHeight: 12,
    });
    const filename = `${base}.pdf`;
    if (isTauri()) {
      // Save into Documents/APP_NAME/Reports on desktop reliably
      (async () => {
        try {
          // Prefer Downloads to avoid strict Documents sandbox issues on macOS dev
          await fs.mkdir(`${APP_NAME}/Reports`, { baseDir: fs.BaseDirectory.Download, recursive: true });
          const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
          await fs.writeFile(`${APP_NAME}/Reports/${filename}`, bytes, { baseDir: fs.BaseDirectory.Download });
          // Optional: quick feedback
          console.log(`Saved: Downloads/${APP_NAME}/Reports/${filename}`);
          try { await message(`Saved to Downloads/${APP_NAME}/Reports/${filename}`, { title: 'Report Saved' }); } catch {}
        } catch (e) {
          console.error('Failed saving PDF via Tauri FS, falling back to browser download', e);
          try { await message('Failed saving PDF via Tauri FS. Falling back to browser download.', { title: 'Report Save Error' }); } catch {}
          downloadFile(filename, pdfBlob, 'application/pdf');
        }
      })();
    } else {
      // Browser (dev)
      downloadFile(filename, pdfBlob, 'application/pdf');
    }
  }
  // Writable config helpers (currently unused for load; kept for future)
  async function readWritableConfig(): Promise<any | null> {
    if (!isTauri()) return null;
    const candidates: { baseDir: fs.BaseDirectory; path: string }[] = [
      { baseDir: fs.BaseDirectory.Document, path: `${APP_NAME}/config.json` },
      { baseDir: fs.BaseDirectory.AppData, path: `${APP_NAME}/config.json` },
      { baseDir: fs.BaseDirectory.Download, path: `${APP_NAME}/config.json` },
    ];
    for (const c of candidates) {
      try {
        const text = await fs.readTextFile(c.path, { baseDir: c.baseDir });
        return JSON.parse(text);
      } catch {}
    }
    return null;
  }

  async function writeWritableConfig(json: any): Promise<string | null> {
    if (!isTauri()) return null;
    const text = JSON.stringify(json, null, 2);
    const candidates: { baseDir: fs.BaseDirectory; path: string; label: string }[] = [
      { baseDir: fs.BaseDirectory.Document, path: `${APP_NAME}/config.json`, label: 'Documents' },
      { baseDir: fs.BaseDirectory.AppData, path: `${APP_NAME}/config.json`, label: 'AppData' },
      { baseDir: fs.BaseDirectory.Download, path: `${APP_NAME}/config.json`, label: 'Downloads' },
    ];
    for (const c of candidates) {
      try {
        const dir = c.path.split('/').slice(0, -1).join('/');
        if (dir) await fs.mkdir(dir, { baseDir: c.baseDir, recursive: true });
        await fs.writeTextFile(c.path, text, { baseDir: c.baseDir });
        return `${c.label}/${c.path}`;
      } catch {}
    }
    return null;
  }

  function mapConfigToRecords(arr: any[]): CallRecord[] {
    return arr.map((x) => ({
      id: String(x.id ?? crypto.randomUUID()),
      code: String(x.code ?? ''),
      roomName: String(x.room ?? x.roomName ?? ''),
      bedName: String(x.bed ?? x.bedName ?? ''),
      callTime: String(x.timestamp ?? x.callTime ?? ''),
      responseTime: x.resetTime ?? x.responseTime,
      status: (x.status === 'active' ? 'active' : 'completed') as Status,
    }));
  }

  async function clearHistory() {
    const start = from ? dayjs(from).startOf('day') : null;
    const end = to ? dayjs(to).endOf('day') : null;
    const keep = (r: CallRecord) => {
      const d = dayjs(r.callTime);
      const inFrom = start ? (d.isAfter(start) || d.isSame(start)) : true;
      const inTo = end ? (d.isBefore(end) || d.isSame(end)) : true;
      return !(inFrom && inTo);
    };
    const next = (callHistory ?? []).filter(keep);
    setCallHistory(() => next);
    setCallHistoryStorage(() => next);

    if (isTauri()) {
      try {
        // Always update public/config.json in dev to stay in sync with serial.rs appends
        let json: any = {};
        try {
          const res = await fetch(`/config.json?ts=${Date.now()}`);
          if (res.ok) json = await res.json();
        } catch {}
        const nextRaw = (json?.callHistoryStorage ?? []).filter((x: any) => {
          const ts = String(x.timestamp ?? x.callTime ?? '');
          if (!ts) return true;
          const d = dayjs(ts);
          const inFrom = start ? (d.isAfter(start) || d.isSame(start)) : true;
          const inTo = end ? (d.isBefore(end) || d.isSame(end)) : true;
          return !(inFrom && inTo);
        });
        const out = { ...json, callHistoryStorage: nextRaw };
        await invoke('write_public_config', { text: JSON.stringify(out, null, 2) });
        // Also mark soft-deleted in V2 for audit
        try { await softDeleteRange(from || undefined, to || undefined, 'range-clear'); } catch {}
        try { await message(`History cleared${start || end ? ' for selected date range' : ''}.`, { title: 'Call History' }); } catch {}
      } catch (e) {
        console.error('Failed writing public config.json', e);
      }
    }
  }

  // Sync from public/config.json -> callHistoryStorage (dev: serial.rs writes here)
  async function loadFromConfig() {
    try {
      const res = await fetch(`/config.json?ts=${Date.now()}`);
      if (!res.ok) return;
      const json = await res.json();
      const arr: any[] = json?.callHistoryStorage ?? [];
      const mapped: CallRecord[] = mapConfigToRecords(arr);
      setCallHistory(() => mapped);
      setCallHistoryStorage(() => mapped);

      // Update V2 store and prefer it for rendering (exclude soft-deleted)
      try {
        await upsertFromLegacy(mapped.map(m => ({ id: m.id, code: m.code, roomName: m.roomName, bedName: m.bedName, callTime: m.callTime, responseTime: m.responseTime, status: m.status })));
        const v2 = await readHistoryV2();
        const projected: CallRecord[] = v2.calls
          .filter(c => !c.deletedAt)
          .map(c => ({ id: c.id, code: c.code || '', roomName: c.room || '', bedName: c.bed || '', callTime: c.startedAt, responseTime: c.endedAt, status: (c.status === 'completed' ? 'completed' : 'active') as Status }));
        setCallHistory(() => projected);
        setCallHistoryStorage(() => projected);
      } catch {}
    } catch (e) {
      console.error('Failed loading config.json', e);
    }
  }

  // initial + periodic sync (every 5s) — wait until storage finished loading
  useEffect(() => {
    if (loading) return;
    loadFromConfig();
    const id = window.setInterval(loadFromConfig, 5000);
    return () => window.clearInterval(id);
  }, [loading]);

  return (
    <div className={classes.wrap}>
      <div className={classes.headerRow}>
        <Title order={3}>Call History <Text span fw={700}>({totalCount})</Text></Title>
        <div className={classes.stats}>
          <div className={classes.chart}>
            <div className={`${classes.bar} ${classes.barActive}`} style={{ height: `${Math.max(activeCount, 1) * 6}px` }} />
            <div className={`${classes.bar} ${classes.barCompleted}`} style={{ height: `${Math.max(totalCount - activeCount, 1) * 6}px` }} />
          </div>
          <Text size="sm">Active: {activeCount} • Completed: {totalCount - activeCount}</Text>
        </div>
      </div>

      <div className={`${classes.controls} ${classes.noPrint}`}>
        <label>
          <Text size="sm" span>From: </Text>
          <input type="date" value={from} onChange={e => setFrom(() => e.currentTarget.value)} />
        </label>
        <label>
          <Text size="sm" span>To: </Text>
          <input type="date" value={to} onChange={e => setTo(() => e.currentTarget.value)} />
        </label>
        <Group gap="xs">
          <Button size="xs" onClick={printReport}>Print Report</Button>
          <Button size="xs" variant="light" onClick={() => { setFrom(() => ''); setTo(() => ''); }}>Clear Filter</Button>
          {import.meta.env.DEV && <Button size="xs" color="red" variant="light" onClick={clearHistory}>Clear History</Button>}
        </Group>
      </div>

      <div className={classes.tableWrap}>
        {filtered.length === 0 ? (
          <div className={classes.empty}>No call history yet</div>
        ) : (
          <SimpleBar className={classes.tableScroll} autoHide={true}>
            <table className={classes.table}>
              <thead>
                <tr>
                  <th className={classes.codeCol}>Code</th>
                  <th>Room</th>
                  <th>Bed</th>
                  <th>Call Time</th>
                  <th>Response Time</th>
                  <th>Durasi</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(rec => (
                  <tr key={rec.id}>
                    <td className={classes.codeCol}>{rec.code}</td>
                    <td>{rec.roomName}</td>
                    <td>{rec.bedName}</td>
                    <td>{fmt(rec.callTime)}</td>
                    <td>{fmt(rec.responseTime)}</td>
                    <td>{duration(rec.callTime, rec.responseTime)}</td>
                    <td>
                      <span className={`${classes.statusBadge} ${rec.status === 'active' ? classes.active : classes.completed}`}>
                        {rec.status === 'active' ? 'Active' : 'Completed'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SimpleBar>
        )}
      </div>
      <Space h={8} />
      <Text size="xs" c="dimmed">Data persists to config file and auto-saves; chart and sync are simplified placeholders.</Text>

      {/* Print-only clean view (no scroll wrappers, prints all rows) */}
      <div className={classes.printOnly}>
        <Title order={3}>Call History Report</Title>
        <Text size="sm">Printed: {dayjs().format('DD/MM/YYYY HH:mm')}</Text>
        <Text size="sm">Filter: {from ? dayjs(from).format('DD/MM/YYYY') : 'All'} — {to ? dayjs(to).format('DD/MM/YYYY') : 'All'}</Text>
        <Text size="sm">Total: {filtered.length}</Text>
        <Space h={8} />
        <table className={classes.printTable}>
          <thead>
            <tr>
              <th>Room</th>
              <th>Bed</th>
              <th>Call Time</th>
              <th>Response Time</th>
              <th>Durasi</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(rec => (
              <tr key={`print-${rec.id}`}>
                <td>{rec.roomName}</td>
                <td>{rec.bedName}</td>
                <td>{fmt(rec.callTime)}</td>
                <td>{fmt(rec.responseTime)}</td>
                <td>{duration(rec.callTime, rec.responseTime)}</td>
                <td>{rec.status === 'active' ? 'Active' : 'Completed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
