import init, { WasmGame, engine_names } from "./pkg/yavalath_wasm.js";
import {
  gradeMove, gameStats, moveAccuracy, EXCLUDED,
  loadHistory, saveGame, clearHistory, loadPrefs, savePrefs,
} from "./grader.js";

const $ = (id) => document.getElementById(id);
const DIRECTIONS = [[1, 0], [0, 1], [-1, 1]];
const ENGINE_BUDGET_MS = 1000;
const HINT_BUDGET_MS = 600;
const GRADE_BUDGET_MS = 600;
const GRADE_K = 300; // logistic scale: eval points -> win probability
const MAX_HINTS = 6;
const NO_SCORE = -(2 ** 31); // engine reports no value (see WasmEngine.rank)
const MATE = 30_000;

// --- state ------------------------------------------------------------
let size = 5;
let game = null;        // live WasmGame (authoritative)
let viewPly = null;     // null = live view; number = replay position
let thinkEpoch = 0;     // bumped on any game mutation; stales in-flight replies

const controllers = { 1: "human", 2: "human" };
let engineDefs = []; // {name, yaml|null} — mirrors configs/engines/*.yaml
let redoStack = [];  // cell indices undone from the live game

let hintCache = { key: null, ranked: null };
let hintEpoch = 0; // invalidates in-flight hint computations
let cellXY = new Map(); // cell index -> {x, y} of the rendered board

let prefs = loadPrefs();
let historyCache = loadHistory();
const gradeCache = new Map(); // "position compact|cell" -> grade record
let gradeQueue = []; // human moves waiting to be graded
let gradeBusy = false;
let currentGameId = null;
let liveHumanMoves = 0; // human moves actually played this game (not imported/redone)

function randomSeed() {
  return BigInt((Math.random() * 2 ** 32) >>> 0);
}

// --- engine workers -----------------------------------------------------
// All searches run in workers so the UI never blocks: one worker plays,
// one analyses (hints + grading), so a grade can't delay the reply.
const pendingRpc = new Map(); // id -> {resolve, reject}
let rpcId = 0;

function makeWorker() {
  const w = new Worker("./engine-worker.js", { type: "module" });
  w.onmessage = (e) => {
    const p = pendingRpc.get(e.data.id);
    if (!p) return;
    pendingRpc.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data);
  };
  return w;
}

function call(worker, msg) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pendingRpc.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

const playWorker = makeWorker();
const analysisWorker = makeWorker();

// A search already running can't be stopped, but its result is discarded
// (epoch mismatch) and queued choose requests are skipped worker-side.
function stopThinking() {
  thinkEpoch++;
  playWorker.postMessage({ type: "cancel", before: thinkEpoch });
}

function setController(side, name) {
  stopThinking();
  controllers[side] = name;
  call(playWorker, {
    type: "setSlot",
    slot: `seat${side}`,
    name: name === "human" ? null : name,
    seed: randomSeed(),
  });
}

// --- setup ------------------------------------------------------------
await init();

// Engine options come from the shipped engine yamls (see build-web.sh);
// fall back to bare registry names if the manifest is missing.
try {
  const manifest = await (await fetch("./pkg/engines.json")).json();
  engineDefs = await Promise.all(
    manifest.map(async (e) => ({
      name: e.name,
      yaml: await (await fetch(`./pkg/${e.file}`)).text(),
    }))
  );
} catch {
  engineDefs = engine_names().map((name) => ({ name, yaml: null }));
}
await Promise.all([
  call(playWorker, { type: "init", engineDefs }),
  call(analysisWorker, { type: "init", engineDefs }),
]);

for (const sel of [$("p1-controller"), $("p2-controller")]) {
  for (const name of ["human", ...engineDefs.map((d) => d.name)]) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}
const defaultBot = engineDefs.some((d) => d.name === "ab") ? "ab" : engineDefs[0].name;
$("p2-controller").value = defaultBot;
setController(2, defaultBot);

