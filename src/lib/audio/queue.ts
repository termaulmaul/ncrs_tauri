type Stack = { code?: string; files: string[] };

class AudioQueue {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private cache = new Map<string, AudioBuffer>();
  private playing = false;
  private stacks: Stack[] = [];

  init() {
    if (this.ctx) return;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
  }

  async ensureUnlocked() {
    if (!this.ctx) this.init();
    const c = this.ctx;
    if (!c) return false;
    if (c.state === 'running') return true;
    try {
      await c.resume();
      return c.state === 'running';
    } catch {
      return false;
    }
  }

  setVolume(v: number) {
    if (!this.gain) return;
    this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  async preload(names: string[]) {
    const unique = Array.from(new Set(names.filter(Boolean)));
    for (const name of unique) {
      const url = `/sounds/${encodeURIComponent(name)}`;
      if (this.cache.has(url)) continue;
      try {
        const buf = await this.fetchDecode(url);
        if (buf) this.cache.set(url, buf);
      } catch {
        // ignore
      }
    }
  }

  enqueueStack(files: string[], code?: string) {
    const cleaned = (files || []).map(s => s.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    this.stacks.push({ code, files: cleaned });
    if (!this.playing) void this.drain();
  }

  dropByCode(code: string) {
    this.stacks = this.stacks.filter(s => s.code !== code);
  }

  kick() {
    if (!this.playing && this.stacks.length > 0) void this.drain();
  }

  private async drain() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.stacks.length > 0) {
        const stack = this.stacks.shift()!;
        for (const n of stack.files) {
          const url = `/sounds/${encodeURIComponent(n)}`;
          await this.playOne(url);
        }
        if (this.stacks.length > 0) await this.sleep(3500);
      }
    } finally {
      this.playing = false;
    }
  }

  private async playOne(url: string) {
    const c = this.ctx;
    const g = this.gain;
    if (!c || !g) { await this.sleep(200); return; }
    let buf = this.cache.get(url) || null;
    if (!buf) {
      try { buf = await this.fetchDecode(url); } catch { buf = null; }
      if (buf) this.cache.set(url, buf);
    }
    if (!buf) { await this.sleep(50); return; }
    return new Promise<void>((resolve) => {
      const src = c.createBufferSource();
      src.buffer = buf!;
      src.connect(g);
      const done = () => { try { src.disconnect(); } catch {} resolve(); };
      const to = window.setTimeout(done, Math.max(5000, (buf!.duration * 1000) + 500));
      src.onended = () => { try { window.clearTimeout(to); } catch {} done(); };
      try { src.start(0); } catch { done(); }
    });
  }

  private async fetchDecode(url: string): Promise<AudioBuffer | null> {
    const c = this.ctx;
    if (!c) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return await c.decodeAudioData(arr).catch(() => null as any);
  }

  private sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
}

export const audioQueue = new AudioQueue();

