/* Pixel Grand Prix: browser-to-browser rooms for pages hosted outside claude.ai (needs PeerJS loaded first).
   Exposes window.PGP_P2P.join(name) with the same small surface the game uses from a claude.ai room:
   presence(patch), onPeers(fn, onError), leave().
   Shape: the first page to enter a room code becomes the hub and relays everyone's presence; the others
   connect to it. If the hub leaves, the remaining pages race to become the new hub and re-announce
   themselves. Everything received is untrusted data from another player; the game validates what it reads. */
(() => {
  'use strict';
  if (typeof window.Peer !== 'function') return;
  const PREFIX = 'pixelgp-v1-', MAX_PLAYERS = 8, TICK = 2000, DEAD = 10000, GRACE = 8000, MAX_MSG = 20000;
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const randId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');
  const merge = (old, patch) => { const o = { ...old }; for (const k in patch) { if (patch[k] === null) delete o[k]; else o[k] = patch[k]; } return o; };
  const small = m => { try { return JSON.stringify(m).length <= MAX_MSG; } catch (e) { return false; } };
  const send = (conn, msg) => { try { if (conn && conn.open) conn.send(msg); } catch (e) {} };

  function join(name) {
    return new Promise((resolve, reject) => {
      const me = randId(), hubId = PREFIX + name;
      const st = { peer: null, role: null, hub: null, hubSeen: 0, conns: new Map(), people: new Map(), handlers: new Set(),
        closed: false, settled: false, tries: 0, retryT: 0, emitT: 0, tickT: 0, joinT: 0 };
      st.people.set(me, { presence: {}, updatedAt: Date.now(), until: 0 });

      const snapshot = () => [...st.people].map(([id, p]) => Object.freeze({ peer: id, by: null, isMe: id === me, sameTab: id === me,
        kind: 'viewer', guest: false, presence: p.presence, updatedAt: p.updatedAt }));
      const emit = () => { if (st.emitT || st.closed) return; st.emitT = setTimeout(() => { st.emitT = 0; if (st.closed) return;
        const peers = Object.freeze(snapshot()); for (const h of [...st.handlers]) { try { h.fn({ peers, joined: [], left: [], updated: [] }); } catch (e) {} } }, 12); };
      const setPerson = (id, presence) => { st.people.set(id, { presence: Object.freeze(presence), updatedAt: Date.now(), until: 0 }); emit(); };
      const dropPerson = id => { if (id !== me && st.people.delete(id)) emit(); };
      const broadcast = (msg, except) => { for (const [id, c] of st.conns) if (id !== except) send(c.conn, msg); };
      const dropPeerObject = () => { const p = st.peer; st.peer = null; st.hub = null; st.role = null; st.conns.clear(); if (p) { try { p.destroy(); } catch (e) {} } };

      const fail = e => {
        const err = { code: e && e.code || 'upstream_error', message: String(e && (e.message || e.type) || e || 'error') };
        const wasSettled = st.settled; st.settled = true; const hs = [...st.handlers];
        shutdown();
        if (!wasSettled) reject(err); else for (const h of hs) { try { if (h.onErr) h.onErr(err); } catch (x) {} }
      };
      function shutdown() { st.closed = true; clearTimeout(st.retryT); clearTimeout(st.emitT); clearInterval(st.tickT); clearTimeout(st.joinT); st.handlers.clear(); dropPeerObject(); }
      const ready = () => { st.tries = 0; if (!st.settled) { st.settled = true; clearTimeout(st.joinT); resolve(api); } emit(); };
      const retry = e => { if (st.closed) return; if (st.tries >= 6) { fail(e); return; }
        clearTimeout(st.retryT); st.retryT = setTimeout(start, 250 + Math.random() * 900 + st.tries * 400); };
      /* the hub went away: keep the others on screen for a moment while a new hub is found */
      const lostHub = () => { if (st.closed || !st.hub) return; const until = Date.now() + GRACE;
        for (const [id, p] of st.people) if (id !== me) p.until = until;
        dropPeerObject(); retry('hub-lost'); };

      /* ---- hub: one connection per other page ---- */
      function onConn(conn) {
        let pid = null;
        const gone = () => { if (!pid) return; const c = st.conns.get(pid); if (!c || c.conn !== conn) return; st.conns.delete(pid); dropPerson(pid); broadcast({ t: 'left', id: pid }); };
        conn.on('data', m => {
          if (st.closed || !isObj(m) || !small(m)) return;
          if (m.t === 'h') {
            if (pid || typeof m.id !== 'string' || !/^[a-z0-9]{6,24}$/.test(m.id) || m.id === me || !isObj(m.p)) return;
            const old = st.conns.get(m.id);
            if (!old && st.conns.size >= MAX_PLAYERS - 1) { send(conn, { t: 'full_room' }); setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); return; }
            pid = m.id; st.conns.set(pid, { conn, seen: Date.now() }); if (old) { try { old.conn.close(); } catch (e) {} }
            setPerson(pid, m.p);
            const all = {}; for (const [id, p] of st.people) all[id] = p.presence;
            send(conn, { t: 'full', peers: all }); broadcast({ t: 'p', id: pid, p: m.p, full: 1 }, pid);
            return;
          }
          const c = pid && st.conns.get(pid); if (!c || c.conn !== conn) return;
          c.seen = Date.now();
          if (m.t === 'p' && isObj(m.patch)) { const cur = st.people.get(pid); if (!cur) return; setPerson(pid, merge(cur.presence, m.patch)); broadcast({ t: 'p', id: pid, patch: m.patch }, pid); }
        });
        conn.on('close', gone); conn.on('error', gone);
      }
      /* ---- client: messages from the hub ---- */
      function onHubData(m) {
        if (st.closed || !isObj(m) || !small(m)) return;
        st.hubSeen = Date.now();
        if (m.t === 'full' && isObj(m.peers)) {
          const ids = Object.keys(m.peers).slice(0, MAX_PLAYERS + 1);
          for (const id of [...st.people.keys()]) if (id !== me && !ids.includes(id)) st.people.delete(id);
          for (const id of ids) if (id !== me && isObj(m.peers[id])) setPerson(id, m.peers[id]);
          emit();
        } else if (m.t === 'p' && typeof m.id === 'string' && m.id !== me) {
          if (m.full && isObj(m.p)) setPerson(m.id, m.p);
          else if (isObj(m.patch)) { const cur = st.people.get(m.id); setPerson(m.id, merge(cur ? cur.presence : {}, m.patch)); }
        } else if (m.t === 'left' && typeof m.id === 'string') dropPerson(m.id);
        else if (m.t === 'full_room') fail({ code: 'limit_reached', message: 'room is full' });
      }
      function asClient() {
        if (st.closed) return;
        const p = new window.Peer({ debug: 0 }); st.peer = p; st.role = null;
        p.on('open', () => { if (st.peer !== p) return;
          const conn = p.connect(hubId, { serialization: 'json', reliable: true }); st.hub = conn;
          conn.on('open', () => { if (st.hub !== conn) return; st.role = 'client'; st.hubSeen = Date.now(); send(conn, { t: 'h', id: me, p: st.people.get(me).presence }); ready(); });
          conn.on('data', m => { if (st.hub === conn) onHubData(m); });
          conn.on('close', () => { if (st.hub === conn) lostHub(); });
          conn.on('error', () => { if (st.hub === conn) lostHub(); });
        });
        p.on('error', e => { if (st.peer !== p) return; dropPeerObject(); retry(e); });
      }
      function start() {
        if (st.closed) return;
        st.tries++; dropPeerObject();
        const p = new window.Peer(hubId, { debug: 0 }); st.peer = p;
        p.on('open', () => { if (st.peer !== p) return; st.role = 'hub'; p.on('connection', onConn); ready(); });
        p.on('error', e => { if (st.peer !== p) return;
          if (e && e.type === 'unavailable-id') { dropPeerObject(); asClient(); }
          else if (st.role !== 'hub') { dropPeerObject(); retry(e); } });
        p.on('disconnected', () => { if (st.peer === p && !st.closed && st.role === 'hub') { try { p.reconnect(); } catch (e) {} } });
      }
      function tick() {
        const now = Date.now(); let changed = false;
        for (const [id, p] of st.people) if (id !== me && p.until && now > p.until) { st.people.delete(id); changed = true; }
        if (changed) emit();
        if (st.role === 'hub') { for (const [id, c] of [...st.conns]) { if (now - c.seen > DEAD) { st.conns.delete(id); try { c.conn.close(); } catch (e) {} dropPerson(id); broadcast({ t: 'left', id }); } else send(c.conn, { t: 'k' }); } }
        else if (st.role === 'client') { if (now - st.hubSeen > DEAD) lostHub(); else send(st.hub, { t: 'k' }); }
      }

      const api = {
        name,
        presence(patch) {
          if (st.closed) return Promise.reject({ code: 'upstream_error', message: 'left' });
          if (!isObj(patch)) return Promise.reject({ code: 'invalid_argument', message: 'patch must be an object' });
          const cur = st.people.get(me); st.people.set(me, { presence: Object.freeze(merge(cur.presence, patch)), updatedAt: Date.now(), until: 0 });
          const msg = { t: 'p', id: me, patch };
          if (st.role === 'hub') broadcast(msg); else if (st.role === 'client') send(st.hub, msg);
          emit(); return Promise.resolve();
        },
        peers: () => Object.freeze(snapshot()),
        onPeers(fn, onErr) { const h = { fn, onErr }; st.handlers.add(h); emit(); return () => { st.handlers.delete(h); }; },
        connected: () => !!st.role,
        leave() { shutdown(); return Promise.resolve(); }
      };
      st.tickT = setInterval(tick, TICK);
      st.joinT = setTimeout(() => { if (!st.settled) fail('timeout'); }, 20000);
      start();
    });
  }
  window.PGP_P2P = { join };
  window.dispatchEvent(new Event('pgp-p2p'));
})();
