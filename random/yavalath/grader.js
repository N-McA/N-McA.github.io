// Move grading and player history. Grades live in win-probability space so
// they stay comparable if the grading engine changes: raw engine scores
// (mate = ±30000) are squashed through a logistic, and a move's cost is the
// win probability it gave away versus the engine's best move. Raw scores are
// stored alongside the derived numbers so history can be re-graded later.

const NO_SCORE = -(2 ** 31);
const MATE = 30_000;
const PROVEN = MATE - 64; // scores beyond this encode a proved result
const HOPELESS_WP = 0.05; // best move below this: nothing left to lose

// Tags that carry no strength signal and are excluded from averages.
export const EXCLUDED = new Set(["forced", "hopeless"]);

export function winProb(score, k) {
  return 1 / (1 + Math.exp(-score / k));
}

// Grade one move given the ranked list of every legal move (best first,
// exact scores) for the position it was played in. Null when ungradeable
// (engine reported no values).
export function gradeMove(ranked, played, k) {
  if (!ranked.length) return null;
  const best = ranked[0];
  const entry = ranked.find((r) => r.cell === played);
  if (!entry || entry.score === NO_SCORE || best.score === NO_SCORE) return null;
  const wpLoss = Math.max(0, winProb(best.score, k) - winProb(entry.score, k));
  const nonLosing = ranked.filter((r) => r.score > -PROVEN).length;
  let tag;
  if (entry.score === best.score) tag = nonLosing <= 1 ? "forced" : "best";
  else if (winProb(best.score, k) < HOPELESS_WP) tag = "hopeless";
  else if (entry.score <= -PROVEN || wpLoss >= 0.2) tag = "blunder";
  else if (wpLoss >= 0.08) tag = "mistake";
  else if (wpLoss >= 0.03) tag = "inaccuracy";
  else tag = "good";
  return {
    cell: played,
    score: entry.score,
    best: best.score,
    bestCell: best.cell,
    wpLoss: Math.round(wpLoss * 1000) / 1000,
    tag,
    // Raw context for future re-grading / re-mapping.
    top: ranked.slice(0, 8).map((r) => [r.cell, r.score]),
  };
}

// Lichess-style accuracy curve: 0 loss -> 100, 4% -> ~84, 10% -> ~64, 20% -> ~40.
export function moveAccuracy(wpLoss) {
  return Math.max(0, Math.min(100, 103.16 * Math.exp(-4.354 * wpLoss) - 3.17));
}

export function gameStats(rec) {
  const graded = rec.grades.filter((g) => !EXCLUDED.has(g.tag));
  const n = graded.length;
  return {
    graded: n,
    acc: n ? graded.reduce((s, g) => s + moveAccuracy(g.wpLoss), 0) / n : null,
    meanLoss: n ? graded.reduce((s, g) => s + g.wpLoss, 0) / n : null,
    blunders: rec.grades.filter((g) => g.tag === "blunder").length,
    best: graded.filter((g) => g.tag === "best").length,
  };
}

// --- localStorage persistence ------------------------------------------

const HIST_KEY = "yavalath.history.v1";
const PREFS_KEY = "yavalath.prefs.v1";

export function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Insert or replace by id; drops oldest games if storage is full.
// Returns the stored array.
export function saveGame(rec) {
  const hist = loadHistory();
  const i = hist.findIndex((r) => r.id === rec.id);
  if (i >= 0) hist[i] = rec;
  else hist.push(rec);
  for (;;) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(hist));
      return hist;
    } catch {
      if (!hist.length) return hist; // storage unavailable altogether
      hist.shift();
    }
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(HIST_KEY);
  } catch {}
}

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
