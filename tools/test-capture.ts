import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { Decoder, parseFrame, type Segment } from '../server/capture-protocol.ts';
import { PassiveCapture } from '../server/capture.ts';
import { loadConfig } from '../server/config.ts';

// Independent wire encoder based on the original Python proxy, not the decoder implementation.
const sk = Buffer.from('nKO/WctQ0AVLbpzfBkS6NevDYT8ourG5CRlmdjyJ72aswx4EPq1UgZhFMXH?3iI9');
const key = () => Buffer.from('78563412a16c5487', 'hex');
function plain(dir: 'C'|'S', idx: number, data: Buffer) {
  const op = dir === 'S' ? (idx + 190) ^ 255 : ((((idx + 190) ^ 255) + 12) ^ 191);
  const b = Buffer.alloc(5); b.writeUInt16LE(op); b[2] = dir === 'S' ? 84 : 85; b.writeUInt16LE((~op) & 65535, 3);
  return Buffer.concat([b, data]);
}
function framed(b: Buffer) { const h = Buffer.alloc(2); h.writeUInt16LE(b.length + 2); return Buffer.concat([h, b]); }
function encrypt(b: Buffer, k: Buffer) {
  const out = Buffer.alloc(b.length); let prev = 0;
  for (let i = 0; i < b.length; i++) { out[i] = b[i] ^ k[i % 8] ^ (i ? sk[i % 64] ^ prev : 0); prev = out[i]; }
  k.writeBigUInt64LE((k.readBigUInt64LE() + BigInt(b.length)) & ((1n << 64n) - 1n)); return framed(out);
}
const seed = Buffer.alloc(4); seed.writeUInt32LE(((0x12345678 ^ 0xcd92e451) + 0x3ff2cc87) >>> 0);
const hello = framed(plain('S', 72, seed));
const seg = (server: boolean, seq: number, data = Buffer.alloc(0), flags = 16): Segment => ({src: server ? '127.0.0.1' : '127.0.0.2', dst: server ? '127.0.0.2' : '127.0.0.1', sport: server ? 7777 : 42000, dport: server ? 42000 : 7777, seq, flags, data});
function setup() {
  const packets: any[] = [], logs: string[] = [];
  const d = new Decoder('127.0.0.1', 7777, p => packets.push(p), (_c, s) => logs.push(s));
  d.feed(seg(false, 100, Buffer.alloc(0), 2)); d.feed(seg(true, 1000, Buffer.alloc(0), 18));
  return {d, packets, logs};
}
function frame(t: Segment, ethernet = false) {
  const ip = Buffer.alloc(20); ip[0] = 0x45; ip.writeUInt16BE(40 + t.data.length, 2); ip[9] = 6;
  Buffer.from(t.src.split('.').map(Number)).copy(ip, 12); Buffer.from(t.dst.split('.').map(Number)).copy(ip, 16);
  const tcp = Buffer.alloc(20); tcp.writeUInt16BE(t.sport); tcp.writeUInt16BE(t.dport, 2); tcp.writeUInt32BE(t.seq, 4); tcp[12] = 0x50; tcp[13] = t.flags;
  const link = Buffer.alloc(ethernet ? 14 : 4); if (ethernet) link.writeUInt16BE(0x800, 12); else link.writeUInt32LE(2);
  return Buffer.concat([link, ip, tcp, t.data]);
}
test('loopback and Ethernet parsing reject malformed/truncated/non-TCP frames', () => {
  const s = seg(false, 101, Buffer.from('abcd'));
  assert.deepEqual(parseFrame(frame(s), 0), s); assert.deepEqual(parseFrame(frame(s, true), 1), s);
  assert.equal(parseFrame(frame(s).subarray(0, 30), 0), null);
  const udp = frame(s); udp[13] = 17; assert.equal(parseFrame(udp, 0), null);
});
test('split/coalesced packets, retransmission, out-of-order, native GM and server reply', () => {
  const {d, packets} = setup();
  d.feed(seg(true, 1001 + 5, hello.subarray(5))); d.feed(seg(true, 1001, hello.subarray(0, 5)));
  const k = key(), cmd = encrypt(plain('C', 41, Buffer.from('loc\0', 'utf16le')), k);
  const say = encrypt(plain('C', 27, Buffer.from('//loc\0', 'utf16le')), k);
  const input = Buffer.concat([cmd, say]), original = Buffer.from(input);
  d.feed(seg(false, 101, input.subarray(0, 3))); d.feed(seg(false, 104, input.subarray(3)));
  d.feed(seg(false, 101, input)); // full retransmission must not roll key twice
  const msg = encrypt(plain('S', 24, Buffer.concat([Buffer.alloc(8), Buffer.from('坐标测试\0', 'utf16le')])), key());
  d.feed(seg(true, 1012, msg));
  assert.deepEqual(packets.map(p => p.idx), [41, 27, 24]); assert.equal(d.commands, 1);
  assert.equal(packets[0].body.subarray(5).toString('utf16le'), 'loc\0'); assert.deepEqual(input, original);
  assert.equal(d.clients, 1); assert.equal(d.lost, 0);
});
test('missing handshake, sequence gaps and bad ciphertext never produce guessed GM commands', () => {
  const {d, packets} = setup(); const cmd = encrypt(plain('C', 41, Buffer.from('loc\0','utf16le')),key());
  const unknown = new Decoder('127.0.0.1',7777, p => packets.push(p), () => {});
  unknown.feed(seg(false,101,cmd)); assert.equal(unknown.ignored,1); assert.equal(packets.length,0);
  d.feed(seg(true,1001,hello)); d.feed(seg(false,106,cmd.subarray(5)),100);
  d.sweep(5200); assert.equal(d.lost,1); d.feed(seg(false,101,cmd)); assert.equal(packets.length,0);
  const b = setup(); b.d.feed(seg(true,1001,hello)); cmd[4] ^= 0xff; b.d.feed(seg(false,101,cmd));
  assert.equal(b.d.lost,1); assert.equal(b.packets.length,0);
});
test('sequence wrap, overlap retransmission and waiting for key', () => {
  const {d, packets} = setup(); const cmd=encrypt(plain('C',41,Buffer.from('info\0','utf16le')),key());
  d.feed(seg(false,101,cmd)); assert.equal(packets.length,0); d.feed(seg(true,1001,hello)); assert.equal(packets.length,1);
  const x=new Decoder('127.0.0.1',7777,p=>packets.push(p),()=>{});
  x.feed(seg(false,0xfffffffc,Buffer.alloc(0),2)); x.feed(seg(true,1000,Buffer.alloc(0),18)); x.feed(seg(true,1001,hello));
  x.feed(seg(false,0xfffffffd,cmd.subarray(0,6))); x.feed(seg(false,0xffffffff,cmd.subarray(2)));
  assert.equal(x.commands,1); assert.equal(x.lost,0);
});
test('capture drop invalidates existing sessions and a new SYN can recover', () => {
  const {d} = setup(); d.feed(seg(true,1001,hello)); d.dropAll('test drop'); assert.equal(d.clients,0);
  d.feed(seg(false,200,Buffer.alloc(0),2)); d.feed(seg(true,2000,Buffer.alloc(0),18)); d.feed(seg(true,2001,hello));
  assert.equal(d.clients,1); assert.equal(d.lost,1);
});
test('configuration always starts off; validation rejects BPF injection', async () => {
  const cfg=loadConfig(); assert.ok(!('autoStart' in cfg.capture));
  const p=new PassiveCapture({...cfg.capture,logDir:os.tmpdir()}); assert.equal(p.running,false);
  assert.throws(()=>p.configure({serverHost:'127.0.0.1 or tcp'})); assert.throws(()=>p.configure({serverPort:65536}));
  assert.throws(()=>p.configure({device:'anything'})); await p.stop();
  const original=p.opt.device; assert.throws(()=>p.configure({device:'\\Device\\NPF_other',serverPort:65536})); assert.equal(p.opt.device,original);
});
test('worker integration: separate process, raw frames, logs, combat dump, clean stop', {timeout:10000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aion-capture-test-'));
  const k=key(), inputs=[seg(false,100,Buffer.alloc(0),2),seg(true,1000,Buffer.alloc(0),18),seg(true,1001,hello),seg(false,101,encrypt(plain('C',41,Buffer.from('loc\0','utf16le')),k)),seg(true,1012,encrypt(plain('S',54,Buffer.from('01020304','hex')),key()))];
  const wire=Buffer.concat(inputs.map(t=>{const b=frame(t),head=Buffer.alloc(8);head.writeUInt32LE(b.length);return Buffer.concat([head,b]);}));
  const fixture=path.join(dir,'bridge.cjs'); fs.writeFileSync(fixture,`process.stderr.write('{"type":"ready"}\\n'); process.stdout.write(Buffer.from('${wire.toString('hex')}','hex')); process.stdin.resume(); process.stdin.on('end',()=>process.exit());`);
  const worker=fork(path.resolve(import.meta.dirname,'../server/capture-worker.ts'),[JSON.stringify({helper:process.execPath,device:fixture,serverHost:'127.0.0.1',serverPort:7777,logDir:dir,combatDump:true})],{execArgv:[],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let errors=''; worker.stderr?.on('data',b=>errors+=b);
  try {
    await new Promise<void>((resolve,reject)=>{
      worker.on('message',(m:any)=>{
        if(m.type==='error') reject(new Error(m.message));
        if(m.type==='batch') { worker.send({type:'ack'}); if(m.stats.commands===1){assert.ok(m.lines.some((l:any)=>l.text.includes('原生 GM')));resolve();} }
      });
      worker.on('exit',code=>{if(code)reject(new Error(errors||String(code)));});
    });
    await new Promise<void>(resolve=>{worker.once('exit',()=>resolve());worker.send({type:'stop'});});
    const names=fs.readdirSync(dir);
    assert.match(fs.readFileSync(path.join(dir,names.find(x=>x.startsWith('gm_'))!), 'utf8'),/原生 GM/);
    assert.match(fs.readFileSync(path.join(dir,names.find(x=>x.startsWith('combat_'))!), 'utf8'),/1 54 01020304/);
    assert.equal(errors,'');
  } finally {
    worker.kill();
    const resolved=path.resolve(dir), parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),parent); assert.ok(path.basename(resolved).startsWith('aion-capture-test-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
