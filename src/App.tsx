import { ActionIcon, AppShell, Burger, Group, Space, Text, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as tauriEvent from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as tauriLogger from '@tauri-apps/plugin-log';
// no direct FS listing needed; verify via HTTP fetch to /sounds/<file>
import { relaunch } from '@tauri-apps/plugin-process';
import * as tauriUpdater from '@tauri-apps/plugin-updater';
import { JSX, lazy, LazyExoticComponent, Suspense, useEffect, useRef, useState } from 'react';
import { useDevMode } from './lib/devmode';
import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';
import { ImCross } from 'react-icons/im';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import classes from './App.module.css';
import { useCookie, notify as osNotify } from './common/utils';
import { sendTelegram, buildTriggerMessage, buildResponseMessage } from './lib/notify/telegram';
import { audioQueue } from './lib/audio/queue';
import dayjs from 'dayjs';
import LanguageHeaders from './components/LanguageHeaders';
import { ScrollToTop } from './components/ScrollToTop';
import { useTauriContext } from './tauri/TauriProvider';
import { TitleBar } from './tauri/TitleBar';
import Display from './views/Display';
import CallHistory from './views/CallHistory';
import MasterData from './views/MasterData';
import MasterSettings from './views/MasterSettings';
import FallbackAppRender from './views/FallbackErrorBoundary';
import FallbackSuspense from './views/FallbackSuspense';
// removed Example/Test/Lazy demo pages from nav/routes

// imported views need to be added to the `views` list variable
interface View {
	component: (() => JSX.Element) | LazyExoticComponent<() => JSX.Element>,
	path: string,
	exact?: boolean,
	name: string,
	iconSrc?: string,
}

export default function () {
	const { t } = useTranslation();
	// check if using custom titlebar to adjust other components
	const { usingCustomTitleBar } = useTauriContext();

	// left sidebar
    const location = useLocation();
    const showAside = location.pathname.startsWith('/call-history');

    const devModeActive = useDevMode();
    const views: View[] = [
        { component: CallHistory, path: '/call-history', name: 'Call History', iconSrc: '/icon/book-medical-solid-full.svg' },
        { component: Display, path: '/display', name: 'Display', iconSrc: '/icon/display-solid-full.svg' },
        { component: MasterData, path: '/master-data', name: 'Master Data', iconSrc: '/icon/database-solid-full.svg' },
        { component: MasterSettings, path: '/master-settings', name: 'Master Settings', iconSrc: '/icon/wrench-solid-full.svg' },
    ];
    if (devModeActive) {
        views.push({ component: () => <div style={{ padding: 16 }}><Title order={3}>Dev Mode</Title><Text size="sm">Developer tools enabled for this session.</Text></div>, path: '/dev', name: 'Dev Mode', iconSrc: '/icon/code-solid-full.svg' });
    }

	const { toggleColorScheme } = useMantineColorScheme();
	const colorScheme = useComputedColorScheme();
	useHotkeys([['ctrl+J', toggleColorScheme]]);

	// opened is for mobile nav
	const [mobileNavOpened, { toggle: toggleMobileNav }] = useDisclosure();

	const [desktopNavOpenedCookie, setDesktopNavOpenedCookie] = useCookie('desktop-nav-opened', 'true');
	const desktopNavOpened = desktopNavOpenedCookie === 'true';
	const toggleDesktopNav = () => setDesktopNavOpenedCookie(o => o === 'true' ? 'false' : 'true');

    const [scroller, setScroller] = useState<HTMLElement | null>(null);
    // sound queue for nurse-call (robust sequential player)
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioUnlockedRef = useRef(false);
    const soundBlockNotifiedRef = useRef(false);
    const queueRef = useRef<{ code: string; files: string[] }[]>([]);
    const currentCodeRef = useRef<string | null>(null);
    const closedCodesRef = useRef<Set<string>>(new Set());
    // Track active (triggered but not yet responded) codes to prevent duplicate actions/notifications
    const activeCodesRef = useRef<Set<string>>(new Set());
    // Track trigger timestamps per code for accurate response duration
    const triggerTimesRef = useRef<Map<string, number>>(new Map());
    const playingRef = useRef(false);
    // Track which codes already sent a Telegram response to avoid duplicates
    const responseSentRef = useRef<Set<string>>(new Set());

    async function ensureAudioUnlocked(): Promise<boolean> {
        if (audioUnlockedRef.current) return true;
        try {
            let a = audioRef.current;
            if (!a) { a = new Audio(); audioRef.current = a; }
            a.muted = true; // muted unlock trick
            a.src = '/sounds/ding.wav';
            a.preload = 'auto';
            await a.play();
            a.pause();
            a.muted = false;
            audioUnlockedRef.current = true;
            soundBlockNotifiedRef.current = false;
            return true;
        } catch (e: any) {
            return false;
        }
    }

    async function playFile(src: string): Promise<void> {
        return new Promise((resolve) => {
            let audio = audioRef.current;
            if (!audio) { audio = new Audio(); audioRef.current = audio; }
            const timeout = window.setTimeout(() => {
                // safety net: resolve if audio stalls too long
                resolve();
            }, 20000);
            const cleanup = () => { try { window.clearTimeout(timeout); } catch {} };
            audio.onended = () => { cleanup(); resolve(); };
            audio.onerror = () => { cleanup(); resolve(); };
            // do not resolve on pause; let timeout cover it
            audio.src = src;
            audio.currentTime = 0;
            audio.preload = 'auto';
            audio.volume = 1.0;
            void audio.play().catch(() => { cleanup(); resolve(); });
        });
    }

    async function playLoop() {
        if (playingRef.current) return;
        playingRef.current = true;
        try {
            // ensure audio is allowed before draining queue
            if (!(await ensureAudioUnlocked())) {
                if (!soundBlockNotifiedRef.current) {
                    soundBlockNotifiedRef.current = true;
                    notifications.show({ id: 'AUDIO_BLOCKED', title: 'Enable Sound', message: 'Click here or tap anywhere to enable audio playback.', autoClose: false, withCloseButton: true, onClick: async () => {
                        if (await ensureAudioUnlocked()) { notifications.hide('AUDIO_BLOCKED'); void playLoop(); }
                    }} as any);
                    const onAnyPointer = async () => {
                        if (await ensureAudioUnlocked()) {
                            try { notifications.hide('AUDIO_BLOCKED'); } catch {}
                            window.removeEventListener('pointerdown', onAnyPointer);
                            void playLoop();
                        }
                    };
                    window.addEventListener('pointerdown', onAnyPointer, { once: true });
                }
                return; // leave queue intact; will retry after unlock
            }
            // while there are stacks
            while (queueRef.current.length > 0) {
                const stack = queueRef.current.shift()!; // files for one call
                currentCodeRef.current = stack.code;
                for (const f of stack.files) {
                    await playFile(`/sounds/${encodeURIComponent(f)}`);
                }
                // finished; clear current
                currentCodeRef.current = null;
                if (queueRef.current.length > 0) {
                    await new Promise(res => setTimeout(res, 3500));
                }
            }
        } finally {
            playingRef.current = false;
        }
    }

    function enqueueSounds(code: string, files: string[]) {
        const cleaned = (files || []).map(s => s.trim()).filter(Boolean);
        if (cleaned.length === 0) return;
        audioQueue.enqueueStack(cleaned, code);
        audioQueue.kick();
    }
  const [navbarClearance, setNavbarClearance] = useState(0);
  const footerRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (footerRef.current) setNavbarClearance(footerRef.current.clientHeight);
    }, []);

    // Sound sync indicator state
  const [soundSync, setSoundSync] = useState<{ ok: boolean; total: number; missing: number }>({ ok: false, total: 0, missing: 0 });
  const soundSyncNotified = useRef(false);
  // Standby indicator from serial OK
  const [standbyStatus, setStandbyStatus] = useState<'red'|'green'|'blue'>('red');
    useEffect(() => {
        if (!isTauri()) return; // only supported in desktop env
        const check = async () => {
            try {
                const cfg = await fetch('/config.json?ts=' + Date.now());
                let needed = new Set<string>();
                if (cfg.ok) {
                    const json = await cfg.json();
                    const md: any[] = json?.masterData ?? [];
                    md.forEach(r => ['v1','v2','v3','v4','v5','v6'].forEach(k => { const v=r?.[k]; if (v && v !== '-') needed.add(String(v)); }));
                }
                // verify availability via HTTP requests to /sounds/<file>
                const names = Array.from(needed);
                let presentCount = 0;
                let missing = 0;
                await Promise.all(names.map(async (n) => {
                    try {
                        const res = await fetch(`/sounds/${encodeURIComponent(n)}`, { method: 'HEAD' });
                        if (res.ok) presentCount++; else missing++;
                    } catch { missing++; }
                }));
                try { await audioQueue.preload(names); } catch {}
                const ok = missing === 0;
                setSoundSync({ ok, total: presentCount, missing });
                return { ok, total: presentCount, missing };
            } catch (e: any) {
                console.error(e);
                return { ok: false, total: 0, missing: 0 };
            }
        };
        (async () => {
            const res = await check();
            if (!soundSyncNotified.current) {
                notifications.show({ id: 'SOUND_SYNC', title: 'Sound Sync', message: `Synced ${res.total} file(s); missing ${res.missing}.`, color: res.ok ? 'teal' : 'yellow' });
                soundSyncNotified.current = true;
            }
            // Re-check periodically until ok
            if (!res.ok) {
                const id = window.setInterval(async () => {
                    const r = await check();
                    if (r.ok) window.clearInterval(id);
                }, 5000);
                return () => window.clearInterval(id);
            }
        })().catch((e) => { console.error('Sound sync loop failed', e); });
    }, []);


	// Tauri event listeners (run on mount)
	if (isTauri()) {
		useEffect(() => {
			let unlisten: (() => void) | undefined;
			listen('longRunningThread', ({ payload }: { payload: any }) => {
				tauriLogger.info(payload.message);
			}).then(fn => { unlisten = fn; }).catch(console.error);
			return () => { try { unlisten?.(); } catch {} };
		}, []);
		// system tray events
		useEffect(() => {
			let unlisten: (() => void) | undefined;
			listen('systemTray', ({ payload, ...eventObj }: { payload: { message: string } }) => {
				tauriLogger.info(payload.message);
				// for debugging purposes only
				notifications.show({
					title: '[DEBUG] System Tray Event',
					message: payload.message
				});
			}).then(fn => { unlisten = fn; }).catch(console.error);
			return () => { try { unlisten?.(); } catch {} };
		}, []);

		// update checker
		useEffect(() => {
			(async () => {
				try {
					const update = await tauriUpdater.check();
					if (update) {
						const color = colorScheme === 'dark' ? 'teal' : 'teal.8';
						notifications.show({
							id: 'UPDATE_NOTIF',
							title: t('updateAvailable', { v: update.version }),
							color,
							message: <>
								<Text>{update.body}</Text>
								<Button color={color} style={{ width: '100%' }} onClick={() => update.downloadAndInstall(event => {
									switch (event.event) {
										case 'Started':
											notifications.show({ title: t('installingUpdate', { v: update.version }), message: t('relaunchMsg'), autoClose: false });
											// contentLength = event.data.contentLength;
											// tauriLogger.info(`started downloading ${event.data.contentLength} bytes`);
											break;
										case 'Progress':
											// downloaded += event.data.chunkLength;
											// tauriLogger.info(`downloaded ${downloaded} from ${contentLength}`);
											break;
										case 'Finished':
											// tauriLogger.info('download finished');
											break;
									}
								}).then(relaunch)}>{t('installAndRelaunch')}</Button>
							</>,
							autoClose: false
						});
					}
				} catch (e) {
					console.warn('Updater check failed', e);
				}
			})()
			}, []);

		// Handle additional app launches (url, etc.)
		useEffect(() => {
			let unlisten: (() => void) | undefined;
			listen('newInstance', async ({ payload, ...eventObj }: { payload: { args: string[], cwd: string } }) => {
					const appWindow = getCurrentWebviewWindow();
					if (!(await appWindow.isVisible())) await appWindow.show();

				if (await appWindow.isMinimized()) {
					await appWindow.unminimize();
					await appWindow.setFocus();
				}

				let args = payload?.args;
				let cwd = payload?.cwd;
				if (args?.length > 1) {

				}
				}).then(fn => { unlisten = fn; }).catch(console.error);
				return () => { try { unlisten?.(); } catch {} };
			}, []);

        // auto-connect saved port on boot
        useEffect(() => {
            (async () => {
                try {
                    const res = await fetch('/config.json?ts=' + Date.now());
                    if (!res.ok) return;
                    const json = await res.json();
                    const saved = json?.masterSettings?.com;
                    if (!saved) return;
                    const ports: string[] = await invoke('serial_list_ports');
                    if (ports?.some(p => String(p).includes(saved))) {
                        await invoke('serial_connect', { port: saved });
                    }
                } catch {}
            })();
        }, []);

        // Track serial connection state for gating triggers
        const serialConnectedRef = useRef(false);
        useEffect(() => { serialConnectedRef.current = standbyStatus !== 'red'; }, [standbyStatus]);

        // nurse-call sound playback (trigger) + response app notification (de-duped)
        useEffect(() => {
            audioQueue.init();
            let unlisten: any;
            listen<{ code: string, files: string[], display?: string, room?: string, bed?: string }>('nurse-call', (e) => {
                // Ignore triggers while disconnected
                if (!serialConnectedRef.current) return;
                const files = (e.payload?.files || []).filter(Boolean);
                const code = String(e.payload?.code || (e.payload?.display || ''));
                // ignore if code already enclosed
                if (code && closedCodesRef.current.has(code)) return;
                // de-dup: if this code is already active (no response yet), skip re-trigger
                if (code && activeCodesRef.current.has(code)) return;
                if (code) activeCodesRef.current.add(code);
                // allow future response notification for this code (fresh trigger)
                if (code) responseSentRef.current.delete(code);
                // record trigger start time
                if (code) triggerTimesRef.current.set(code, Date.now());
                enqueueSounds(code, files);
                (async () => {
                    const ok = await audioQueue.ensureUnlocked();
                    if (!ok && !soundBlockNotifiedRef.current) {
                        soundBlockNotifiedRef.current = true;
                        notifications.show({ id: 'AUDIO_BLOCKED', title: 'Enable Sound', message: 'Click here or tap anywhere to enable audio.', autoClose: false, withCloseButton: true, onClick: async () => {
                            if (await audioQueue.ensureUnlocked()) { notifications.hide('AUDIO_BLOCKED'); audioQueue.kick(); soundBlockNotifiedRef.current = false; }
                        }} as any);
                        const onAny = async () => { if (await audioQueue.ensureUnlocked()) { try { notifications.hide('AUDIO_BLOCKED'); } catch {}; window.removeEventListener('pointerdown', onAny); audioQueue.kick(); soundBlockNotifiedRef.current = false; } };
                        window.addEventListener('pointerdown', onAny, { once: true });
                    } else {
                        audioQueue.kick();
                    }
                })();
                // flash standby blue once for a valid trigger
                setStandbyStatus('blue');
                setTimeout(() => setStandbyStatus('green'), 1000);
                const disp = e.payload?.display || (e.payload?.room ? `${e.payload?.room} - ${e.payload?.bed || ''}`.trim() : e.payload?.code) || 'NURSE CALL';
                // use fixed ID so duplicate listens update the same notif instead of adding a new one
                notifications.show({ id: `NC_${code}`, title: 'Nurse Call', message: disp });
                try { osNotify('NURSE CALL', disp); } catch {}
                try {
                    const msg = buildTriggerMessage(e.payload?.room, e.payload?.bed, new Date());
                    void sendTelegram(msg);
                } catch {}
            }).then((u) => unlisten = u);
            return () => { if (unlisten) unlisten(); };
        }, []);

        // keep standby indicator in sync with backend serial events
        useEffect(() => {
            let un1: any, un2: any;
            listen('serial-connected', () => setStandbyStatus('blue')).then(u => un1 = u);
            listen('serial-disconnected', () => setStandbyStatus('red')).then(u => un2 = u);
            return () => { if (un1) un1(); if (un2) un2(); };
        }, []);

        useEffect(() => {
            let un: any;
            listen<{ code: string, display?: string }>('nurse-call-response', (e) => {
                // Mark this code as enclosed and prevent future enqueues
                const code = String(e.payload?.code || '');
                // Hard de-duplication for Telegram/notification side-effects
                if (code && responseSentRef.current.has(code)) return;
                if (code) {
                    closedCodesRef.current.add(code);
                    // allow future triggers for this code after response
                    activeCodesRef.current.delete(code);
                    try { audioQueue.dropByCode(code); } catch {}
                    // hide ongoing nurse-call notification for this code, if any
                    try { (notifications as any).hide?.(`NC_${code}`); } catch {}
                }
                const display = e.payload?.display || e.payload?.code || 'Response';
                notifications.show({ id: `NR_${code}`, title: 'Nurse Call Response', message: display, color: 'teal' });
                try { osNotify('NURSE CALL RESPONSE', display); } catch {}
                // Telegram with duration (prefer in-memory start; fallback to config)
                (async () => {
                    // mark as sent early to avoid race if multiple events arrive closely
                    if (code) responseSentRef.current.add(code);
                    let dur: number | undefined = undefined;
                    const end = new Date();
                    const startedAtMs = code ? triggerTimesRef.current.get(code) : undefined;
                    if (typeof startedAtMs === 'number') {
                        dur = Math.max(0, Math.round((end.getTime() - startedAtMs) / 1000));
                        if (code) triggerTimesRef.current.delete(code);
                    } else {
                        // fallback to persisted config if no in-memory timestamp
                        let startedAt: string | undefined;
                        try {
                            const cfg = await fetch('/config.json?ts=' + Date.now());
                            if (cfg.ok) {
                                const json = await cfg.json();
                                const arr: any[] = json?.callHistoryStorage || [];
                                const last = arr.slice().reverse().find(r => String(r.code || '') === code);
                                if (last) startedAt = String(last.timestamp || last.callTime || '');
                            }
                        } catch {}
                        if (startedAt) {
                            try { dur = Math.max(0, Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000)); } catch {}
                        }
                    }
                    let room: string | undefined = undefined;
                    let bed: string | undefined = undefined;
                    try {
                        const parts = (display || '').split(' - ');
                        room = parts[0] || undefined;
                        bed = parts.length > 1 ? parts.slice(1).join(' - ') : undefined;
                    } catch {}
                    try { void sendTelegram(buildResponseMessage(room, bed, end, dur)); } catch {}
                })();
            }).then(u => un = u);
            return () => { if (un) un(); };
        }, []);
	}

	function NavLinks() {
		// TODO: useHotkeys and abstract this
		const items = views.map((view, index) =>
            <NavLink to={view.path} key={index} end={view.exact} onClick={() => toggleMobileNav()}
                className={({ isActive }) => classes.navLink + ' ' + (isActive ? classes.navLinkActive : classes.navLinkInactive)}>
                <Group gap="xs" align="center" justify="flex-start" wrap="nowrap">
                    {view.iconSrc && <img src={view.iconSrc} alt="" className={classes.navIcon} />}
                    <Text>{view.name ? view.name : view.name}</Text>
                </Group>
            </NavLink>
		);

        async function handleReset() {
            try {
                const count = await invoke<number>('serial_enclose_all');
                if ((count as number) > 0) {
                    notifications.show({ title: 'Reset Panggilan', message: `Berhasil reset ${count} panggilan aktif`, color: 'teal' });
                } else {
                    notifications.show({ title: 'Reset Panggilan', message: 'Tidak ada panggilan aktif', color: 'yellow' });
                }
            } catch (e: any) {
                notifications.show({ title: 'Reset Panggilan', message: String(e || 'Tidak ada panggilan aktif'), color: 'yellow' });
            }
        }

		return <>
			{items}
            <a href="#" onClick={e => { e.preventDefault(); handleReset(); toggleMobileNav(); }} className={classes.navLink}>
                <Group gap="xs" align="center" justify="flex-start" wrap="nowrap">
                    <img src="/icon/rotate-right-solid-full.svg" alt="" className={classes.navIcon} />
                    <Text>Reset Panggilan</Text>
                </Group>
            </a>
		</>;
	}

    // Footer content data
    const [now, setNow] = useState(dayjs());
    useEffect(() => {
        const id = setInterval(() => setNow(dayjs()), 1000);
        return () => clearInterval(id);
    }, []);
    const dateStr = now.format('DD/MM/YYYY');
    const timeStr = now.format('HH:mm:ss');

	// hack for global styling the vertical simplebar based on state
	useEffect(() => {
        const el = document.getElementsByClassName('simplebar-vertical')[0];
        if (el instanceof HTMLElement) {
            el.style.marginTop = usingCustomTitleBar ? '130px' : '110px';
            el.style.marginBottom = '90px';
        }
    }, [usingCustomTitleBar]);

	return <>
		{usingCustomTitleBar && <TitleBar />}
        <AppShell padding='md'
            header={{ height: 104 }}
            footer={{ height: 80 }}
			navbar={{ width: 200, breakpoint: 'sm', collapsed: { mobile: !mobileNavOpened, desktop: !desktopNavOpened } }}
			aside={{ width: 300, breakpoint: 'md', collapsed: { desktop: !showAside, mobile: true } }}
			className={classes.appShell}>
			<AppShell.Main>
				{usingCustomTitleBar && <Space h='xl' />}
				<SimpleBar scrollableNodeProps={{ ref: setScroller }} autoHide={false} className={classes.simpleBar}>
					<ErrorBoundary FallbackComponent={FallbackAppRender} /*onReset={_details => resetState()} */ onError={e => { if (isTauri()) { try { tauriLogger.error(e.message); } catch {} } else { console.error(e); } }}>
						<Routes>
							{views[0] !== undefined && <Route path='/' element={<Navigate to={views[0].path} />} />}
							{views.map((view, index) => <Route key={index} path={view.path} element={<Suspense fallback={<FallbackSuspense />}><view.component /></Suspense>} />)}
						</Routes>
					</ErrorBoundary>
                    {/* prevent the footer from covering bottom text of a route view */}
                    <Space h={90} />
                    <ScrollToTop scroller={scroller} bottom={90} />
				</SimpleBar>
			</AppShell.Main>
			<AppShell.Header data-tauri-drag-region p='md' className={classes.header}>
				<Group h='100%'>
					<Burger hiddenFrom='sm' opened={mobileNavOpened} onClick={toggleMobileNav} size='sm' />
					<Burger visibleFrom='sm' opened={desktopNavOpened} onClick={toggleDesktopNav} size='sm' />
                <Title order={3} className={classes.appTitle}>Nurse Call Response System</Title>
				</Group>
				<Group className={classes.headerRightItems} h='110%'>
                <LanguageHeaders />
                <ActionIcon id='toggle-theme' title='Ctrl + J' variant='transparent' className={classes.themeButton} onClick={toggleColorScheme} size={30}>
                    {/* show sun icon in dark mode, moon icon in light mode */}
                    {colorScheme === 'dark' ? (
                        <img src="/icon/sun-solid-full.svg" alt="Sun" className={classes.themeIcon} draggable={false} />
                    ) : (
                        <img src="/icon/moon-solid-full.svg" alt="Moon" className={classes.themeIcon} draggable={false} />
                    )}
                </ActionIcon>
                <img
                    src="/banner/header-banner.jpg"
                    alt="Header Banner"
                    className={classes.headerBanner}
                    draggable={false}
                />
				</Group>
			</AppShell.Header>

			<AppShell.Navbar className={classes.titleBarAdjustedHeight} h='100%' w={{ sm: 200 }} p='xs' hidden={!mobileNavOpened}>
				<AppShell.Section grow><NavLinks /></AppShell.Section>
				<AppShell.Section>
					{/* Bottom of Navbar Example: https://github.com/mantinedev/mantine/blob/master/src/mantine-demos/src/demos/core/AppShell/_user.tsx */}
					<Space h={navbarClearance} /> {/* Account for footer */}
				</AppShell.Section>
			</AppShell.Navbar >

            {showAside && (
            <AppShell.Aside className={classes.titleBarAdjustedHeight} p='md'>
                <Text>{t('RightSideHelp')}</Text>
            </AppShell.Aside >
            )}

            <AppShell.Footer ref={footerRef} p='md' className={classes.footer}>
                <span className={classes.footerIndicators}>
                    <span className={classes.footerChip}>
                        <span className={standbyStatus === 'green' ? classes.dotGreen : standbyStatus === 'blue' ? classes.dotBlue : classes.dotRed} />
                        <Text fw={700}>Standby</Text>
                    </span>
                    <Tooltip label={`Sounds: ${soundSync.total} files, missing ${soundSync.missing}`}> 
                        <span className={classes.footerChip}>
                            <span className={soundSync.ok ? classes.dotGreen : classes.dotRed} />
                            <Text fw={700}>Sounds</Text>
                        </span>
                    </Tooltip>
                    <span className={classes.footerChip}>
                        <img src="/icon/calendar-solid-full.svg" alt="Calendar" className={classes.footerIcon} draggable={false} />
                        <Text fw={700}>{dateStr}</Text>
                    </span>
                    <span className={classes.footerChip}>
                        <img src="/icon/clock-solid-full.svg" alt="Clock" className={classes.footerIcon} draggable={false} />
                        <Text fw={700}>{timeStr}</Text>
                    </span>
                </span>
                <span className={classes.footerRight}>
                    <img
                        src="/banner/footer-banner.jpg"
                        alt="Footer Banner"
                        className={classes.footerBanner}
                        draggable={false}
                    />
                </span>
            </AppShell.Footer>
		</AppShell>

	</>;
}
