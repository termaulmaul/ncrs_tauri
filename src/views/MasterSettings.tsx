import { Button, Group, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as fs from '@tauri-apps/plugin-fs';
import { Command } from '@tauri-apps/plugin-shell';
import classes from './MasterSettings.module.css';

type MasterSettingsCfg = {
  com?: string;
  name?: string;
  masterType?: 'Commax' | 'AIPHONE' | string;
  bot?: string;
  idChat?: string;
  server?: string;
}

type Config = {
  masterSettings?: MasterSettingsCfg;
  [k: string]: any;
}

const PROJECT_PUBLIC = '/Users/maul/github/modern-desktop-app-template/public';
const CONFIG_PATH = `${PROJECT_PUBLIC}/config.json`;

export default function MasterSettings() {
  const [cfg, setCfg] = useState<MasterSettingsCfg>({});
  type PortOpt = { value: string; label: string };
  const [ports, setPorts] = useState<PortOpt[]>([]);
  const [connected, setConnected] = useState(false);
  const [monitor, setMonitor] = useState('');
  const [proc, setProc] = useState<any>(null);

  async function loadConfig() {
    try {
      const res = await fetch('/config.json?ts=' + Date.now());
      if (!res.ok) return;
      const json: Config = await res.json();
      setCfg(json.masterSettings || {});
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => { loadConfig(); }, []);
  // Reflect backend connection state immediately via Tauri events
  useEffect(() => {
    if (!isTauri()) return;
    let un1: any, un2: any;
    listen<string>('serial-connected', (e) => {
      setConnected(true);
      setMonitor(m => m + `\n[${new Date().toLocaleTimeString()}] Connected to ${e.payload || cfg.com}`);
    }).then(u => un1 = u);
    listen('serial-disconnected', () => {
      setConnected(false);
      setMonitor(m => m + `\n[${new Date().toLocaleTimeString()}] Disconnected.`);
    }).then(u => un2 = u);
    return () => { if (un1) un1(); if (un2) un2(); };
  }, [cfg.com]);
  // Try auto-connect with saved port if available
  useEffect(() => {
    if (!connected && cfg.com) {
      // Try promptly; backend events will update UI state instantly
      const id = setTimeout(() => { if (!connected) connect(); }, 200);
      return () => clearTimeout(id);
    }
  }, [cfg.com]);

  async function populateMasterComPorts() {
    try {
      let list: string[] = [];
      if (isTauri()) {
        try { list = await invoke<string[]>('serial_list_ports'); } catch {}
      }
      // Deduplicate cu./tty. pairs on macOS-like device names.
      const preferTTY = (arr: string[]) => {
        const pick = new Map<string, string>();
        const keyOf = (p: string) => {
          const i = p.lastIndexOf('.')
          return i >= 0 ? p.slice(i + 1) : p;
        };
        for (const p of arr) {
          const k = keyOf(p);
          const prev = pick.get(k);
          if (!prev) { pick.set(k, p); continue; }
          // prefer /dev/tty.* over /dev/cu.* when both exist
          if (p.includes('/dev/tty.') && !prev.includes('/dev/tty.')) pick.set(k, p);
        }
        return Array.from(pick.values());
      };
      const normalized = preferTTY(list);
      let opts: PortOpt[] = normalized.map(v => ({ value: v, label: v }));

      // If saved port not detected, but an equivalent base name exists, switch saved cfg to that value
      if (cfg.com && !normalized.includes(cfg.com)) {
        const savedKey = (() => { const i = cfg.com!.lastIndexOf('.'); return i >= 0 ? cfg.com!.slice(i + 1) : cfg.com!; })();
        const equiv = normalized.find(p => { const i = p.lastIndexOf('.'); return (i >= 0 ? p.slice(i + 1) : p) === savedKey; });
        if (equiv) {
          setCfg(s => ({ ...s, com: equiv }));
        } else {
          // still show saved if no equivalent among detected ports
          opts = [{ value: cfg.com, label: `${cfg.com} (saved)` }, ...opts];
        }
      }
      setPorts(opts);
    } catch (e) {
      console.error('listPorts', e);
    }
  }
  // refresh on mount and periodically to keep list up to date
  useEffect(() => {
    populateMasterComPorts();
    const id = window.setInterval(populateMasterComPorts, 5000);
    return () => window.clearInterval(id);
  }, [cfg.com]);

  async function connect() {
    if (!cfg.com) return;
    try {
      await invoke('serial_connect', { port: cfg.com });
      const unlisten1 = await listen<string>('serial-data', e => setMonitor(m => m + e.payload));
      const unlisten2 = await listen('serial-standby-ok', () => window.dispatchEvent(new Event('serial-standby-ok')));
      setProc({ unlisten1, unlisten2 } as any);

      // Await confirmation via events to avoid false-positive connects
      const ok = await new Promise<boolean>(async (resolve) => {
        let done = false;
        const t = window.setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3000);
        const u1 = await listen<string>('serial-connected', (e) => {
          if (done) return; done = true;
          try { window.clearTimeout(t); } catch {}
          resolve(true);
        });
        const u2 = await listen<string>('serial-error', (e) => {
          if (done) return; done = true;
          try { window.clearTimeout(t); } catch {}
          resolve(false);
        });
        // ensure cleanup after settle
        const cleanup = (r: boolean) => { try { (u1 as any)(); } catch {}; try { (u2 as any)(); } catch {}; return r; };
        // wrap resolve to run cleanup
        const origResolve = resolve as any;
      });
      if (ok) {
        setConnected(true);
        setMonitor(m => m + `\n[${new Date().toLocaleTimeString()}] Connected to ${cfg.com} @9600`);
        notifications.show({ title: 'Hardware Successfully Connected', message: `Connected to ${cfg.com}`, color: 'teal' });
      } else {
        setConnected(false);
        notifications.show({ title: 'Connect failed', message: `Port ${cfg.com} not available`, color: 'red' });
      }
    } catch (e) {
      notifications.show({ title: 'Connect failed', message: String(e), color: 'red' });
    }
  }
  async function disconnect() {
    try {
      await invoke('serial_disconnect');
      if (proc?.unlisten1) await proc.unlisten1();
      if (proc?.unlisten2) await proc.unlisten2();
    } catch {}
    setConnected(false);
    setProc(null);
    setMonitor(m => m + `\n[${new Date().toLocaleTimeString()}] Disconnected.`);
    notifications.show({ title: 'Hardware Disconnected', message: 'Hardware has been disconnected.', color: 'gray' });
  }

  async function save() {
    try {
      const res = await fetch('/config.json?ts=' + Date.now());
      const json: Config = res.ok ? await res.json() : {};
      json.masterSettings = cfg;
      const blob = JSON.stringify(json, null, 2);
      if (isTauri()) {
        await fs.writeTextFile(CONFIG_PATH, blob);
        notifications.show({ title: 'Master Settings', message: 'Tersimpan ke config.json', color: 'teal' });
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
        link.download = 'config.json';
        link.click();
        notifications.show({ title: 'Master Settings', message: 'Unduhan config.json siap. Ganti file public/config.json Anda.', color: 'teal' });
      }
    } catch (e) {
      notifications.show({ title: 'Gagal menyimpan', message: String(e), color: 'red' });
    }
  }

  return (
    <Stack>
      <Title order={3}>Master Settings</Title>
      <div className={classes.wrap}>
        <div className={classes.panel}>
          <Text fw={700}>COM Port</Text>
          <Select placeholder="Pilih port" data={ports} value={cfg.com} onChange={(v) => setCfg(s => ({ ...s, com: v || '' }))} allowDeselect={false} searchable nothingFoundMessage="No ports found" />
          <Text size="xs" c="dimmed" mt={6}>Baud rate must be 9600</Text>
          <Group mt="sm">
            {!connected ? (
              <Button leftSection={<span>🔌</span>} onClick={connect} disabled={!cfg.com}>Connect</Button>
            ) : (
              <Button color="gray" onClick={disconnect}>Disconnect</Button>
            )}
            <Text size="sm">Status: {connected ? 'Connected' : 'Disconnected'}</Text>
              <Button variant="light" size="xs" onClick={populateMasterComPorts}>Refresh Ports</Button>
          </Group>
          <Textarea className={classes.monitor} label="Serial Monitor" value={monitor} onChange={e => setMonitor(e.currentTarget.value)} autosize minRows={6} maxRows={10} mt="md" />
          <Button variant="light" mt="xs" onClick={() => setMonitor('')}>Clear Log</Button>
        </div>

        <div className={classes.panel}>
          <TextInput label="Name" value={cfg.name || ''} onChange={e => setCfg(s => ({ ...s, name: e.currentTarget.value }))} />
          <Select label="Master" data={[{value:'Commax',label:'Commax'},{value:'AIPHONE',label:'AIPHONE'}]} value={cfg.masterType || 'Commax'} onChange={(v) => setCfg(s => ({ ...s, masterType: (v as any) }))} mt="sm" />
          <TextInput label="Bot" value={cfg.bot || ''} onChange={e => setCfg(s => ({ ...s, bot: e.currentTarget.value }))} mt="sm" />
          <TextInput label="ID Chat" value={cfg.idChat || ''} onChange={e => setCfg(s => ({ ...s, idChat: e.currentTarget.value }))} mt="sm" />
          <TextInput label="Server" placeholder="Server" value={cfg.server || ''} onChange={e => setCfg(s => ({ ...s, server: e.currentTarget.value }))} mt="sm" />
          <Group justify="flex-end" mt="md">
            <Button onClick={save}>Save</Button>
          </Group>
        </div>
      </div>
    </Stack>
  );
}
