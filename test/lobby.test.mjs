import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io } from 'socket.io-client';

const PORT = 3100;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Boot a server of our own so `npm test` needs no setup.
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${URL}/api/info`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ask = (s, ev, p = {}) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout on ${ev}`)), 4000);
    s.emit(ev, p, (r) => {
      clearTimeout(t);
      res(r);
    });
  });
const wait = (s, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no event ${ev}`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      res(d ?? true);
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the first `ev` payload that satisfies `pred` — broadcasts to other
 *  sockets are not ordered against our own acks, so a stale one may land first. */
const waitFor = (s, ev, pred, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => {
      s.off(ev, on);
      rej(new Error(`no matching ${ev}`));
    }, ms);
    const on = (d) => {
      if (!pred(d)) return;
      clearTimeout(t);
      s.off(ev, on);
      res(d);
    };
    s.on(ev, on);
  });

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

const host = io(URL);
await wait(host, 'connect');

// 1. create room
const created = await ask(host, 'host:create');
check('host creates room', created.ok && /^[A-Z0-9]{4}$/.test(created.code), JSON.stringify(created));
const code = created.code;

// 2. player joins
const p1 = io(URL);
await wait(p1, 'connect');
const rosterP = wait(host, 'room:players');
const j1 = await ask(p1, 'player:join', { code, name: 'Sofia' });
check('player joins', j1.ok && j1.state.player.name === 'Sofia', JSON.stringify(j1));
const roster = await rosterP;
check('host sees roster', roster.players.length === 1 && roster.players[0].name === 'Sofia');

// 3. bad code rejected
const p2 = io(URL);
await wait(p2, 'connect');
const bad = await ask(p2, 'player:join', { code: 'ZZZZ', name: 'Nope' });
check('bad PIN rejected', !bad.ok && /No game/.test(bad.error), JSON.stringify(bad));

// 4. duplicate name rejected
const dupe = await ask(p2, 'player:join', { code, name: 'sofia ' });
check('duplicate name rejected', !dupe.ok && /took that name/.test(dupe.error), JSON.stringify(dupe));

// 5. empty name rejected
const empty = await ask(p2, 'player:join', { code, name: '   ' });
check('empty name rejected', !empty.ok, JSON.stringify(empty));

// 6. second real player, lowercase code
const j2 = await ask(p2, 'player:join', { code: code.toLowerCase(), name: 'Manav' });
check('lowercase PIN works', j2.ok, JSON.stringify(j2));

// 7. drop + resume
const droppedP = waitFor(
  host,
  'room:players',
  (d) => d.players.find((p) => p.name === 'Sofia')?.connected === false,
);
p1.disconnect();
await droppedP;
check('drop marks offline', true);

const p1b = io(URL);
await wait(p1b, 'connect');
const res = await ask(p1b, 'player:resume', { code, playerId: j1.playerId });
check('player resumes', res.ok && res.state.player.name === 'Sofia', JSON.stringify(res));

// 8. resume with junk id
const junk = await ask(p1b, 'player:resume', { code, playerId: 'nonsense' });
check('junk resume rejected', !junk.ok);

// 9. host resume with wrong token
const fakeHost = io(URL);
await wait(fakeHost, 'connect');
const wrongTok = await ask(fakeHost, 'host:resume', { code, hostToken: 'wrong' });
check('wrong host token rejected', !wrongTok.ok, JSON.stringify(wrongTok));

// 10. non-host cannot kick
const sneak = await ask(p2, 'host:kick', { playerId: j1.playerId });
check('non-host cannot kick', !sneak.ok, JSON.stringify(sneak));

// 11. host kicks
const kicked = wait(p2, 'player:kicked');
const rosterAfterKick = wait(host, 'room:players');
const k = await ask(host, 'host:kick', { playerId: j2.playerId });
check('host kick acks', k.ok, JSON.stringify(k));
await kicked;
check('kicked player notified', true);
const rk = await rosterAfterKick;
check('roster drops kicked player', rk.players.length === 1, JSON.stringify(rk.players));

// 12. host resume with right token
host.disconnect();
await sleep(200);
const host2 = io(URL);
await wait(host2, 'connect');
const reconnNotice = wait(p1b, 'host:reconnected');
const hr = await ask(host2, 'host:resume', { code, hostToken: created.hostToken });
check('host resumes with token', hr.ok && hr.players.length === 1, JSON.stringify(hr));
await reconnNotice;
check('players told host is back', true);

// 13. close room
const closed = wait(p1b, 'room:closed');
await ask(host2, 'host:close');
await closed;
check('close notifies players', true);
const gone = await ask(p1b, 'player:resume', { code, playerId: j1.playerId });
check('room really gone', !gone.ok);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
for (const s of [host, host2, p1, p1b, p2, fakeHost]) s.close();
server.kill();
process.exit(fail ? 1 : 0);