$("reset").onclick = () => newGame();
$("undo").onclick = doUndo;
$("redo").onclick = doRedo;
$("size").onchange = (e) => { size = parseInt(e.target.value, 10); newGame(); };
$("p1-controller").onchange = (e) => { setController(1, e.target.value); poke(); };
$("p2-controller").onchange = (e) => { setController(2, e.target.value); poke(); };

$("eye").onclick = showHints;

$("settings-btn").onclick = () => { $("settings").hidden = false; };
$("settings-close").onclick = () => { $("settings").hidden = true; };

$("grade-live").checked = !!prefs.gradeLive;
$("grade-live").onchange = (e) => {
  prefs.gradeLive = e.target.checked;
  savePrefs(prefs);
  updateGradeDisplay();
};
$("hist-clear").onclick = () => {
  if (!historyCache.length || !confirm("Delete all recorded games?")) return;
  clearHistory();
  historyCache = [];
  renderHistory();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("settings").hidden = true;
});

// Long-press on the background hides everything but the board (zen mode);
// a tap on the background brings it back.
const ZEN_HOLD_MS = 500;
let zenTimer = null;
let zenStart = null;
let zenJustSet = false; // swallow the click that ends the long-press

// A clicked hex may already be detached (the move's render rebuilds the
// svg before the click bubbles here), so detached targets don't count.
const onBackground = (t) =>
  t.isConnected && !t.closest("#board, .controls, .drawer, button, select, input, a");

document.addEventListener("pointerdown", (e) => {
  zenJustSet = false;
  if (!onBackground(e.target)) return;
  zenStart = { x: e.clientX, y: e.clientY };
  zenTimer = setTimeout(() => {
    zenTimer = null;
    zenJustSet = true;
    document.body.classList.add("zen");
  }, ZEN_HOLD_MS);
});
document.addEventListener("pointermove", (e) => {
  if (zenTimer === null || zenStart === null) return;
  if (Math.hypot(e.clientX - zenStart.x, e.clientY - zenStart.y) > 12) {
    clearTimeout(zenTimer);
    zenTimer = null;
  }
});
for (const ev of ["pointerup", "pointercancel"]) {
  document.addEventListener(ev, () => {
    clearTimeout(zenTimer);
    zenTimer = null;
  });
}
document.addEventListener("click", (e) => {
  if (zenJustSet) {
    zenJustSet = false;
    return;
  }
  if (document.body.classList.contains("zen") && onBackground(e.target)) {
    document.body.classList.remove("zen");
  }
});

$("nav-start").onclick = () => setView(0);
$("nav-prev").onclick = () => setView(Math.max(0, shownPly() - 1));
$("nav-next").onclick = () => setView(Math.min(game.move_count(), shownPly() + 1));
$("nav-end").onclick = () => setView(null);

$("import-btn").onclick = importGame;
$("import-str").onkeydown = (e) => { if (e.key === "Enter") importGame(); };
for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.onclick = () => navigator.clipboard?.writeText($(btn.dataset.copy).textContent);
}

newGame();
renderHistory();

// --- game flow --------------------------------------------------------
function newGame(imported = null) {
  stopThinking();
  game = imported ?? new WasmGame(size);
  size = game.size();
  $("size").value = String(size);
  viewPly = null;
  redoStack = [];
  currentGameId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  liveHumanMoves = 0;
  // Keep pending grades only for games that made it into the history.
  gradeQueue = gradeQueue.filter((it) => historyCache.some((r) => r.id === it.gameId));
  call(playWorker, { type: "reset", seed: randomSeed() });
  $("import-error").textContent = "";
  render();
  poke();
}

function shownPly() {
  return viewPly ?? game.move_count();
}

function setView(ply) {
  stopThinking(); // entering a replay view pauses the engine's reply
  viewPly = ply !== null && ply >= game.move_count() ? null : ply;
  render();
  poke();
}

