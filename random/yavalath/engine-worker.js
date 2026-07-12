// Engine host: runs wasm searches off the main thread so the UI never
// freezes while an engine thinks. The app spawns two instances — one plays
// (seat engines), one analyses (hint + grading engines) — the protocol is
// identical, the main thread just partitions the traffic.
//
// Engines are stateful (transposition tables, tree reuse), so they live here
// keyed by slot ("seat1", "seat2", "hint", "grade") and positions travel as
// compact strings. A running search can't be interrupted; "cancel" marks an
// epoch so queued-but-unstarted choose requests are skipped instead.
import init, { WasmGame, WasmEngine } from "./pkg/yavalath_wasm.js";

let engineDefs = [];
const engines = new Map(); // slot -> {name, engine}
let cancelledBefore = 0; // choose requests with an older epoch are stale

const ready = init();

function makeEngine(name, seed) {
  const def = engineDefs.find((d) => d.name === name);
  return def?.yaml ? WasmEngine.from_yaml(def.yaml, seed) : new WasmEngine(name, seed);
}

// The slot's engine, (re)created when its configured name changed.
function slotEngine(slot, name, seed) {
  let s = engines.get(slot);
  if (!s || s.name !== name) {
    s = { name, engine: makeEngine(name, seed) };
    engines.set(slot, s);
  }
  return s.engine;
}

function handle(msg) {
  switch (msg.type) {
    case "init":
      engineDefs = msg.engineDefs;
      return {};
    case "setSlot": // configure a seat; name null = human, no engine
      if (msg.name) slotEngine(msg.slot, msg.name, msg.seed);
      else engines.delete(msg.slot);
      return {};
    case "reset": { // new game: reseed every live engine
      let i = 0n;
      for (const s of engines.values()) s.engine.reset(msg.seed + i++);
      return {};
    }
    case "choose": {
      if (msg.epoch < cancelledBefore) return { stale: true };
      const g = WasmGame.from_string(msg.compact);
      return { cell: engines.get(msg.slot).engine.choose(g, msg.budgetMs) };
    }
    case "rank": {
      const g = WasmGame.from_string(msg.compact);
      return { flat: slotEngine(msg.slot, msg.name, msg.seed).rank(g, msg.budgetMs, msg.n) };
    }
    default:
      throw new Error(`unknown message type ${msg.type}`);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelledBefore = Math.max(cancelledBefore, msg.before);
    return; // no reply
  }
  try {
    await ready;
    self.postMessage({ id: msg.id, ...handle(msg) });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err?.message ?? err) });
  }
};
