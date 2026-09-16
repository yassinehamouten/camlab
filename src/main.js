import {
  FaceLandmarker, HandLandmarker, GestureRecognizer,
  FilesetResolver, DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { clamp01 } from "./lib/math.js";
import {
  CAL_POINTS, CAL_MOVE_MS, CAL_COLLECT_MS,
  gazeMetrics, gazeFeatures, fitGazeModel,
} from "./lib/gaze.js";
import { countExtendedFingers } from "./lib/hands.js";
import { createGame, resetGame, flap as flappyImpulse, stepGame } from "./lib/flappy.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODELS = {
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  gesture: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
};

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const draw = new DrawingUtils(ctx);

let vision = null;
const models = {};
let activeMode = null;
let running = false;
let lastVideoTime = -1;
let fps = 0, lastFrameAt = 0;

/* ---------- Camera setup ---------- */
$("#startBtn").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await new Promise((res) => (video.onloadedmetadata = res));
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    $("#stage").style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    $("#start-screen").classList.add("hidden");
    document.querySelectorAll(".modes button, .camtoggle button").forEach((b) => (b.disabled = false));
    vision = await FilesetResolver.forVisionTasks(WASM_URL);
    running = true;
    await setMode("face");
    requestAnimationFrame(loop);
  } catch (err) {
    showError("Cannot access the camera: " + err.message +
      " — check the browser permission and that you are on HTTPS or localhost.");
  }
});

function showError(msg) {
  const el = $("#error");
  el.textContent = "⚠️ " + msg;
  el.style.display = "flex";
}

/* ---------- Lazy model loading ---------- */
async function getModel(kind) {
  if (models[kind]) return models[kind];
  $("#loading").style.display = "flex";
  $("#loading").textContent = "Loading " + kind + " model…";
  const build = (delegate) => {
    const base = { modelAssetPath: MODELS[kind], delegate };
    if (kind === "face") {
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: base, runningMode: "VIDEO",
        numFaces: 2, outputFaceBlendshapes: true,
      });
    }
    if (kind === "hand") {
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: base, runningMode: "VIDEO", numHands: 2,
      });
    }
    return GestureRecognizer.createFromOptions(vision, {
      baseOptions: base, runningMode: "VIDEO", numHands: 2,
    });
  };
  let delegate = "GPU";
  try {
    // Known bug: GestureRecognizer on GPU (WebGL macOS) silently returns empty results → force CPU
    if (kind === "gesture") delegate = "CPU";
    models[kind] = await build(delegate);
  } catch (err) {
    console.warn("Model " + kind + ": GPU failed (" + err.message + "), falling back to CPU");
    delegate = "CPU";
    models[kind] = await build(delegate);
  }
  $("#delegateInfo").textContent = "Model " + kind + ": " + delegate;
  $("#loading").style.display = "none";
  return models[kind];
}

/* ---------- Mode switching ---------- */
document.querySelectorAll(".modes button").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode).catch(showError));
});

async function setMode(mode) {
  if (mode === activeMode) return;
  activeMode = mode;
  document.querySelectorAll(".modes button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  $("#panelFace").classList.toggle("hidden", mode !== "face");
  $("#panelHand").classList.toggle("hidden", mode !== "hand");
  $("#panelGesture").classList.toggle("hidden", mode !== "gesture");
  $("#panelGaze").classList.toggle("hidden", mode !== "gaze");
  $("#dock").style.display = mode === "gesture" ? "flex" : "none";
  $("#countLabel").textContent = (mode === "face" || mode === "gaze") ? "faces" : "hands";
  if (mode !== "gesture") clearHover();
  if (mode === "flappy") { flappyReset(true); Flappy.state = "ready"; Flappy.lastTs = 0; }
  if (mode === "gaze") gazeEnter();
  try {
    // Flappy reuses the gesture model, Gaze reuses the face model
    const modelKind = mode === "flappy" ? "gesture" : (mode === "gaze" ? "face" : mode);
    await getModel(modelKind);
  } catch (err) {
    $("#loading").style.display = "none";
    showError("Failed to load the '" + mode + "' model: " + err.message);
  }
}

/* ---------- Main loop ---------- */
function showDbg(msg) {
  const el = $("#dbgHud");
  el.textContent = msg;
  el.style.display = "block";
}
function hideDbg() {
  $("#dbgHud").style.display = "none";
}

function loop() {
  if (!running) return;
  const now = performance.now();
  try {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      if (lastFrameAt) {
        fps = fps ? fps * 0.9 + (1000 / (now - lastFrameAt)) * 0.1 : 1000 / (now - lastFrameAt);
        $("#fps").textContent = Math.round(fps);
      }
      lastFrameAt = now;
      processFrame(now);
      hideDbg();
    }
    // The game animates at 60 fps, independent of the camera frame rate
    if (activeMode === "flappy") flappyFrame(now);
  } catch (err) {
    console.error(err);
    showDbg("ERROR [" + activeMode + "] " + err.message);
  }
  requestAnimationFrame(loop);
}