function humanInvolved() {
  return controllers[1] === "human" || controllers[2] === "human";
}

// If it's an engine's turn (and we're viewing live), let it move. Every
// caller bumps thinkEpoch first, so each epoch has at most one request in
// flight and replies that outlived a mutation are discarded.
function poke() {
  if (viewPly !== null || game.status() !== 0) return;
  const seat = game.to_move();
  if (controllers[seat] === "human") return;
  const epoch = thinkEpoch;
  // Small beat so the human's stone paints before the search starts.
  setTimeout(async () => {
    if (epoch !== thinkEpoch || game.status() !== 0) return;
    let reply;
    try {
      reply = await call(playWorker, {
        type: "choose",
        slot: `seat${seat}`,
        compact: game.to_compact(),
        budgetMs: ENGINE_BUDGET_MS,
        epoch,
      });
    } catch {
      return;
    }
    if (reply.stale || epoch !== thinkEpoch) return;
    game.play(reply.cell);
    redoStack = []; // a fresh engine move diverges from any undone line
    thinkEpoch++; // the board changed; this request is spent
    render();
    maybeSaveGame();
    poke();
  }, 250);
}

function humanClick(cell) {
  if (viewPly !== null) { setView(null); return; }
  if (game.status() !== 0 || controllers[game.to_move()] !== "human") return;
  if (!game.is_legal(cell)) return;
  stopThinking();
  game.play(cell);
  liveHumanMoves++;
  enqueueGrade(game.move_count() - 1);
  redoStack = [];
  render();
  maybeSaveGame();
  poke();
}

// Undo one ply; if a human plays an engine, keep undoing to the human's turn.
function doUndo() {
  stopThinking();
  if (viewPly !== null) { setView(null); return; }
  if (game.move_count() === 0) return;
  do {
    redoStack.push(game.moves()[game.move_count() - 1]);
    game.undo();
  } while (
    game.move_count() > 0 &&
    humanInvolved() &&
    controllers[game.to_move()] !== "human"
  );
  render();
  poke();
}

function doRedo() {
  stopThinking();
  if (viewPly !== null || redoStack.length === 0) return;
  do {
    game.play(redoStack.pop());
  } while (
    redoStack.length > 0 &&
    humanInvolved() &&
    controllers[game.to_move()] !== "human" &&
    game.status() === 0
  );
  render();
  maybeSaveGame();
  poke();
}

function importGame() {
  const text = $("import-str").value.trim();
  if (!text) return;
  try {
    newGame(WasmGame.from_string(text));
    $("import-str").value = "";
  } catch (e) {
    $("import-error").textContent = String(e.message ?? e);
  }
}

// --- rendering --------------------------------------------------------
// A snapshot of the game at the shown ply (the live game if viewPly === null).
function shownGame() {
  if (viewPly === null) return game;
  const snap = new WasmGame(size);
  const moves = game.moves();
  for (let i = 0; i < viewPly; i++) snap.play(moves[i]);
  return snap;
}

function render() {
  const g = shownGame();
  renderBoard(g); // wipes any hint labels with the rest of the svg
  updateGradeDisplay();
  hintEpoch++; // drop in-flight hint computations for the old position
  $("hint-summary").textContent = "";
  renderStatus(g);
  renderMoves();
  $("human-str").textContent = game.to_human();
  $("compact-str").textContent = game.to_compact();
  $("ply-label").textContent = `${shownPly()} / ${game.move_count()}`;
  $("undo").disabled = game.move_count() === 0;
  $("redo").disabled = redoStack.length === 0;
}

