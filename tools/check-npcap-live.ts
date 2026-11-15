// Short read-only capture smoke test. No authentication, gameplay packets or port listener.
import net from 'node:net';
import { PassiveCapture } from '../server/capture.ts';
import { loadConfig } from '../server/config.ts';
const capture=new PassiveCapture({...loadConfig().capture,logDir:'data/proxy_logs'});
let client:net.Socket|undefined;
try {
  await capture.start();
  client=net.connect(7777,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{
    client!.setTimeout(3000,()=>reject(new Error('Main server handshake timed out')));
    client!.once('error',reject); client!.once('data',()=>resolve());
  });
  await new Promise(resolve=>setTimeout(resolve,1500));
  console.log(JSON.stringify(capture.status()));
  console.log(JSON.stringify(capture.logsSince(0,true)));
  if(!capture.running || capture.stats.clients<1 || capture.stats.lost!==0) throw new Error('Real Npcap handshake capture failed');
  console.log('PASS: real loopback SYN + SM_KEY captured; no game packets sent');
} finally {client?.destroy();await capture.stop();}
