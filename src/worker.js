// Poker Chip Counter – multiplayer backend
// One Durable Object per match (room code). Clients connect over WebSocket,
// send actions, and the room applies them and broadcasts the new state.
import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches are deleted after 7 days of inactivity
const MAX_UNDO = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (!code) return new Response("room required", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    // Everything else is served from ./public by the assets binding.
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    this.undo = [];
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || null;
      this.undo = (await ctx.storage.get("undo")) || [];
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(this.snapshotMsg());
    return new Response(null, { status: 101, webSocket: client });
  }

  snapshotMsg() {
    return JSON.stringify({ type: "state", state: this.state, canUndo: this.undo.length > 0 });
  }

  broadcast() {
    const msg = this.snapshotMsg();
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e) {}
    }
  }

  async persist() {
    await this.ctx.storage.put({ state: this.state, undo: this.undo });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === "create") {
      if (this.state) { ws.send(JSON.stringify({ type: "error", code: "exists" })); return; }
      const st = sanitizeNewGame(msg.state);
      if (!st) { ws.send(JSON.stringify({ type: "error", code: "invalid" })); return; }
      this.state = st;
      this.undo = [];
      await this.persist();
      this.broadcast();
      return;
    }

    if (msg.type === "action") {
      if (!this.state) { ws.send(JSON.stringify({ type: "error", code: "nogame" })); return; }
      const a = msg.action || {};
      if (a.t === "undo") {
        const prev = this.undo.pop();
        if (!prev) return;
        this.state = JSON.parse(prev);
      } else {
        const before = JSON.stringify(this.state);
        if (!apply(this.state, a)) { ws.send(this.snapshotMsg()); return; }
        if (a.t !== "win") {
          this.undo.push(before);
          if (this.undo.length > MAX_UNDO) this.undo.shift();
        }
      }
      await this.persist();
      this.broadcast();
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch (e) {}
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.state = null;
    this.undo = [];
  }
}

function num(v, d = 0) { v = Number(v); return Number.isFinite(v) ? v : d; }
function cleanName(n) { return String(n || "").trim().slice(0, 24); }

function sanitizeNewGame(s) {
  if (!s || !Array.isArray(s.chips) || !Array.isArray(s.players)) return null;
  const chips = s.chips.slice(0, 12).map(c => ({
    name: cleanName(c.name) || "Chip",
    color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : "#888888",
    value: Math.max(0, num(c.value)),
  })).filter(c => c.value > 0);
  const start = (s.start || []).map(v => Math.max(0, Math.floor(num(v))));
  const startValue = s.chips.slice(0, 12).reduce((t, c, i) => t + Math.max(0, num(c.value)) * (start[i] || 0), 0);
  const names = [];
  for (const p of s.players.slice(0, 12)) {
    const n = cleanName(p.name);
    if (n && !names.includes(n)) names.push(n);
  }
  if (!chips.length || startValue <= 0 || names.length < 1) return null;
  return {
    chips,
    startValue,
    players: names.map(name => ({ name, stack: startValue, buyin: startValue, bet: 0, folded: false, win: false })),
    hand: 1,
    history: [],
    created: Date.now(),
  };
}

function apply(S, a) {
  const P = S.players;
  const p = P[a.i];
  if (["bet", "call", "allin", "fold", "win", "rebuy"].includes(a.t) && !p) return false;
  switch (a.t) {
    case "bet": {
      let v = num(a.v);
      if (!(v > 0) || p.folded) return false;
      v = Math.min(v, p.stack);
      if (v <= 0) return false;
      p.stack -= v; p.bet += v;
      return true;
    }
    case "call": {
      const max = Math.max(0, ...P.map(x => x.bet));
      const v = Math.min(max - p.bet, p.stack);
      if (v <= 0 || p.folded) return false;
      p.stack -= v; p.bet += v;
      return true;
    }
    case "allin":
      if (p.stack <= 0 || p.folded) return false;
      p.bet += p.stack; p.stack = 0;
      return true;
    case "fold":
      p.folded = !p.folded;
      if (p.folded) p.win = false;
      return true;
    case "win":
      if (p.folded) return false;
      p.win = !p.win;
      return true;
    case "rebuy":
      p.stack += S.startValue; p.buyin += S.startValue;
      return true;
    case "clearBets":
      if (!P.some(x => x.bet > 0)) return false;
      P.forEach(x => { x.stack += x.bet; x.bet = 0; });
      return true;
    case "award": {
      const pot = P.reduce((t, x) => t + x.bet, 0);
      const ws = P.filter(x => x.win);
      if (pot <= 0 || !ws.length) return false;
      const unit = Math.min(...S.chips.map(c => c.value).filter(v => v > 0));
      const share = Math.floor(pot / ws.length / unit) * unit;
      const rest = pot - share * ws.length;
      const result = ws.map((x, k) => { const amt = share + (k === 0 ? rest : 0); x.stack += amt; return { name: x.name, amount: amt }; });
      S.history.push({ hand: S.hand, pot, result });
      if (S.history.length > 200) S.history.shift();
      P.forEach(x => { x.bet = 0; x.folded = false; x.win = false; });
      S.hand++;
      return true;
    }
    case "addPlayer": {
      const name = cleanName(a.name);
      if (!name || P.length >= 12 || P.some(x => x.name.toLowerCase() === name.toLowerCase())) return false;
      P.push({ name, stack: S.startValue, buyin: S.startValue, bet: 0, folded: false, win: false });
      return true;
    }
    default:
      return false;
  }
}