// Pointy-top hexes in a proper tessellation: cells share edges with all
// six neighbours, rows are horizontal. R = 1 (circumradius).
function renderBoard(g) {
  const svg = $("board");
  svg.innerHTML = "";
  const cells = g.cells();
  const moves = g.moves();
  const last = moves.length ? moves[moves.length - 1] : null;

  const items = [];
  const byAxial = new Map(); // "q,r" -> item
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let cell = 0; cell < g.cell_count(); cell++) {
    const q = g.cell_q(cell);
    const r = g.cell_r(cell);
    const x = Math.sqrt(3) * (q + r / 2);
    const y = 1.5 * r;
    const it = { cell, q, r, x, y, content: cells[cell] };
    items.push(it);
    byAxial.set(`${q},${r}`, it);
    minX = Math.min(minX, x - Math.sqrt(3) / 2); maxX = Math.max(maxX, x + Math.sqrt(3) / 2);
    minY = Math.min(minY, y - 1); maxY = Math.max(maxY, y + 1);
  }
  cellXY = new Map(items.map((it) => [it.cell, it]));
  const pad = 0.3;
  svg.setAttribute(
    "viewBox",
    `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`
  );

  const hexPoints = (x, y, rad) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      pts.push(`${(x + rad * Math.cos(a)).toFixed(3)},${(y + rad * Math.sin(a)).toFixed(3)}`);
    }
    return pts.join(" ");
  };

  const ns = "http://www.w3.org/2000/svg";
  // Full radius: neighbouring hexes share edges exactly, so their strokes
  // coincide and every grid line renders at the same thickness.
  for (const it of items) {
    const hex = document.createElementNS(ns, "polygon");
    hex.setAttribute("points", hexPoints(it.x, it.y, 1));
    hex.classList.add("hex");
    if (it.content !== 0) hex.classList.add(`stone-${it.content}`);
    else if (g.status() === 0) hex.classList.add("playable");
    hex.addEventListener("click", () => humanClick(it.cell));
    const title = document.createElementNS(ns, "title");
    title.textContent = g.cell_name(it.cell);
    hex.appendChild(title);
    svg.appendChild(hex);
  }

  const line = terminalLine(g, byAxial, last);

  // Theme-neutral last-move marker: a small board-coloured dot. Skipped on
  // a decisive final move — the outcome line already marks it.
  const lastIt = !line && items.find((it) => it.cell === last && it.content !== 0);
  if (lastIt) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastIt.x);
    dot.setAttribute("cy", lastIt.y);
    dot.setAttribute("r", 0.22);
    dot.classList.add("last-dot");
    svg.appendChild(dot);
  }

  if (line) {
    const el = document.createElementNS(ns, "line");
    el.setAttribute("x1", line[0].x);
    el.setAttribute("y1", line[0].y);
    el.setAttribute("x2", line[1].x);
    el.setAttribute("y2", line[1].y);
    // pathLength normalises the dash animation regardless of line length.
    el.setAttribute("pathLength", 1);
    el.classList.add("win-line");
    svg.appendChild(el);
  }
}

// Endpoints of the decisive line (the winner's 4+ or the loser's 3),
// which always passes through the last move.
function terminalLine(g, byAxial, last) {
  if (g.status() === 0 || g.status() === 3 || last === null) return null;
  const moverContent = g.move_count() % 2 === 1 ? 1 : 2;
  const origin = [...byAxial.values()].find((it) => it.cell === last);
  let best = null;
  for (const [dq, dr] of DIRECTIONS) {
    const run = [origin];
    for (const sign of [1, -1]) {
      let q = origin.q, r = origin.r;
      for (;;) {
        q += dq * sign; r += dr * sign;
        const it = byAxial.get(`${q},${r}`);
        if (!it || it.content !== moverContent) break;
        if (sign === 1) run.push(it); else run.unshift(it);
      }
    }
    if (!best || run.length > best.length) best = run;
  }
  return best && best.length >= 3 ? [best[0], best[best.length - 1]] : null;
}

// --- move grading & history --------------------------------------------
// Every live human move is graded in the background by a dedicated instance
// of the default (strongest) engine, whether or not the live display is on:
// the grades feed the history record saved when the game ends. Grading is
// cached by (position, move), so undo/redo and replays never re-search.

