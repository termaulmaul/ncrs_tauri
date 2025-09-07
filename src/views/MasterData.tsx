import { Button, Checkbox, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import SimpleBar from 'simplebar-react';
import { notifications } from '@mantine/notifications';
import { useEffect, useMemo, useState } from 'react';
import { downloadFile } from '../common/utils';
import classes from './MasterData.module.css';
import { isTauri } from '@tauri-apps/api/core';
import * as fs from '@tauri-apps/plugin-fs';
import * as devmode from '../lib/devmode';

type Row = {
  id: number;
  charCode: string;
  roomName: string;
  bedName: string;
  shape: 'NC' | 'KM' | string;
  v1?: string; v2?: string; v3?: string; v4?: string; v5?: string; v6?: string;
};

type Config = {
  masterData?: Row[];
  [k: string]: any;
};

export default function MasterData() {
  const [config, setConfig] = useState<Config>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');

  // Absolute paths for local dev save/import (Tauri)
  const PROJECT_PUBLIC = '/Users/maul/github/modern-desktop-app-template/public';
  const CONFIG_PATH = `${PROJECT_PUBLIC}/config.json`;
  const SOUND_DIR = `${PROJECT_PUBLIC}/sounds`;

  // load config.json from public
  async function loadConfig() {
    try {
      const res = await fetch('/config.json?_=' + Date.now());
      if (!res.ok) return;
      const json: Config = await res.json();
      setConfig(json);
      setRows((json.masterData || []).map(r => ({ ...r })));
    } catch (e) {
      console.error('Failed to load config.json', e);
    }
  }

  useEffect(() => { loadConfig(); }, []);

  const [soundFiles, setSoundFiles] = useState<string[]>([]);
  // ensure selects can display any value already present in rows, even if file not listed in sounds dir yet
  const rowSoundValues = useMemo(() => {
    const set = new Set<string>();
    rows.forEach(r => ['v1','v2','v3','v4','v5','v6'].forEach(k => { const v=(r as any)[k]; if (v) set.add(v); }));
    return Array.from(set).sort();
  }, [rows]);
  const soundOptions = useMemo(() => {
    const set = new Set<string>([...soundFiles, ...rowSoundValues]);
    // include a few common fallbacks just in case
    ['nc.wav','kamar.wav','bed.wav','1.wav','2.wav','3.wav','4.wav','18.wav','19.wav','20.wav','21.wav'].forEach(x => set.add(x));
    return Array.from(set).sort();
  }, [soundFiles, rowSoundValues]);

  async function refreshSoundFiles() {
    try {
      if (isTauri()) {
        const entries = await fs.readDir(SOUND_DIR);
        const wavs = entries.filter(e => !e.isDirectory && e.name?.toLowerCase().endsWith('.wav')).map(e => e.name!);
        setSoundFiles(wavs.sort());
      } else {
        // fallback: derive from rows
        const set = new Set<string>();
        rows.forEach(r => ['v1','v2','v3','v4','v5','v6'].forEach(k => { const v=(r as any)[k]; if (v) set.add(v); }));
        setSoundFiles(Array.from(set).sort());
      }
    } catch (e) {
      console.error('Failed to list sounds', e);
    }
  }

  useEffect(() => { refreshSoundFiles(); }, [rows.length]);

  function addRow() {
    const id = Date.now();
    setRows(r => [{ id, charCode: '', roomName: '', bedName: '', shape: 'NC' }, ...r]);
  }
  function deleteRows() {
    if (selected.size === 0) return;
    setRows(r => r.filter(x => !selected.has(x.id)));
    setSelected(new Set());
  }
  function save() {
    const next: Config = { ...config, masterData: rows };
    const blob = JSON.stringify(next, null, 2);
    if (isTauri()) {
      fs.writeTextFile(CONFIG_PATH, blob)
        .then(async () => { await loadConfig(); notifications.show({ title: 'Master Data', message: 'Perubahan tersimpan ke config.json', color: 'teal' }); })
        .catch(e => notifications.show({ title: 'Gagal menyimpan', message: String(e), color: 'red' }));
    } else {
      downloadFile('config.json', blob, 'application/json');
      notifications.show({ title: 'Master Data', message: 'Konfigurasi diunduh sebagai config.json. Ganti file public/config.json Anda dengan file ini.', color: 'teal' });
    }
  }

  async function importSounds(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!isTauri()) {
      notifications.show({ title: 'Import Sounds', message: 'Import otomatis hanya tersedia di Tauri. Gunakan build desktop.', color: 'yellow' });
      return;
    }
    try {
      for (const file of Array.from(files)) {
        const buf = new Uint8Array(await file.arrayBuffer());
        // plugin-fs exposes writeFile for binary/text
        await (fs as any).writeFile(`${SOUND_DIR}/${file.name}`, buf);
      }
      notifications.show({ title: 'Import Sounds', message: 'File suara berhasil diimpor', color: 'teal' });
      refreshSoundFiles();
    } catch (e) {
      notifications.show({ title: 'Gagal import', message: String(e), color: 'red' });
    }
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={3}>Master Data</Title>
        {!unlocked && <Group>
          <TextInput placeholder="Password" value={password} onChange={e => setPassword(e.currentTarget.value)} type="password" size="xs" />
          <Button size="xs" onClick={() => {
            if (password === 'devmodeNHX)(*&^') {
              devmode.enable(3 * 60 * 1000);
              notifications.show({ title: 'Dev Mode', message: 'Dev Mode aktif selama 3 menit', color: 'teal' });
            } else if (password === 'NHX)(*&^') {
              setUnlocked(true);
              notifications.show({ title: 'Unlocked', message: 'Edit Master Data diaktifkan', color: 'teal' });
            } else {
              notifications.show({ title: 'Gagal', message: 'Password salah', color: 'red' });
            }
          }}>Unlock</Button>
        </Group>}
      </Group>

      <Group gap="sm">
        <Button size="xs" color="green" onClick={addRow} disabled={!unlocked}>New</Button>
        <Button size="xs" color="red" variant="filled" onClick={deleteRows} disabled={!unlocked}>Delete</Button>
        <Button size="xs" onClick={save} disabled={!unlocked}>Save</Button>
        <Button size="xs" variant="light" onClick={() => loadConfig()}>Reload</Button>
        <Button size="xs" variant="default" component="label" disabled={!unlocked}>
          Import Sounds
          <input type="file" accept=".wav" multiple hidden onChange={e => importSounds(e.currentTarget.files)} />
        </Button>
        <Button size="xs" variant="default" onClick={() => (window.location.href = '#/display')}>Display Config</Button>
      </Group>

      <div className={classes.tableWrap}>
        <SimpleBar className={classes.tableScroll} autoHide={true}>
          <Table className={classes.table} withRowBorders={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 30 }}></Table.Th>
                <Table.Th>Code</Table.Th>
                <Table.Th>Room Name</Table.Th>
                <Table.Th>Bed Name</Table.Th>
                <Table.Th>Shape</Table.Th>
                <Table.Th>V1</Table.Th>
                <Table.Th>V2</Table.Th>
                <Table.Th>V3</Table.Th>
                <Table.Th>V4</Table.Th>
                <Table.Th>V5</Table.Th>
                <Table.Th>V6</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map(row => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <Checkbox size="xs" checked={selected.has(row.id)} onChange={e => {
                      setSelected(s => { const n = new Set(s); e.currentTarget.checked ? n.add(row.id) : n.delete(row.id); return n; });
                    }} />
                  </Table.Td>
                  <Table.Td width={90}>
                    <TextInput size="xs" value={row.charCode} onChange={e => setRows(rs => rs.map(r => r.id === row.id ? { ...r, charCode: e.currentTarget.value } : r))} disabled={!unlocked} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput size="xs" value={row.roomName} onChange={e => setRows(rs => rs.map(r => r.id === row.id ? { ...r, roomName: e.currentTarget.value } : r))} disabled={!unlocked} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput size="xs" value={row.bedName} onChange={e => setRows(rs => rs.map(r => r.id === row.id ? { ...r, bedName: e.currentTarget.value } : r))} disabled={!unlocked} />
                  </Table.Td>
                  <Table.Td width={90}>
                    <Select size="xs" data={[{value:'NC',label:'NC'},{value:'KM',label:'KM'}]} value={row.shape} onChange={v => setRows(rs => rs.map(r => r.id === row.id ? { ...r, shape: (v as any) || '' } : r))} disabled={!unlocked} />
                  </Table.Td>
                  {(['v1','v2','v3','v4','v5','v6'] as const).map((k) => (
                    <Table.Td key={k}>
                      <Select size="xs" data={[ '-', ...soundOptions ].map(x => ({ value: x, label: x }))}
                        value={(row as any)[k] || '-'} onChange={v => setRows(rs => rs.map(r => r.id === row.id ? { ...r, [k]: v === '-' ? '' : v } as Row : r))} disabled={!unlocked} />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {rows.length === 0 && <div className={classes.empty}>No data</div>}
        </SimpleBar>
      </div>
    </Stack>
  );
}