/* Already-mirrored coordinates (selfie view) */
const mx = (lm) => ({ x: 1 - lm.x, y: lm.y, z: lm.z });
const mirrored = (lms) => lms.map(mx);

/* Shared camera background for AR modes (mirrored view + dark scrim for readability) */
let camMode = "full"; // full | pip | off

document.querySelectorAll(".camtoggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    camMode = btn.dataset.cam;
    document.querySelectorAll(".camtoggle button").forEach((b) =>
      b.classList.toggle("active", b.dataset.cam === camMode));
  });
});

function drawVideoBg() {
  if (video.readyState < 2) return;
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.fillStyle = "rgba(10,12,18,0.25)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function processFrame(ts) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (activeMode === "flappy") {
    flappyDetect(ts);
    return;
  }
  if (camMode === "full") drawVideoBg();
  else if (camMode === "pip") drawPip([]);
  if (activeMode === "face") processFace(ts);
  else if (activeMode === "hand") processHand(ts);
  else if (activeMode === "gesture") processGesture(ts);
  else if (activeMode === "gaze") processGaze(ts);
}

/* ---------- Face mode ---------- */
const BLENDS = [
  ["Smile", ["mouthSmileLeft", "mouthSmileRight"]],
  ["Open mouth", ["jawOpen"]],
  ["Raised eyebrows", ["browInnerUp"]],
  ["Left eye closed", ["eyeBlinkLeft"]],
  ["Right eye closed", ["eyeBlinkRight"]],
  ["Pursed lips", ["mouthPucker"]],
];
const blendsEl = $("#blends");
BLENDS.forEach(([label]) => {
  const row = document.createElement("div");
  row.className = "bar-row";
  row.innerHTML = `<label>${label} <em data-val>0%</em></label><div class="bar"><i></i></div>`;
  blendsEl.appendChild(row);
});

function processFace(ts) {
  const res = models.face.detectForVideo(video, ts);
  const faces = res.faceLandmarks || [];
  $("#count").textContent = faces.length;
  for (const lms of faces) {
    const pts = mirrored(lms);
    draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
      { color: "rgba(120,190,255,0.22)", lineWidth: 0.6 });
    draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
      { color: "#5b8cff", lineWidth: 1.6 });
    draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
      { color: "#5b8cff", lineWidth: 1.6 });
    draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_LIPS,
      { color: "#ff6b8a", lineWidth: 1.8 });
    draw.drawLandmarks(pts, { color: "#a06bff", lineWidth: 0.4, radius: 0.7 });
  }
  const bs = res.faceBlendshapes?.[0]?.categories;
  if (bs) {
    const byName = Object.fromEntries(bs.map((c) => [c.categoryName, c.score]));
    let smile = 0, jaw = 0, blinkL = 0, blinkR = 0;
    BLENDS.forEach(([, names], i) => {
      const v = Math.max(...names.map((n) => byName[n] ?? 0));
      const row = blendsEl.children[i];
      row.querySelector(".bar > i").style.width = (v * 100).toFixed(0) + "%";
      row.querySelector("[data-val]").textContent = (v * 100).toFixed(0) + "%";
      if (names.includes("mouthSmileLeft")) smile = v;
      if (names.includes("jawOpen")) jaw = v;
      if (names.includes("eyeBlinkLeft")) blinkL = v;
      if (names.includes("eyeBlinkRight")) blinkR = v;
    });
    $("#mood").textContent =
      smile > 0.55 ? "😄" : jaw > 0.5 ? "😮" :
      blinkL > 0.5 && blinkR > 0.5 ? "😴" : "🙂";
  }
}