function enqueueGrade(ply) {
  const seat = ply % 2 === 0 ? 1 : 2;
  if (controllers[seat] !== "human") return;
  const moves = game.moves();
  gradeQueue.push({
    gameId: currentGameId,
    size,
    prefix: moves.slice(0, ply),
    cell: moves[ply],
  });
  processGradeQueue();
}

// One item at a time; the search runs in the analysis worker.
function processGradeQueue() {
  if (gradeBusy || !gradeQueue.length) return;
  gradeBusy = true;
  const item = gradeQueue.shift();
  gradeItem(item)
    .catch(() => {})
    .finally(() => {
      gradeBusy = false;
      processGradeQueue();
    });
}

async function gradeItem(item) {
  const snap = new WasmGame(item.size);
  for (const c of item.prefix) snap.play(c);
  const key = `${snap.to_compact()}|${item.cell}`;
  if (!gradeCache.has(key)) {
    const { flat } = await call(analysisWorker, {
      type: "rank",
      slot: "grade",
      name: defaultBot,
      seed: randomSeed(),
      compact: snap.to_compact(),
      budgetMs: GRADE_BUDGET_MS,
      n: snap.cell_count(),
    });
    const ranked = [];
    for (let i = 0; i < flat.length; i += 2) ranked.push({ cell: flat[i], score: flat[i + 1] });
    const grade = gradeMove(ranked, item.cell, GRADE_K);
    if (!grade) return;
    gradeCache.set(key, grade);
  }
  if (item.gameId === currentGameId) {
    updateGradeDisplay();
    if (game.status() !== 0) maybeSaveGame(); // fill in grades that finished late
  } else {
    refreshRecordGrades(item.gameId); // game already archived; update its record
  }
}

// Record the finished game (insert or update by id). Only games where the
// human actually played count; replays and imports stay unrecorded.
function maybeSaveGame() {
  if (game.status() === 0 || currentGameId === null || liveHumanMoves === 0) return;
  const humanSeats = [1, 2].filter((s) => controllers[s] === "human");
  if (!humanSeats.length) return;
  const prev = historyCache.find((r) => r.id === currentGameId);
  const rec = {
    id: currentGameId,
    ts: prev?.ts ?? new Date().toISOString(),
    size,
    compact: game.to_compact(),
    controllers: { ...controllers },
    result: game.status(),
    grader: { name: defaultBot, budgetMs: GRADE_BUDGET_MS, k: GRADE_K, ver: 1 },
    grades: collectGrades(game, humanSeats),
  };
  historyCache = saveGame(rec);
  renderHistory();
}

// Cached grades for every human move of a (finished) game, in ply order.
function collectGrades(g, humanSeats) {
  const moves = g.moves();
  const snap = new WasmGame(g.size());
  const grades = [];
  for (let ply = 0; ply < moves.length; ply++) {
    const seat = ply % 2 === 0 ? 1 : 2;
    if (humanSeats.includes(seat)) {
      const grade = gradeCache.get(`${snap.to_compact()}|${moves[ply]}`);
      if (grade) grades.push({ ply, seat, ...grade });
    }
    snap.play(moves[ply]);
  }
  return grades;
}

// A grade finished after its game was archived: refresh that record.
function refreshRecordGrades(gameId) {
  const rec = historyCache.find((r) => r.id === gameId);
  if (!rec) return;
  try {
    const g = WasmGame.from_string(rec.compact);
    const humanSeats = [1, 2].filter((s) => rec.controllers[s] === "human");
    rec.grades = collectGrades(g, humanSeats);
    historyCache = saveGame(rec);
    renderHistory();
  } catch {}
}

const GRADE_WORDS = {
  best: "best move", good: "good", inaccuracy: "inaccuracy",
  mistake: "mistake", blunder: "blunder", forced: "forced", hopeless: "already lost",
};

