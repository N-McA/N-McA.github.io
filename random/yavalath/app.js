import init, { WasmGame, WasmEngine, engine_names } from "./pkg/yavalath_wasm.js";

const $ = (id) => document.getElementById(id);
const DIRECTIONS = [[1, 0], [0, 1], [-1, 1]];
const ENGINE_BUDGET_MS = 1000;

// --- state ------------------------------------------------------------
let size = 5;
let game = null;        // live WasmGame (authoritative)
let viewPly = null;     // null = live view; number = replay position
let redoStack = [];     // cell indices undone from the live game
let engineTimer = null;

const controllers = { 1: "human", 2: "human" };
const engines = { 1: null, 2: null }; // persistent WasmEngine per seat
let engineDefs = []; // {name, yaml|null} — mirrors configs/engines/*.yaml

function randomSeed() {
  return BigInt((Math.random() * 2 ** 32) >>> 0);
}

function makeEngine(name) {
  const def = engineDefs.find((d) => d.name === name);
  return def?.yaml
    ? WasmEngine.from_yaml(def.yaml, randomSeed())
    : new WasmEngine(name, randomSeed());
}

function setController(side, name) {
  controllers[side] = name;
  engines[side] = name === "human" ? null : makeEngine(name);
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

$("settings-btn").onclick = () => { $("settings").hidden = false; };
$("settings-close").onclick = () => { $("settings").hidden = true; };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("settings").hidden = true;
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

// --- game flow --------------------------------------------------------
function newGame(imported = null) {
  clearTimeout(engineTimer);
  game = imported ?? new WasmGame(size);
  size = game.size();
  $("size").value = String(size);
  viewPly = null;
  redoStack = [];
  for (const side of [1, 2]) engines[side]?.reset(randomSeed());
  $("import-error").textContent = "";
  render();
  poke();
}

function shownPly() {
  return viewPly ?? game.move_count();
}

function setView(ply) {
  viewPly = ply !== null && ply >= game.move_count() ? null : ply;
  render();
  poke();
}

function humanInvolved() {
  return controllers[1] === "human" || controllers[2] === "human";
}

// If it's an engine's turn (and we're viewing live), let it move.
function poke() {
  clearTimeout(engineTimer);
  if (viewPly !== null || game.status() !== 0) return;
  const engine = engines[game.to_move()];
  if (!engine) return;
  engineTimer = setTimeout(() => {
    game.play(engine.choose(game, ENGINE_BUDGET_MS));
    redoStack = []; // a fresh engine move diverges from any undone line
    render();
    poke();
  }, 250);
}

function humanClick(cell) {
  if (viewPly !== null) { setView(null); return; }
  if (game.status() !== 0 || controllers[game.to_move()] !== "human") return;
  if (!game.is_legal(cell)) return;
  game.play(cell);
  redoStack = [];
  render();
  poke();
}

// Undo one ply; if a human plays an engine, keep undoing to the human's turn.
function doUndo() {
  clearTimeout(engineTimer);
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
  clearTimeout(engineTimer);
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
  renderBoard(g);
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

  // Theme-neutral last-move marker: a small board-coloured dot.
  const lastIt = items.find((it) => it.cell === last && it.content !== 0);
  if (lastIt) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastIt.x);
    dot.setAttribute("cy", lastIt.y);
    dot.setAttribute("r", 0.22);
    dot.classList.add("last-dot");
    svg.appendChild(dot);
  }

  const line = terminalLine(g, byAxial, last);
  if (line) {
    const el = document.createElementNS(ns, "line");
    el.setAttribute("x1", line[0].x);
    el.setAttribute("y1", line[0].y);
    el.setAttribute("x2", line[1].x);
    el.setAttribute("y2", line[1].y);
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