/* ---------- Hands mode ---------- */
function processHand(ts) {
  const res = models.hand.detectForVideo(video, ts);
  const hands = res.landmarks || [];
  $("#count").textContent = hands.length;
  const handedness = res.handedness || res.handednesses || [];
  const info = $("#handsInfo");
  info.innerHTML = "";
  hands.forEach((lms, i) => {
    const pts = mirrored(lms);
    draw.drawConnectors(pts, HandLandmarker.HAND_CONNECTIONS,
      { color: "#5b8cff", lineWidth: 3 });
    draw.drawLandmarks(pts, { color: "#fff", fillColor: "#ff3b5c", lineWidth: 1, radius: 3.5 });
    // MediaPipe names hands assuming a mirrored image → flip the label
    const raw = handedness[i]?.[0]?.categoryName ?? "?";
    const label = raw === "Left" ? "Right" : "Left";
    const fingers = countExtendedFingers(lms);
    const w = canvas.width, h = canvas.height;
    ctx.font = "600 22px system-ui";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${label} · ${fingers} finger${fingers > 1 ? "s" : ""}`,
      (1 - lms[0].x) * w - 60, (lms[0].y) * h - 30);
    info.innerHTML += `<div>🖐 ${label} hand — <b>${fingers}</b> finger(s) up</div>`;
  });
  if (!hands.length) info.textContent = "No hand detected — show your palm to the camera.";
}

/* ---------- Gesture control mode ---------- */
const GESTURES = {
  None: ["—", "None"],
  Closed_Fist: ["✊", "Closed fist"],
  Open_Palm: ["🖐", "Open palm"],
  Pointing_Up: ["☝️", "Pointing up"],
  Thumb_Up: ["👍", "Thumbs up"],
  Thumb_Down: ["👎", "Thumbs down"],
  Victory: ["✌️", "Victory"],
  ILoveYou: ["🤟", "I love you"],
};
const PALETTE = [
  ["#ff3b5c", "red"],
  ["#ff8c42", "orange"],
  ["#fbbf24", "yellow"],
  ["#34d399", "green"],
  ["#60a5fa", "blue"],
  ["#a78bfa", "purple"],
  ["#f472b6", "pink"],
];
const NB_TILES = 8;
const DWELL_MS = 900;       // hold time to click
const DWELL_COOLDOWN = 700; // min delay between two consecutive clicks

const tileColors = new Array(NB_TILES).fill(-1); // -1 = neutral, otherwise PALETTE index
let allColoredAnnounced = false;
const tilesEl = $("#tiles");
for (let i = 0; i < NB_TILES; i++) {
  const t = document.createElement("button");
  t.className = "tile";
  t.dataset.idx = i;
  tilesEl.appendChild(t);
}

function applyTile(el, colorIdx) {
  el.style.background = colorIdx < 0 ? "#2c3344" : PALETTE[colorIdx][0];
  el.classList.remove("pop");
  void el.offsetWidth; // restart the CSS animation
  el.classList.add("pop");
}

function updateScore() {
  const colored = tileColors.filter((c) => c >= 0).length;
  $("#score").textContent = `${colored} / ${NB_TILES}`;
  if (colored === NB_TILES && !allColoredAnnounced) {
    allColoredAnnounced = true;
    log("🎉 Nice — every tile is colored!");
  }
  if (colored < NB_TILES) allColoredAnnounced = false;
}

function resetTiles(silent) {
  document.querySelectorAll(".tile").forEach((el, i) => {
    tileColors[i] = -1;
    applyTile(el, -1);
  });
  updateScore();
  if (!silent) log("↺ Tiles reset");
}

const cursor = { x: 0.5, y: 0.5, active: false, frozen: false };
let currentGesture = "None", stableFrames = 0, actionFired = false;
let hoverEl = null, hoverSince = 0, lastDwellClick = 0, dwellProgress = 0;

function log(msg) {
  const li = document.createElement("li");
  li.textContent = new Date().toLocaleTimeString() + " — " + msg;
  const list = $("#log");
  list.prepend(li);
  while (list.children.length > 6) list.lastChild.remove();
}

function clearHover() {
  document.querySelectorAll(".hover").forEach((el) => el.classList.remove("hover"));
}

function hoveredElement() {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + cursor.x * rect.width;
  const cy = rect.top + cursor.y * rect.height;
  return [...document.querySelectorAll(".tile, #resetBtn")].find((b) => {
    const r = b.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  });
}

function activate(el) {
  if (el.id === "resetBtn") {
    resetTiles();
    return;
  }
  const idx = +el.dataset.idx;
  tileColors[idx] = (tileColors[idx] + 1) % (PALETTE.length + 1); // cycle: 7 colors then back to neutral
  applyTile(el, tileColors[idx]);
  log(`🎨 Tile ${idx + 1} → ${tileColors[idx] < 0 ? "neutral" : PALETTE[tileColors[idx]][1]}`);
  updateScore();
}

function processGesture(ts) {
  // API quirk: GestureRecognizer uses recognizeForVideo (not detectForVideo)
  const res = models.gesture.recognizeForVideo(video, ts);
  const hands = res.landmarks || [];
  $("#count").textContent = hands.length;

  for (const lms of hands) {
    const pts = mirrored(lms);
    draw.drawConnectors(pts, HandLandmarker.HAND_CONNECTIONS,
      { color: "rgba(139,149,167,0.6)", lineWidth: 2 });
    draw.drawLandmarks(pts, { color: "#8b95a7", lineWidth: 0.5, radius: 2 });
  }

  const g = res.gestures?.[0]?.[0]?.categoryName ?? "None";
  if (g === currentGesture) stableFrames++;
  else { currentGesture = g; stableFrames = 0; actionFired = false; }

  const [emoji, name] = GESTURES[g] ?? ["❓", g];
  $("#gestureBadge .emoji").textContent = emoji;
  $("#gestureBadge .name").textContent = name;

  const now = performance.now();
  dwellProgress = 0;

  if (hands.length) {
    cursor.active = true;
    cursor.frozen = g === "Closed_Fist";
    if (!cursor.frozen) {
      const tip = hands[0][8]; // index fingertip
      cursor.x += (1 - tip.x - cursor.x) * 0.4; // smoothing
      cursor.y += (tip.y - cursor.y) * 0.4;
    }

    // Hover + dwell-click: point at a tile and hold → automatic click
    const hover = hoveredElement();
    clearHover();
    if (hover) hover.classList.add("hover");
    if (hover !== hoverEl) { hoverEl = hover; hoverSince = now; }

    if (hoverEl && !cursor.frozen) {
      dwellProgress = Math.min(1, (now - hoverSince) / DWELL_MS);
      if (dwellProgress >= 1 && now - lastDwellClick > DWELL_COOLDOWN) {
        activate(hoverEl);
        lastDwellClick = now;
        hoverSince = now; // wait again before the next click (holding = keep cycling)
      }
    } else {
      hoverEl = null;
    }

    // Held open palm → reset
    if (g === "Open_Palm" && stableFrames >= 6 && !actionFired) {
      actionFired = true;
      resetTiles();
    }
  } else {
    cursor.active = false;
    hoverEl = null;
    dwellProgress = 0;
    clearHover();
  }

  // Cursor drawing
  if (cursor.active) {
    const w = canvas.width, h = canvas.height;
    const cx = cursor.x * w, cy = cursor.y * h;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = cursor.frozen ? "rgba(139,149,167,0.85)" : "rgba(91,140,255,0.85)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 21, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (dwellProgress > 0) { // dwell progress ring
      ctx.beginPath();
      ctx.arc(cx, cy, 27, -Math.PI / 2, -Math.PI / 2 + dwellProgress * Math.PI * 2);
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.font = "600 18px system-ui";
    ctx.fillStyle = "#fff";
    ctx.fillText(emoji, cx + 30, cy - 16);
    if (hoverEl && dwellProgress === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "500 13px system-ui";
      ctx.fillText("hold…", cx + 30, cy + 4);
    }
  }
}

/* ---------- Gaze mode 👀 ---------- */
const Gaze = {
  cursor: { x: 0.5, y: 0.5 },
  trail: [], blinkFrames: 0, hover: -1, hoverSince: 0,
  locked: new Array(9).fill(-1), announced: false,
  calib: { active: false, step: 0, phase: "move", phaseStart: 0, samples: [] },
  coefX: null, coefY: null, headNeutral: null, headBuf: [], lastLock: 0,
};
const GAZE_DWELL_MS = 800;
const GAZE_GAIN = { head: 1.7 };
let gazeSource = "eyes"; // eyes → [gx, gy, 1] · head → [gx, gy, yaw, pitch, 1]

function setGazeSource(src) {
  gazeSource = src;
  $("#gazeSrcEyes").classList.toggle("active", src === "eyes");
  $("#gazeSrcHead").classList.toggle("active", src === "head");
  if (Gaze.coefX) startCalibration("Source changed — recalibration required");
}
$("#gazeSrcEyes").addEventListener("click", () => setGazeSource("eyes"));
$("#gazeSrcHead").addEventListener("click", () => setGazeSource("head"));

const gazeBarsEl = $("#gazeBars");
const GAZE_BARS = ["Yaw (head)", "Pitch (head)", "Gaze X", "Gaze Y"];
GAZE_BARS.forEach((label) => {
  const row = document.createElement("div");
  row.className = "bar-row";
  row.innerHTML = `<label>${label} <em data-val>—</em></label><div class="bar"><i></i></div>`;
  gazeBarsEl.appendChild(row);
});

function setGazeStatus(msg) {
  $("#gazeStatus").textContent = msg;
}

function gazeEnter() {
  gazeResetGrid();
  Gaze.trail = [];
  Gaze.blinkFrames = 0;
  startCalibration();
}

$("#gazeReset").addEventListener("click", () => gazeResetGrid());
$("#gazeCalib").addEventListener("click", () =>
  startCalibration("🎯 9-point calibration — follow each dot with your eyes"));

function gazeResetGrid() {
  Gaze.locked = new Array(9).fill(-1);
  Gaze.announced = false;
  $("#gazeScore").textContent = `0 / 9`;
}

function gazeAverage(buf) {
  const acc = { yaw: 0, pitch: 0, gx: 0, gy: 0 };
  for (const m of buf) {
    acc.yaw += m.yaw; acc.pitch += m.pitch; acc.gx += m.gx; acc.gy += m.gy;
  }
  const n = buf.length || 1;
  return { yaw: acc.yaw / n, pitch: acc.pitch / n, gx: acc.gx / n, gy: acc.gy / n };
}

function gazeGridGeom() {
  const w = canvas.width, h = canvas.height;
  const size = h * 0.66;
  const cell = size / 3;
  return { x0: w / 2 - size / 2, y0: h / 2 - size / 2, cell, size };
}

function startCalibration(msg) {
  Gaze.calib = { active: true, step: 0, phase: "move", phaseStart: performance.now(), samples: [] };
  Gaze.coefX = Gaze.coefY = null;
  Gaze.headNeutral = null;
  Gaze.headBuf = [];
  setGazeStatus(msg || "🎯 9-point calibration — look at each dot as it turns green");
}

function updateGazeBar(i, value, neutral) {
  const row = gazeBarsEl.children[i];
  const v = neutral == null ? value : (value - neutral);
  row.querySelector(".bar > i").style.width = (clamp01(v) * 100).toFixed(0) + "%";
  row.querySelector("[data-val]").textContent = (neutral == null ? v : v >= 0 ? "+" : "") + v.toFixed(2);
}

function processGaze(ts) {
  const res = models.face.detectForVideo(video, ts);
  const faces = res.faceLandmarks || [];
  $("#count").textContent = faces.length;

  if (!faces.length) {
    setGazeStatus("No face detected — face the camera");
    return;
  }
  const lms = faces[0];
  const m = gazeMetrics(lms);

  // Face overlays: faint tessellation + clearly visible irises
  const pts = mirrored(lms);
  draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    { color: "rgba(120,190,255,0.12)", lineWidth: 0.5 });
  draw.drawLandmarks([pts[468], pts[473]], { color: "#34d399", fillColor: "#34d399", lineWidth: 1, radius: 4 });
  draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: "#5b8cff", lineWidth: 1.4 });
  draw.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: "#5b8cff", lineWidth: 1.4 });

  if (Gaze.calib.active) {
    calibTick(m);
    return;
  }

  // Quick recalibration: close your eyes for ~1 s
  const bs = res.faceBlendshapes?.[0]?.categories;
  const byName = bs ? Object.fromEntries(bs.map((c) => [c.categoryName, c.score])) : {};
  const blinking = (byName.eyeBlinkLeft ?? 0) > 0.55 && (byName.eyeBlinkRight ?? 0) > 0.55;
  if (blinking) {
    if (++Gaze.blinkFrames > 35) {
      Gaze.blinkFrames = 0;
      startCalibration("🔁 Eyes closed detected — starting 9-point recalibration");
    }
  } else {
    Gaze.blinkFrames = 0;
  }

  if (!Gaze.coefX) {
    setGazeStatus("Press 🎯 Calibrate (9 points) to start");
    return;
  }

  // Mapping learned during calibration: raw signal → screen position
  const f = gazeFeatures(m, gazeSource);
  const tx = clamp01(f.reduce((s, v, i) => s + v * Gaze.coefX[i], 0));
  const ty = clamp01(f.reduce((s, v, i) => s + v * Gaze.coefY[i], 0));
  const alpha = 0.25; // smoothing — the iris signal is noisy
  Gaze.cursor.x += (tx - Gaze.cursor.x) * alpha;
  Gaze.cursor.y += (ty - Gaze.cursor.y) * alpha;
  Gaze.trail.push({ x: Gaze.cursor.x, y: Gaze.cursor.y });
  if (Gaze.trail.length > 14) Gaze.trail.shift();

  updateGazeBar(0, m.yaw, null);
  updateGazeBar(1, m.pitch, null);
  updateGazeBar(2, clamp01(m.gx), null);
  updateGazeBar(3, clamp01(m.gy), null);

  // 3×3 grid: hover + dwell to lock a cell
  const g = gazeGridGeom();
  const now = performance.now();
  const cx = Gaze.cursor.x * canvas.width, cy = Gaze.cursor.y * canvas.height;
  let hover = -1;
  for (let i = 0; i < 9; i++) {
    const cxx = g.x0 + (i % 3) * g.cell, cyy = g.y0 + Math.floor(i / 3) * g.cell;
    if (cx >= cxx && cx <= cxx + g.cell && cy >= cyy && cy <= cyy + g.cell) { hover = i; break; }
  }
  if (hover !== Gaze.hover) { Gaze.hover = hover; Gaze.hoverSince = now; }
  const dwell = hover >= 0 ? Math.min(1, (now - Gaze.hoverSince) / GAZE_DWELL_MS) : 0;
  if (hover >= 0 && dwell >= 1 && now - Gaze.lastLock > 500) {
    Gaze.lastLock = now;
    Gaze.locked[hover] = (Gaze.locked[hover] + 1) % (PALETTE.length + 1);
    const colored = Gaze.locked.filter((c) => c >= 0).length;
    $("#gazeScore").textContent = `${colored} / 9`;
    if (colored === 9 && !Gaze.announced) {
      Gaze.announced = true;
      log("🎉 Gaze: all 9 cells are colored!");
    }
  }

  drawGazeCells(g, hover, dwell);

  // Trail + cursor
  if (Gaze.trail.length > 1) {
    for (let i = 1; i < Gaze.trail.length; i++) {
      const a = Gaze.trail[i - 1], b = Gaze.trail[i];
      ctx.beginPath();
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
      ctx.strokeStyle = `rgba(91,140,255,${(i / Gaze.trail.length) * 0.5})`;
      ctx.lineWidth = 2 + (i / Gaze.trail.length) * 3;
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(91,140,255,0.9)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 19, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Compass — the blue dot compares against the head captured at the center dot
  let headX = 0.5, headY = 0.5;
  if (Gaze.headNeutral) {
    headX = 0.5 + GAZE_GAIN.head * ((1 - m.yaw) - (1 - Gaze.headNeutral.yaw));
    headY = 0.5 + GAZE_GAIN.head * ((m.pitch - Gaze.headNeutral.pitch) * 2);
  }
  gazeCompass(headX, headY, tx, ty);
}

function drawGazeCells(g, hover, dwell) {
  for (let i = 0; i < 9; i++) {
    const x = g.x0 + (i % 3) * g.cell, y = g.y0 + Math.floor(i / 3) * g.cell;
    const li = Gaze.locked[i];
    ctx.fillStyle = li >= 0 ? PALETTE[li][0] : "rgba(44,51,68,0.55)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x + 5, y + 5, g.cell - 10, g.cell - 10, 12);
    else ctx.rect(x + 5, y + 5, g.cell - 10, g.cell - 10);
    ctx.fill();
    if (i === hover) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.stroke();
      if (dwell > 0 && dwell < 1) {
        ctx.beginPath();
        ctx.arc(x + g.cell / 2, y + g.cell / 2, g.cell * 0.28, -Math.PI / 2, -Math.PI / 2 + dwell * Math.PI * 2);
        ctx.strokeStyle = "#34d399";
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }
  }
}

/* Calibration machine: 9 dots shown one by one at the cell centers.
   "move" phase (700 ms) to bring your gaze there, "collect" phase (1.1 s) of sampling. */
function calibTick(m) {
  const g = gazeGridGeom();
  const idx = CAL_POINTS[Gaze.calib.step];
  const cx = g.x0 + (idx % 3 + 0.5) * g.cell;
  const cy = g.y0 + (Math.floor(idx / 3) + 0.5) * g.cell;
  const now = performance.now();
  const el = now - Gaze.calib.phaseStart;

  drawGazeCells(g, -1, 0);

  const collecting = Gaze.calib.phase === "collect";
  const r = (collecting ? 15 : 9) + Math.sin(now / 160) * 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = collecting ? "#34d399" : "#ffffff";
  ctx.fill();
  if (collecting) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 9, -Math.PI / 2, -Math.PI / 2 + Math.min(1, el / CAL_COLLECT_MS) * Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
    Gaze.calib.samples.push({ f: gazeFeatures(m, gazeSource), x: cx / canvas.width, y: cy / canvas.height });
    if (idx === 4) Gaze.headBuf.push(m); // the center dot also serves as the head reference
  }
  setGazeStatus(`🎯 Calibrating ${Gaze.calib.step + 1}/9 — ${collecting ? "hold your gaze ✅" : "bring your gaze to the dot"}`);

  if (Gaze.calib.phase === "move" && el >= CAL_MOVE_MS) {
    Gaze.calib.phase = "collect";
    Gaze.calib.phaseStart = now;
  } else if (Gaze.calib.phase === "collect" && el >= CAL_COLLECT_MS) {
    Gaze.calib.step++;
    if (Gaze.calib.step >= CAL_POINTS.length) finishCalibration();
    else { Gaze.calib.phase = "move"; Gaze.calib.phaseStart = now; }
  }
}

function finishCalibration() {
  Gaze.calib.active = false;
  const { coefX, coefY, rms } = fitGazeModel(Gaze.calib.samples, gazeSource);
  Gaze.coefX = coefX;
  Gaze.coefY = coefY;
  if (Gaze.headBuf.length) Gaze.headNeutral = gazeAverage(Gaze.headBuf);
  setGazeStatus(rms > 0.18
    ? `⚠️ Calibrated but imprecise (~${Math.round(rms * 100)}% error) — recalibrate if the cursor drifts`
    : gazeSource === "eyes"
      ? "✅ Calibrated — point at the grid with your eyes only"
      : "✅ Calibrated — head + eyes mapped to the screen");
  log(`🎯 Gaze calibration done (~${Math.round(rms * 100)}% precision)`);
}

function gazeCompass(headX, headY, tx, ty) {
  const h = canvas.height;
  const r = h * 0.085;
  const cx = 24 + r, cy = 24 + r;
  ctx.save();
  ctx.fillStyle = "rgba(10,12,18,0.6)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.stroke();

  const px = cx + (clamp01(headX) - 0.5) * 1.7 * r; // blue dot: head only
  const py = cy + (clamp01(headY) - 0.5) * 1.7 * r;
  const qx = cx + (clamp01(tx) - 0.5) * 1.7 * r;    // green ring: final target (head + eyes)
  const qy = cy + (clamp01(ty) - 0.5) * 1.7 * r;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(qx, qy);
  ctx.strokeStyle = "rgba(52,211,153,0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(91,140,255,0.95)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(qx, qy, 7, 0, Math.PI * 2);
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const dx = tx - 0.5, dy = ty - 0.5;
  const vert = dy < -0.09 ? "up" : dy > 0.09 ? "down" : "";
  const hor = dx < -0.09 ? "left" : dx > 0.09 ? "right" : "";
  const dir = (vert || hor) ? vert + (vert && hor ? "-" : "") + hor : "center";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `600 ${Math.round(h * 0.022)}px system-ui`;
  ctx.textAlign = "center";
  ctx.fillText(dir, cx, cy + r + 18);
  ctx.textAlign = "left";
  ctx.restore();
}

/* ---------- Flappy mode 🐦 ---------- */
const Flappy = createGame(1280, 720);
try { Flappy.best = +(localStorage.getItem("poc-flappy-best") || 0); } catch (e) { /* storage unavailable */ }

let audioCtx = null;
function sfx(freq, dur, type) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const gn = audioCtx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    gn.gain.value = 0.07;
    o.connect(gn).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* no audio */ }
}

function flappyReset(full) {
  resetGame(Flappy, canvas.width, canvas.height, full);
}

function flappyFlap() {
  flappyImpulse(Flappy, canvas.width, canvas.height);
  sfx(560, 0.06, "triangle");
}

function flappyFrame(now) {
  const dt = Math.min(0.05, (now - (Flappy.lastTs || now)) / 1000);
  Flappy.lastTs = now;
  stepGame(Flappy, dt, canvas.width, canvas.height, {
    onScore: () => {
      sfx(880, 0.08, "sine");
      try { localStorage.setItem("poc-flappy-best", String(Flappy.best)); } catch (e) { /* */ }
    },
    onDie: () => sfx(110, 0.25, "sawtooth"),
  });
  flappyRender();
}

function flappyDetect(ts) {
  const res = models.gesture.recognizeForVideo(video, ts);
  Flappy.lastHands = res.landmarks || [];
  $("#count").textContent = Flappy.lastHands.length;
  const g = res.gestures?.[0]?.[0]?.categoryName ?? "None";
  const palm = g === "Open_Palm";
  if (palm && !Flappy.palmPrev) flappyFlap(); // rising edge: hand opening = flap
  Flappy.palmPrev = palm;
}

function flappyBanner(t1, t2) {
  const w = canvas.width, h = canvas.height;
  const bw = w * 0.62, bh = h * 0.24, bx = (w - bw) / 2, by = h * 0.36;
  ctx.fillStyle = "rgba(8,10,16,0.72)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 18); else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(h * 0.045)}px system-ui`;
  ctx.fillText(t1, w / 2, by + bh * 0.42);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `500 ${Math.round(h * 0.03)}px system-ui`;
  ctx.fillText(t2, w / 2, by + bh * 0.75);
  ctx.textAlign = "left";
}

/* Shared camera PIP — hands: optional landmarks drawn over the video */
function drawPip(hands) {
  if (video.readyState < 2) return;
  const w = canvas.width, h = canvas.height;
  const pw = w * 0.2;
  const ph = pw * ((video.videoHeight || 720) / (video.videoWidth || 1280));
  const px = w - pw - 16, py = h - ph - 16;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.translate(px + pw, py);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, pw, ph);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.stroke();
  for (const lms of hands || []) {
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2;
    for (const c of HandLandmarker.HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(px + (1 - lms[c.start].x) * pw, py + lms[c.start].y * ph);
      ctx.lineTo(px + (1 - lms[c.end].x) * pw, py + lms[c.end].y * ph);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function flappyRender() {
  const F = Flappy, w = canvas.width, h = canvas.height;
  if (camMode === "full" && video.readyState >= 2) {
    drawVideoBg(); // video as the game background
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#0f1a2e");
    grad.addColorStop(1, "#1b2a45");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  for (const c of F.clouds) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#243053";
  ctx.fillRect(0, h - 6, w, 6);

  const pw = w * 0.062;
  for (const p of F.pipes) {
    ctx.fillStyle = "#3ecf6e";
    ctx.fillRect(p.x, 0, pw, p.gapY);
    ctx.fillRect(p.x, p.gapY + p.gapH, pw, h);
    ctx.fillStyle = "#2aa857";
    ctx.fillRect(p.x - 4, p.gapY - 18, pw + 8, 18);
    ctx.fillRect(p.x - 4, p.gapY + p.gapH, pw + 8, 18);
  }

  const b = F.bird;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.max(-0.5, Math.min(1.1, b.vy / (h * 0.9))));
  ctx.fillStyle = "#ffd23f";
  ctx.beginPath();
  ctx.arc(0, 0, b.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff8c42";
  ctx.beginPath();
  ctx.moveTo(b.r * 0.7, -b.r * 0.2);
  ctx.lineTo(b.r * 1.5, 0);
  ctx.lineTo(b.r * 0.7, b.r * 0.35);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(b.r * 0.25, -b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(b.r * 0.35, -b.r * 0.35, b.r * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `700 ${Math.round(h * 0.09)}px system-ui`;
  ctx.fillText(String(F.score), w / 2, h * 0.16);
  ctx.font = `500 ${Math.round(h * 0.03)}px system-ui`;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(`Best: ${F.best}`, w / 2, h * 0.16 + h * 0.045);
  ctx.textAlign = "left";

  if (F.state === "ready") {
    flappyBanner("🐦 Hands-free Flappy", "Show 🖐 to start — every 🖐 flaps the wings");
  } else if (F.state === "dead") {
    flappyBanner("💥 Game over!", `Score ${F.score} · best ${F.best} — 🖐 to play again`);
  }
  if (camMode === "pip") drawPip(Flappy.lastHands);
}

/* Automated test: open with #auto to start the camera without a click */
if (location.hash === "#auto") $("#startBtn").click();