// The most recent graded human move among the last two plies of the shown
// position (two so the badge survives the engine's reply).
function gradeForShown(g) {
  const moves = g.moves();
  for (let back = 0; back < 2; back++) {
    const ply = moves.length - 1 - back;
    if (ply < 0) break;
    const snap = new WasmGame(g.size());
    for (let i = 0; i < ply; i++) snap.play(moves[i]);
    const grade = gradeCache.get(`${snap.to_compact()}|${moves[ply]}`);
    if (grade) return grade;
  }
  return null;
}

// Badge on the graded cell plus a one-line verdict under the board.
// Re-derived from the cache on every render, so it also works in replays.
function updateGradeDisplay() {
  const svg = $("board");
  for (const el of svg.querySelectorAll(".grade-badge")) el.remove();
  $("grade-summary").textContent = "";
  if (!prefs.gradeLive) return;
  const g = shownGame();
  const grade = gradeForShown(g);
  if (!grade) return;
  // A decisive final move: the outcome line runs through this cell, so the
  // in-cell score would clash with it — the summary line below carries it.
  const moves = g.moves();
  const underLine =
    (g.status() === 1 || g.status() === 2) && grade.cell === moves[moves.length - 1];
  const it = cellXY.get(grade.cell);
  if (it && !underLine) {
    const ns = "http://www.w3.org/2000/svg";
    // The score sits where the last-move dot would: remove the dot if it
    // marks this cell (an engine move's dot elsewhere is left alone).
    for (const dot of svg.querySelectorAll(".last-dot")) {
      if (dot.getAttribute("cx") === String(it.x) && dot.getAttribute("cy") === String(it.y)) {
        dot.remove();
      }
    }
    // Win-probability points given away by this move (0 = engine's choice).
    const pts = Math.round(grade.wpLoss * 100);
    const label = pts === 0 ? "0" : `−${pts}`;
    const t = document.createElementNS(ns, "text");
    t.classList.add("grade-badge", `grade-${grade.tag}`);
    t.setAttribute("x", it.x);
    t.setAttribute("y", it.y);
    t.setAttribute("font-size", label.length > 2 ? "0.44" : "0.55");
    t.textContent = label;
    svg.appendChild(t);
  }
  let text = `${game.cell_name(grade.cell)}: ${GRADE_WORDS[grade.tag]}`;
  if (!EXCLUDED.has(grade.tag) && grade.wpLoss >= 0.005) {
    text += ` (−${Math.round(grade.wpLoss * 100)}% win · best ${game.cell_name(grade.bestCell)})`;
  }
  $("grade-summary").textContent = text;
}

// --- hints (eye button) ------------------------------------------------
// The engine consulted for hints: the mover's bot if that seat is one,
// otherwise the other seat's bot, otherwise the default engine.
function hintEngineName(g) {
  const mover = g.to_move();
  if (controllers[mover] !== "human") return controllers[mover];
  const other = controllers[mover === 1 ? 2 : 1];
  return other !== "human" ? other : defaultBot;
}

// One-shot hint: mark up to MAX_HINTS candidate moves for the shown
// position with their scores. Cleared by the next render (board change).
async function showHints() {
  const g = shownGame();
  if (g.status() !== 0) return;
  const name = hintEngineName(g);
  const key = `${name}|${g.to_compact()}`;
  if (hintCache.key === key) {
    drawHints(g, hintCache.ranked, name);
    return;
  }
  $("hint-summary").textContent = `${name} is thinking…`;
  const epoch = ++hintEpoch;
  let flat;
  try {
    ({ flat } = await call(analysisWorker, {
      type: "rank",
      slot: "hint",
      name,
      seed: randomSeed(),
      compact: g.to_compact(),
      budgetMs: HINT_BUDGET_MS,
      n: MAX_HINTS,
    }));
  } catch (e) {
    if (epoch === hintEpoch) $("hint-summary").textContent = String(e.message ?? e);
    return;
  }
  if (epoch !== hintEpoch) return; // board changed while ranking
  const ranked = [];
  for (let i = 0; i < flat.length; i += 2) {
    ranked.push({ cell: flat[i], score: flat[i + 1] });
  }
  hintCache = { key, ranked };
  drawHints(g, ranked, name);
}

