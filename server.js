// 多人臉部射擊：WebSocket 後端
// 功能：玩家註冊臉部 embedding、即時上線/下線、射擊扣血、狀態廣播、磁碟持久化

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- 持久化路徑 ----
const DATA_DIR = path.join(__dirname, "data");
const EMB_PATH = path.join(DATA_DIR, "embeddings.json");
const PLY_PATH = path.join(DATA_DIR, "players.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- 輔助：讀／寫 JSON ----
function loadJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return def; }
}
function saveJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// ---- 狀態：embeddings / players / 連線 ----
/** embeddings: { [name]: number[] } */
let embeddings = loadJSON(EMB_PATH, {});
/** players: { [name]: { hp:number, lastSeen:number } } */
let players  = loadJSON(PLY_PATH, {});

// 線上連線表
/** sockets: { [name]: WebSocket } */
const sockets = {};

// ---- 參數 ----
const PORT_HTTP = process.env.PORT || 8080;   // REST & 健康檢查
const PORT_WS   = process.env.WS_PORT || 8765;
const MAX_HP    = 100;
const DAMAGE    = 10;
const SIM_THR   = 0.72; // 臉 embedding 相似度門檻（cosine）

// ---- 相似度 ----
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- 廣播 ----
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  Object.values(sockets).forEach(ws => {
    if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
  });
}

// ---- 玩家列表（含 HP）給前端顯示 ----
function snapshot() {
  return Object.keys(embeddings).map(name => ({
    name,
    hp: players[name]?.hp ?? MAX_HP
  }));
}

// ---- HTTP 小服務（可略）----
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// 取得目前玩家與 HP
app.get("/api/players", (req, res) => {
  res.json(snapshot());
});

// 重置所有 HP
app.post("/api/reset", (req, res) => {
  for (const name of Object.keys(embeddings)) {
    players[name] = { hp: MAX_HP, lastSeen: Date.now() };
  }
  saveJSON(PLY_PATH, players);
  broadcast({ type: "players", list: snapshot() });
  res.json({ ok: true });
});

app.listen(PORT_HTTP, () => {
  console.log(`HTTP ready on http://0.0.0.0:${PORT_HTTP}`);
});

// ---- WebSocket 伺服器 ----
const wss = new WebSocketServer({ port: PORT_WS });
console.log(`WS ready on ws://0.0.0.0:${PORT_WS}`);

wss.on("connection", (ws) => {
  let me = null;

  ws.on("message", (raw) => {
    let data = null;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    // 1) 註冊：上傳 embedding
    if (data.type === "register") {
      const { name, embedding } = data;
      if (!name || !Array.isArray(embedding) || embedding.length === 0) {
        return ws.send(JSON.stringify({ type: "error", msg: "註冊資料不完整" }));
      }
      me = name;
      sockets[name] = ws;
      embeddings[name] = embedding.map(Number);               // 儲存臉向量
      if (!players[name]) players[name] = { hp: MAX_HP, lastSeen: Date.now() };
      saveJSON(EMB_PATH, embeddings);
      saveJSON(PLY_PATH, players);

      ws.send(JSON.stringify({ type: "registered", name, hp: players[name].hp }));
      broadcast({ type: "players", list: snapshot() });
      return;
    }

    // 2) 射擊：送上「當前畫面」的 embedding，伺服器比對最像的人
    if (data.type === "shoot") {
      if (!me || !players[me]) return;
      const cur = data.embedding;
      if (!Array.isArray(cur) || cur.length === 0) return;

      // 找最像（排除自己）
      let best = null, bestScore = -1;
      for (const [name, emb] of Object.entries(embeddings)) {
        if (name === me) continue;
        const s = cosine(cur, emb);
        if (s > bestScore) { bestScore = s; best = name; }
      }

      if (best && bestScore >= SIM_THR) {
        // 命中：扣血
        const p = players[best] || { hp: MAX_HP, lastSeen: Date.now() };
        p.hp = Math.max(0, p.hp - DAMAGE);
        players[best] = p;
        saveJSON(PLY_PATH, players);

        broadcast({ type: "hit", from: me, target: best, hp: p.hp, score: +bestScore.toFixed(3) });
        broadcast({ type: "players", list: snapshot() });
      } else {
        ws.send(JSON.stringify({ type: "miss", score: +bestScore.toFixed(3) }));
      }
      return;
    }

    // 3) 心跳/同步
    if (data.type === "who") {
      ws.send(JSON.stringify({ type: "players", list: snapshot() }));
      return;
    }
  });

  ws.on("close", () => {
    if (me && sockets[me]) {
      delete sockets[me];
      // 不刪 embeddings / players，保留資料
      broadcast({ type: "players", list: snapshot() });
    }
  });
});
