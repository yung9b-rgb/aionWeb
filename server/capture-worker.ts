// Runs outside the HTTP/shop process. Raw packet traffic never crosses the IPC channel.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Decoder, parseFrame, COMBAT_IDX } from './capture-protocol.ts';

const opt = JSON.parse(process.argv[2]);
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
let logPackets = !!opt.logPackets, combatDump = !!opt.combatDump;
let stopped = false, ready = false, inFlight = false;
let droppedLogs = 0, captured = 0, driverDropped = 0;
let queued: any[] = [], queuedBytes = 0;
const files = new Map<string, {day: string; stream: fs.WriteStream}>();
const stamp = () => {
  const d = new Date(), p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {day: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`};
};
function write(kind: string, text: string) {
  const {day, time} = stamp(); let f = files.get(kind);
  if (!f || f.day !== day) {
    f?.stream.end();
    fs.mkdirSync(opt.logDir, {recursive: true});
    const stream = fs.createWriteStream(path.join(opt.logDir, `${kind}_${day}.log`), {flags: 'a'});
    stream.on('error', e => fatal(`日志写入失败：${e.message}`));
    f = {day, stream}; files.set(kind, f);
  }
  if (f.stream.writableLength > 1048576) { droppedLogs++; return; }
  f.stream.write(`${time} ${text}\n`);
}
function log(cat: string, text: string) {
  // Bound both disk-write buffers and IPC. Gameplay does not wait for this consumer.
  text = text.slice(0, 4096);
  write('gm', `[${cat}] ${text}`);
  if (queued.length >= 1000 || queuedBytes + text.length > 262144) { droppedLogs++; return; }
  queued.push({t: Date.now(), cat, text}); queuedBytes += text.length;
}
const decoder = new Decoder(opt.serverHost, opt.serverPort, p => {
  if (p.direction === 'C' && p.idx === 41) log('gm', `[${p.id}] 客户端原生 GM 命令（控制台/GM 窗口） "${p.body.subarray(5).toString('utf16le').split('\0', 1)[0]}"`);
  else if (p.direction === 'S' && p.idx === 24) log('gm', `[${p.id}] 服务器消息 "${p.body.subarray(13).toString('utf16le').split('\0', 1)[0]}"`);
  else if (logPackets) log('pkt', `[${p.id}] ${p.direction === 'C' ? 'C->S' : 'S->C'} len=${p.body.length + 2} idx=${p.idx} data=${p.body.subarray(5, 37).toString('hex')}`);
  if (combatDump && p.direction === 'S' && COMBAT_IDX.has(p.idx)) write('combat', `${p.id} ${p.idx} ${p.body.subarray(5).toString('hex')}`);
}, log);

const child = spawn(opt.helper, [opt.device, String(opt.serverPort), opt.serverHost], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
let raw = Buffer.alloc(0), control = '';
child.stdout.on('data', (b: Buffer) => {
  try {
    raw = Buffer.concat([raw, b]);
    while (raw.length >= 8) {
      const n = raw.readUInt32LE(), link = raw.readUInt32LE(4);
      if (n > 262144) throw new Error('抓包桥接报文过长');
      if (raw.length < n + 8) break;
      const frame = raw.subarray(8, 8 + n); raw = raw.subarray(8 + n);
      captured++; const tcp = parseFrame(frame, link);
      if (tcp) decoder.feed(tcp);
    }
  } catch (e: any) { fatal(e.message); }
});
child.stderr.on('data', (b: Buffer) => {
  control += b.toString('utf8');
  if (control.length > 65536) { fatal('抓包桥接状态报文过长'); return; }
  let nl;
  while ((nl = control.indexOf('\n')) >= 0) {
    const line = control.slice(0, nl); control = control.slice(nl + 1);
    try {
      const m = JSON.parse(line);
      if (m.type === 'ready') {
        ready = true; process.send?.({type: 'ready'});
        log('conn', `旁路监听已开启 ${opt.device} / ${opt.serverHost}:${opt.serverPort}；请重新连接游戏。`);
      } else if (m.type === 'error') fatal(m.code === 'DLL' ? '请先安装 Npcap（https://npcap.com/），再开启旁路监听。' : `Npcap ${m.code}: ${m.detail}；检查网卡、驱动及抓包权限（仅管理员模式需以管理员运行后台）。`);
      else if (m.type === 'stats') {
        if (m.dropped > driverDropped) decoder.dropAll('Npcap 报告丢包');
        driverDropped = m.dropped;
      }
    } catch { fatal(line); }
  }
});
child.on('error', e => fatal(`无法运行抓包组件：${e.message}`));
child.on('exit', code => { if (!stopped) fatal(`抓包组件退出 (${code})`); });
const timer = setInterval(() => {
  decoder.sweep();
  if (!inFlight && process.connected) {
    inFlight = true;
    process.send?.({type: 'batch', lines: queued, stats: {clients: decoder.clients, waiting: decoder.waiting, commands: decoder.commands, lost: decoder.lost, ignored: decoder.ignored, captured, driverDropped, droppedLogs}});
    queued = []; queuedBytes = 0;
  }
}, 250);
const startup = setTimeout(() => { if (!ready) fatal('Npcap 开启超时，请检查驱动和抓包权限。'); }, 10000);
function shutdown() {
  if (stopped) return; stopped = true;
  clearInterval(timer); clearTimeout(startup);
  child.stdin.destroy(); child.kill();
  for (const f of files.values()) f.stream.end();
  if (process.connected) process.disconnect();
}
function fatal(message: string) {
  if (stopped) return;
  process.send?.({type: 'error', message}); shutdown();
}
process.on('message', (m: any) => {
  if (m.type === 'ack') inFlight = false;
  else if (m.type === 'stop') shutdown();
  else if (m.type === 'options') { logPackets = !!m.logPackets; combatDump = !!m.combatDump; }
});
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