function drawHints(g, ranked, name) {
  if (!ranked.length) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = $("board");
  for (const el of svg.querySelectorAll(".hint-val")) el.remove();
  const best = ranked[0].score;
  for (const { cell, score } of ranked) {
    const it = cellXY.get(cell);
    if (!it) continue;
    // Relative strength in (0, 1]: 1 for the best move, decaying with the
    // score gap (~300 eval points per e-fold).
    const rel = score === NO_SCORE ? 1 : Math.exp((score - best) / 300);
    const text = shortScore(score);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", it.x);
    label.setAttribute("y", it.y);
    label.setAttribute("font-size", text.length > 4 ? "0.42" : "0.52");
    label.setAttribute("opacity", (0.45 + 0.55 * rel).toFixed(2));
    label.classList.add("hint-val");
    label.textContent = text;
    svg.appendChild(label);
  }
  const parts = ranked.map((r) => `${g.cell_name(r.cell)} ${fmtScore(r.score)}`.trim());
  $("hint-summary").textContent = `${name}: ${parts.join(" · ")}`;
}

// Compact score for the board cell: W3 = win in 3 (own moves), L3 likewise.
function shortScore(s) {
  if (s === NO_SCORE) return "•";
  if (s >= MATE - 64) return `W${Math.floor((MATE - s) / 2) + 1}`;
  if (s <= -(MATE - 64)) return `L${Math.floor((MATE + s) / 2) + 1}`;
  return (s > 0 ? "+" : "") + s;
}

function fmtScore(s) {
  if (s === NO_SCORE) return "";
  if (s >= MATE - 64) return `win in ${Math.floor((MATE - s) / 2) + 1}`;
  if (s <= -(MATE - 64)) return `loss in ${Math.floor((MATE + s) / 2) + 1}`;
  return (s > 0 ? "+" : "") + s;
}

function renderStatus(g) {
  const el = $("status");
  el.classList.remove("win");
  const names = { 1: "Red", 2: "Teal" };
  switch (g.status()) {
    case 0:
      el.textContent = viewPly === null && controllers[g.to_move()] !== "human"
        ? "Thinking…"
        : `${names[g.to_move()]} to move`;
      break;
    case 3:
      el.textContent = "Draw";
      el.classList.add("win");
      break;
    default:
      el.textContent = `${names[g.status()]} wins`;
      el.classList.add("win");
  }
}

function renderMoves() {
  const list = $("move-list");
  list.innerHTML = "";
  const moves = game.moves();
  const shown = shownPly();
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement("li");
    for (const j of [i, i + 1]) {
      if (j >= moves.length) break;
      const span = document.createElement("span");
      span.textContent = game.cell_name(moves[j]);
      if (j + 1 === shown) span.classList.add("current");
      span.onclick = () => setView(j + 1);
      li.appendChild(span);
      li.appendChild(document.createTextNode(" "));
    }
    list.appendChild(li);
  }
}

// --- history panel ------------------------------------------------------

// W/L/D from the human's perspective; null when both seats were human.
function humanOutcome(rec) {
  if (rec.result === 3) return "draw";
  const seats = [1, 2].filter((s) => rec.controllers[s] === "human");
  if (seats.length !== 1) return null;
  return rec.result === seats[0] ? "win" : "loss";
}

function opponentName(rec) {
  const bots = [1, 2].map((s) => rec.controllers[s]).filter((c) => c !== "human");
  return bots.length ? `vs ${bots[0]}` : "vs human";
}

function histEl(cls, text) {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  return e;
}

