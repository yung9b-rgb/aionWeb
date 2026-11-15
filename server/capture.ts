import { fork, execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { isIP } from 'node:net';
import fs from 'node:fs';
import { type Lang, type Msg, pick } from './i18n.ts';
export type CaptureOptions = { device: string; serverHost: string; serverPort: number; logPackets: boolean; combatDump: boolean; logDir: string };
const helper = path.resolve(import.meta.dirname, '../tools/bin/npcap-capture.exe');
export class PassiveCapture {
  opt: CaptureOptions;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private cancelStart: (() => void) | null = null;
  private lines: {seq: number; t: number; cat: string; text: string}[] = [];
  private seq = 0;
  running = false;
  startedAt: number | null = null;
  lastError: Msg | null = null;
  stats = {clients: 0, waiting: 0, commands: 0, lost: 0, ignored: 0, captured: 0, driverDropped: 0, droppedLogs: 0};
  constructor(opt: CaptureOptions) { this.opt = opt; }
  status() { return {...this.stats, running: this.running, starting: !!this.starting, stopping: !!this.stopping, startedAt: this.startedAt, ...this.opt, logDir: undefined, error: this.lastError}; }
  async devices(): Promise<{devices: {name: string; description: string}[]; error?: string; version?: string}> {
    if (!fs.existsSync(helper)) return {devices: [], error: '缺少 tools/bin/npcap-capture.exe，请先构建抓包组件。'};
    return new Promise(resolve => execFile(helper, ['--list'], {windowsHide: true, timeout: 5000, maxBuffer: 262144}, (err, _out, stderr) => {
      try {
        const m = JSON.parse(stderr.trim());
        if (!err && m.type === 'devices') return resolve(m);
        resolve({devices: [], error: m.code === 'DLL' ? '请先安装 Npcap（https://npcap.com/），再开启旁路监听。' : `Npcap 不可用：${m.detail}；请检查驱动和抓包权限。`});
      } catch { resolve({devices: [], error: `Npcap 检测失败：${err?.message || stderr}`}); }
    }));
  }
  configure(b: Partial<CaptureOptions>) {
    if (this.child && (b.device !== undefined || b.serverHost !== undefined || b.serverPort !== undefined)) throw new Error('请先停止监听再修改网卡或目标。');
    const next = {...this.opt};
    if (b.device !== undefined) {
      if (typeof b.device !== 'string' || !/^\\Device\\NPF_[A-Za-z0-9{}_-]+$/.test(b.device)) throw new Error('请选择有效的 Npcap 网卡。');
      next.device = b.device;
    }
    if (b.serverHost !== undefined) {
      if (typeof b.serverHost !== 'string' || !isIP(b.serverHost) || ['0.0.0.0', '::'].includes(b.serverHost)) throw new Error('目标必须是主服实际使用的 IPv4/IPv6 地址。');
      next.serverHost = b.serverHost;
    }
    if (b.serverPort !== undefined) {
      if (!Number.isInteger(b.serverPort) || b.serverPort < 1 || b.serverPort > 65535) throw new Error('端口范围为 1–65535。');
      next.serverPort = b.serverPort;
    }
    if (typeof b.logPackets === 'boolean') next.logPackets = b.logPackets;
    if (typeof b.combatDump === 'boolean') next.combatDump = b.combatDump;
    this.opt = next;
    if (this.child?.connected) this.child.send({type: 'options', logPackets: this.opt.logPackets, combatDump: this.opt.combatDump});
  }
  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('正在停止监听，请稍后再试。'));
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    if (process.platform !== 'win32') return Promise.reject(new Error('Npcap 旁路监听需要 Windows。'));
    this.configure({device: this.opt.device, serverHost: this.opt.serverHost, serverPort: this.opt.serverPort});
    this.lastError = null;
    this.stats = {clients: 0, waiting: 0, commands: 0, lost: 0, ignored: 0, captured: 0, driverDropped: 0, droppedLogs: 0};
    const c = fork(path.join(import.meta.dirname, 'capture-worker.ts'), [JSON.stringify({...this.opt, helper})], {execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    this.child = c;
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        this.lastError = message;
        this.add([{t: Date.now(), cat: 'err', text: message}]);
        this.running = false; this.startedAt = null;
        if (!settled) { settled = true; reject(new Error(message)); }
      };
      this.cancelStart = () => fail('监听启动已取消');
      const timeout = setTimeout(() => { fail('监听启动超时'); c.kill(); }, 15000);
      c.stderr?.on('data', b => { if (!settled) fail(String(b).slice(0, 1024)); });
      c.on('error', e => fail(e.message));
      c.on('message', (m: any) => {
        if (this.child !== c) return;
        if (m.type === 'ready') {
          if (this.stopping || settled) return;
          clearTimeout(timeout); settled = true; this.running = true; this.startedAt = Date.now(); resolve();
        } else if (m.type === 'error') fail(m.message);
        else if (m.type === 'batch') { this.add(m.lines); this.stats = m.stats; if (c.connected) c.send({type: 'ack'}, () => {}); }
      });
      c.once('close', () => {
        clearTimeout(timeout);
        if (!settled) fail('监听进程在就绪前退出');
        if (this.child === c) {
          if (this.running && !this.stopping) fail('监听进程意外退出，请重新开启并重连游戏。');
          this.child = null; this.running = false; this.startedAt = null;
        }
      });
    }).finally(() => { this.starting = null; this.cancelStart = null; });
    return this.starting;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const c = this.child;
    if (!c) return Promise.resolve();
    if (this.starting) this.cancelStart?.();
    this.stopping = new Promise<void>(resolve => {
      const timer = setTimeout(() => c.kill(), 3000);
      c.once('close', () => { clearTimeout(timer); this.add([{t: Date.now(), cat: 'conn', text: '旁路监听已停止，游戏连接不受影响。'}]); resolve(); });
      if (c.connected) c.send({type: 'stop'}, () => {}); else c.kill();
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
  private add(lines: any[]) { for (const l of lines) this.lines.push({...l, seq: ++this.seq}); this.lines = this.lines.slice(-4000); }
  logsSince(since: number, includePackets: boolean, lang: Lang = 'zh') { return this.lines.filter(l => l.seq > since && (includePackets || l.cat !== 'pkt')).map(l => ({...l, text: pick(l.text, lang)})); }
  clearLogs() { this.lines = []; }
}
