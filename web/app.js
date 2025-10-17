// 前端：純 JS（相機、臉部 embedding、WebSocket 對戰）
// 流程：輸入名字 -> 取一張臉 embedding -> WS register -> 按「開火」送當前 embedding -> 後端比對最像的人扣血

const WS_URL  = "wss://你的WS伺服器域名或IP:8765"; // ←★ 修改成你的 WS 公網位址（wss://）
const API_URL = "https://你的HTTP伺服器域名或IP:8080"; // ←★ 修改成你的 HTTP 公網位址（https://）

const video = document.querySelector("#video");
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const nameInput = document.querySelector("#name");
const btnJoin = document.querySelector("#btnJoin");
const btnShoot = document.querySelector("#btnShoot");
const playersEl = document.querySelector("#players");
const logEl = document.querySelector("#log");

let ws = null;
let ready = false;
let myName = "";
let joined = false;

// 載入 face-api 模型
async function loadModels() {
  const W = "https://cdn.jsdelivr.net/npm/face-api.js/weights";
  await faceapi.nets.tinyFaceDetector.loadFromUri(W);
  await faceapi.nets.faceRecognitionNet.loadFromUri(W);
  await faceapi.nets.faceLandmark68Net.loadFromUri(W);
}

// 開相機
async function startCamera() {
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  video.srcObject = s;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

// 取一張臉的 128-d 向量 (Float32Array -> Array)
async function captureEmbedding() {
  const det = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det) return null;

  // 畫框 for debug
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const b = det.detection.box;
  ctx.strokeStyle="#0ff"; ctx.lineWidth=2; ctx.strokeRect(b.x,b.y,b.width,b.height);

  return Array.from(det.descriptor);
}

// WebSocket 連線
function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    log("WS 連線成功");
    ws.send(JSON.stringify({ type: "who" }));
  };
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "registered") {
      log(`✅ 已註冊：${data.name} (${data.hp} HP)`);
      joined = true; btnShoot.disabled = false;
    } else if (data.type === "players") {
      playersEl.textContent = data.list.map(p => `${p.name}(${p.hp})`).join("、 ") || "（無）";
    } else if (data.type === "hit") {
      log(`💥 ${data.from} 擊中 ${data.target} → ${data.hp} HP  (sim=${data.score})`);
      flashHit(data.target);
    } else if (data.type === "miss") {
      log(`未命中 (sim=${data.score})`);
    } else if (data.type === "error") {
      log(`錯誤：${data.msg}`);
    }
  };
  ws.onclose = () => { log("WS 連線中斷"); btnShoot.disabled = true; joined=false; };
}

function log(t) { logEl.textContent = `[${new Date().toLocaleTimeString()}] ${t}\n` + logEl.textContent; }

function flashHit(targetName) {
  if (targetName === myName) {
    document.body.style.background = "#400";
    setTimeout(()=>document.body.style.background="#0b0e17", 250);
  }
}

// UI 綁定
btnJoin.onclick = async () => {
  myName = (nameInput.value || "").trim();
  if (!myName) { alert("請輸入名字"); return; }
  btnJoin.disabled = true;
  log("偵測中，請把臉對準鏡頭…");
  let emb = null;
  // 嘗試多次避免瞬時偵測失敗
  for (let i=0;i<10 && !emb;i++){
    emb = await captureEmbedding();
    if (!emb) await new Promise(r=>setTimeout(r,300));
  }
  if (!emb) { log("❌ 偵測不到臉，請再試"); btnJoin.disabled=false; return; }
  ws.send(JSON.stringify({ type: "register", name: myName, embedding: emb }));
};

btnShoot.onclick = async () => {
  if (!joined) { alert("請先註冊加入"); return; }
  const emb = await captureEmbedding();
  if (!emb) { log("❌ 當前畫面偵測不到臉"); return; }
  ws.send(JSON.stringify({ type: "shoot", embedding: emb }));
};

// 週期同步玩家（保險）
setInterval(async () => {
  if (!API_URL) return;
  try {
    const r = await fetch(`${API_URL}/api/players`);
    const list = await r.json();
    playersEl.textContent = list.map(p => `${p.name}(${p.hp})`).join("、 ") || "（無）";
  } catch {}
}, 4000);

// 啟動
(async () => {
  try {
    await loadModels();
    await startCamera();
    connectWS();
    ready = true;
    log("模型與相機已就緒");
  } catch (e) {
    console.error(e);
    alert("請使用 HTTPS 網頁並允許相機權限");
  }
})();