function renderHistory() {
  const entries = historyCache.map((r) => ({ r, s: gameStats(r) }));
  const n = entries.length;
  $("hist-empty").hidden = n > 0;
  $("hist-clear").hidden = n === 0;

  let agg = "";
  if (n) {
    const count = (o) => entries.filter((e) => humanOutcome(e.r) === o).length;
    // Overall accuracy weights every graded move equally, not every game.
    const graded = historyCache.flatMap((r) => r.grades.filter((g) => !EXCLUDED.has(g.tag)));
    agg = `${n} game${n === 1 ? "" : "s"} · ${count("win")}W ${count("loss")}L ${count("draw")}D`;
    if (graded.length) {
      const acc = graded.reduce((s, g) => s + moveAccuracy(g.wpLoss), 0) / graded.length;
      agg += ` · ${Math.round(acc)}%`;
    }
  }
  $("hist-agg").textContent = agg;
  renderTrend(entries);

  const list = $("hist-list");
  list.innerHTML = "";
  for (const { r, s } of entries.slice(-30).reverse()) {
    const li = document.createElement("li");
    const out = humanOutcome(r);
    const date = new Date(r.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    li.append(
      histEl("hist-date", date),
      histEl("hist-opp", opponentName(r)),
      histEl(`hist-res ${out ?? ""}`, out ? out[0].toUpperCase() : "–"),
      histEl("hist-acc", s.acc !== null ? `${Math.round(s.acc)}%` : "–"),
    );
    if (s.blunders) li.append(histEl("hist-bl", `${s.blunders}??`));
    li.title = `${s.graded} graded move${s.graded === 1 ? "" : "s"} — click to replay`;
    li.onclick = () => {
      try {
        newGame(WasmGame.from_string(r.compact)); // fresh id: replaying can't overwrite
      } catch {}
    };
    list.appendChild(li);
  }
}

// Accuracy per game over time: fixed 0-100 domain (no zoomed-in drama),
// recessive midlines, result-coloured dots with native tooltips. The game
// list right below is the table view of the same data.
function renderTrend(entries) {
  const svg = $("hist-trend");
  svg.innerHTML = "";
  const pts = entries.filter((e) => e.s.acc !== null).slice(-40);
  // toggleAttribute: SVG elements lack the HTML `hidden` IDL property.
  svg.toggleAttribute("hidden", pts.length < 2);
  if (pts.length < 2) return;
  const ns = "http://www.w3.org/2000/svg";
  const W = 260, H = 64, px = 8, py = 8;
  const x = (i) => px + (i * (W - 2 * px)) / (pts.length - 1);
  const y = (acc) => py + (1 - acc / 100) * (H - 2 * py);
  for (const v of [0, 50, 100]) {
    const grid = document.createElementNS(ns, "line");
    grid.setAttribute("x1", px);
    grid.setAttribute("x2", W - px);
    grid.setAttribute("y1", y(v).toFixed(1));
    grid.setAttribute("y2", y(v).toFixed(1));
    grid.classList.add("trend-grid");
    svg.appendChild(grid);
  }
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute(
    "points",
    pts.map((p, i) => `${x(i).toFixed(1)},${y(p.s.acc).toFixed(1)}`).join(" ")
  );
  line.classList.add("trend-line");
  svg.appendChild(line);
  pts.forEach((p, i) => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x(i).toFixed(1));
    dot.setAttribute("cy", y(p.s.acc).toFixed(1));
    dot.setAttribute("r", 3);
    dot.classList.add("trend-dot", humanOutcome(p.r) ?? "draw");
    const title = document.createElementNS(ns, "title");
    const date = new Date(p.r.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    title.textContent =
      `${date} · ${opponentName(p.r)} · ${humanOutcome(p.r) ?? "two humans"} · ${Math.round(p.s.acc)}%`;
    dot.appendChild(title);
    svg.appendChild(dot);
  });
}
