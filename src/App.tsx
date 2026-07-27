import { useState, useCallback, useMemo, useEffect, useRef, Fragment } from "react";

// --- Constants ----------------------------------------------------------------
const GOLD   = "#F59E0B";
const PURPLE = "#818CF8";
const BLUE   = "#38BDF8";
const GREEN  = "#10B981";
const RED    = "#F43F5E";
const BG     = "#F8FAFC";
const CARD   = "#FFFFFF";
const CARD2  = "#F1F5F9";
const BORDER = "#E2E8F0";
const TEXT   = "#0F172A";
const MUTED  = "#64748B";
const FONT   = "Helvetica, Arial, sans-serif";
const MONO   = "'SF Mono', 'Fira Code', 'Fira Mono', monospace";

const STORAGE_KEY  = "tournament:active-state";
const HISTORY_KEY  = "tournament:history";
const LOGO_KEY      = "tournament:logo";

// --- History helpers ----------------------------------------------------------
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function saveToHistory(entry) {
  try {
    const history = loadHistory();
    // Avoid duplicates: if an entry with the same id already exists, replace it
    const idx = history.findIndex(h => h.id === entry.id);
    if (idx >= 0) history[idx] = entry;
    else history.unshift(entry); // newest first
    // Keep last 50 tournaments
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch (e) {}
}

function deleteFromHistory(id) {
  try {
    const history = loadHistory().filter(h => h.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
}

// --- Logo helpers --------------------------------------------------------------
// Reads an image file, downscales it (preserving aspect ratio) so it never
// exceeds maxW x maxH, and returns a JPEG/PNG data URL - keeps the stored
// logo to a "responsible" size regardless of what the user uploads.
function resizeImageFile(file, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const isPng = file.type === "image/png" || file.type === "image/svg+xml";
        resolve(canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.9));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Build a compact summary of a completed bracket for history storage.
// We store results rather than the full matchMap to keep size small.
function summariseBracket(matchMap, players, grandFinalEnabled, winnersRounds, losersRounds, grandFinalId) {
  const wbFinalId = winnersRounds[winnersRounds.length - 1][0];
  const champion  = grandFinalEnabled
    ? (matchMap[grandFinalId] && matchMap[grandFinalId].winner)
    : (matchMap[wbFinalId] && matchMap[wbFinalId].winner);
  if (!champion) return null; // not finished yet

  // Flatten losersRounds (array of arrays of match ids) into a lookup set so
  // every LB match - not just the LB Prelim round - can be reliably tagged.
  const lbMatchIdSet = new Set((losersRounds || []).flat());

  // Build a compact results list: just settled non-bye matches
  const results = Object.values(matchMap)
    .filter(m => m.winner && !m.isBye)
    .sort((a, b) => a.matchNum - b.matchNum)
    .map(m => ({
      num: m.matchNum,
      p1: m.p1, p2: m.p2,
      winner: m.winner,
      p1Games: m.p1Games || 0, p2Games: m.p2Games || 0,
      isPrelim: m.isPrelim, isLBPrelim: m.isLBPrelim, isGrandFinal: m.isGrandFinal,
      isLB: lbMatchIdSet.has(m.id),
    }));

  return { champion, players, results };
}

// --- Responsive sizing --------------------------------------------------------
// Mobile-first sizes scaled up modestly on wider viewports so touch targets
// (especially the score +/- buttons) are comfortable on desktop without the
// whole layout ballooning.
function useViewportScale() {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 390));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // tiers: mobile (<640), tablet (640-1024), desktop (>1024)
  if (width >= 1024) return { tier: "desktop", scale: 1.35, cardWidth: 350, btn: 28, btnFont: 17 };
  if (width >= 640)  return { tier: "tablet",  scale: 1.15, cardWidth: 310, btn: 24, btnFont: 15 };
  return { tier: "mobile", scale: 1, cardWidth: 280, btn: 22, btnFont: 14 };
}

// --- Generic helpers ----------------------------------------------------------
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function isPow2(n)   { return n > 0 && (n & (n - 1)) === 0; }

function shuffleFisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Best-of helpers: given a "bestOf" (3/5/7) return games needed to win.
function gamesToWin(bestOf) { return Math.ceil(bestOf / 2); }

// --- Bracket Builder (double elimination) ------------------------------------
/**
 * Builds a double-elimination bracket using a PRELIM round for non-power-of-2
 * player counts, so the main bracket is always a clean power of 2 with no BYEs.
 */
function buildBracket(rawPlayers, opts = {}) {
  const { shuffle = true, bestOf = 3, groupLosers = [] } = opts;
  const players = shuffle ? shuffleFisherYates(rawPlayers) : [...rawPlayers];
  const n = players.length;
  let mainSize = 1;
  while (mainSize * 2 <= n) mainSize *= 2;

  const overflow = n - mainSize;

  let uid = 0;
  const newId = () => `m${++uid}`;
  let matchNum = 1;
  const matchMap = {};

  const newMatch = (extra = {}) => {
    const id = newId();
    matchMap[id] = {
      id, matchNum: matchNum++,
      p1: null, p2: null,
      winner: null, loser: null,
      isPrelim: false, isLBPrelim: false, isBye: false, autoWinner: null,
      p1FromMatchId: null, p2FromMatchId: null,
      p1IsLoserOf: false, p2IsLoserOf: false,
      winnerGoesToMatchId: null, winnerGoesToSlot: null,
      loserGoesToMatchId:  null, loserGoesToSlot:  null,
      bestOf,
      p1Games: 0, p2Games: 0,
      ...extra,
    };
    return id;
  };

  const directPlayers = players.slice(0, mainSize - overflow);
  const prelimPlayers = players.slice(mainSize - overflow);

  // -- Prelim Round ---------------------------------------------------------
  const prelimRound = [];
  const needsBye = prelimPlayers.length % 2 === 1;
  const prelimPairs = [];
  for (let i = 0; i + 1 < prelimPlayers.length; i += 2) {
    prelimPairs.push([prelimPlayers[i], prelimPlayers[i + 1]]);
  }
  if (needsBye) {
    prelimPairs.push([prelimPlayers[prelimPlayers.length - 1], null]);
  }

  for (const [a, b] of prelimPairs) {
    const isBye = !b;
    const auto  = isBye ? a : null;
    const id = newMatch({
      p1: a, p2: isBye ? "BYE" : b,
      isPrelim: true, isBye, autoWinner: auto, winner: auto,
    });
    prelimRound.push(id);
  }

  // -- Build WB R1 ----------------------------------------------------------
  const seedSlots = [
    ...directPlayers,
    ...prelimRound.map(id => ({ fromPrelim: id })),
  ];

  const wbR1 = [];
  for (let i = 0; i < mainSize / 2; i++) {
    const topSlot = seedSlots[i];
    const botSlot = seedSlots[mainSize - 1 - i];

    const id = newMatch();
    const m  = matchMap[id];

    if (typeof topSlot === "string") {
      m.p1 = topSlot;
    } else {
      matchMap[topSlot.fromPrelim].winnerGoesToMatchId = id;
      matchMap[topSlot.fromPrelim].winnerGoesToSlot    = "p1";
      m.p1FromMatchId = topSlot.fromPrelim;
      if (matchMap[topSlot.fromPrelim].autoWinner) {
        m.p1 = matchMap[topSlot.fromPrelim].autoWinner;
      }
    }

    if (typeof botSlot === "string") {
      m.p2 = botSlot;
    } else {
      matchMap[botSlot.fromPrelim].winnerGoesToMatchId = id;
      matchMap[botSlot.fromPrelim].winnerGoesToSlot    = "p2";
      m.p2FromMatchId = botSlot.fromPrelim;
      if (matchMap[botSlot.fromPrelim].autoWinner) {
        m.p2 = matchMap[botSlot.fromPrelim].autoWinner;
      }
    }

    wbR1.push(id);
  }

  // -- Winners Bracket subsequent rounds ------------------------------------
  const winnersRounds = [wbR1];
  let prev = wbR1;
  while (prev.length > 1) {
    const round = [];
    for (let i = 0; i < prev.length; i += 2) {
      const id = newMatch();
      matchMap[prev[i]].winnerGoesToMatchId   = id;
      matchMap[prev[i]].winnerGoesToSlot      = "p1";
      matchMap[prev[i + 1]].winnerGoesToMatchId = id;
      matchMap[prev[i + 1]].winnerGoesToSlot    = "p2";
      matchMap[id].p1FromMatchId = prev[i];
      matchMap[id].p2FromMatchId = prev[i + 1];
      round.push(id);
    }
    winnersRounds.push(round);
    prev = round;
  }

  // -- Losers Bracket -------------------------------------------------------
  // FIX: prelim losers pair against an EQUAL NUMBER of WB R1 losers in an
  // explicit "LB Prelim" round. Any remaining WB R1 losers (the ones not
  // paired against a prelim loser) move directly into LB R1.
  const losersRounds = [];
  const wbRoundsForLosers = winnersRounds.slice(0, -1); // exclude WB Final

  const prelimLoserFeeders = prelimRound
    .filter(id => !matchMap[id].isBye)
    .map(id => ({ fromMatch: id, isLoser: true }));

  const wbR1LoserFeeders = wbR1.map(id => ({ fromMatch: id, isLoser: true }));

  const makeMatch = (fa, fb, extra = {}) => {
    const id = newMatch(extra);
    const slotA = fa.isLoser ? "loser" : "winner";
    matchMap[fa.fromMatch][slotA + "GoesToMatchId"] = id;
    matchMap[fa.fromMatch][slotA + "GoesToSlot"]    = "p1";
    matchMap[id].p1FromMatchId = fa.fromMatch;
    matchMap[id].p1IsLoserOf   = fa.isLoser;
    const slotB = fb.isLoser ? "loser" : "winner";
    matchMap[fb.fromMatch][slotB + "GoesToMatchId"] = id;
    matchMap[fb.fromMatch][slotB + "GoesToSlot"]    = "p2";
    matchMap[id].p2FromMatchId = fb.fromMatch;
    matchMap[id].p2IsLoserOf   = fb.isLoser;
    return id;
  };

  const pairPool = (pool, extraTag = {}) => {
    const matchIds = [];
    const nextPool = [];
    for (let i = 0; i + 1 < pool.length; i += 2) {
      const id = makeMatch(pool[i], pool[i + 1], extraTag);
      matchIds.push(id);
      nextPool.push({ fromMatch: id, isLoser: false });
    }
    if (pool.length % 2 === 1) {
      const fa = pool[pool.length - 1];
      const id = newMatch({ isBye: true, p2: "BYE", ...extraTag });
      const slotA = fa.isLoser ? "loser" : "winner";
      matchMap[fa.fromMatch][slotA + "GoesToMatchId"] = id;
      matchMap[fa.fromMatch][slotA + "GoesToSlot"]    = "p1";
      matchMap[id].p1FromMatchId = fa.fromMatch;
      matchMap[id].p1IsLoserOf   = fa.isLoser;
      matchIds.push(id);
      nextPool.push({ fromMatch: id, isLoser: false });
    }
    return { matchIds, nextPool };
  };

  let lbPool = [];

  // Group losers from a prior group stage enter the LB directly as pre-seeded
  // players. We create a "group loser entry" match (isBye, auto-winner = the
  // player) so they have a fromMatch reference for the propagation system.
  const groupLoserFeeders = (groupLosers || []).map(playerName => {
    const id = newMatch({
      p1: playerName, p2: "BYE",
      isBye: true, isGroupLoserEntry: true,
      autoWinner: playerName, winner: playerName,
    });
    return { fromMatch: id, isLoser: false };
  });

  // LB Prelim: pair prelim losers 1:1 against an equal number of WB R1 losers.
  if (prelimLoserFeeders.length > 0) {
    const pairCount = Math.min(prelimLoserFeeders.length, wbR1LoserFeeders.length);
    const lbPrelimMatchIds = [];
    for (let i = 0; i < pairCount; i++) {
      const id = makeMatch(prelimLoserFeeders[i], wbR1LoserFeeders[i], { isLBPrelim: true });
      lbPrelimMatchIds.push(id);
      lbPool.push({ fromMatch: id, isLoser: false });
    }
    if (lbPrelimMatchIds.length) losersRounds.push(lbPrelimMatchIds);

    // Any leftover prelim losers (shouldn't normally happen, but be safe)
    for (let i = pairCount; i < prelimLoserFeeders.length; i++) {
      lbPool.push(prelimLoserFeeders[i]);
    }
    // Remaining WB R1 losers not used in LB Prelim go straight into the pool
    // feeding LB R1 (paired among themselves first if needed).
    const leftoverWbR1 = wbR1LoserFeeders.slice(pairCount);
    if (leftoverWbR1.length) {
      const { matchIds, nextPool } = pairPool(leftoverWbR1);
      // These play each other as LB R1 (or feed in alongside lbPool below)
      if (matchIds.length) {
        losersRounds.push(matchIds);
      }
      lbPool = [...lbPool, ...nextPool, ...(leftoverWbR1.length % 2 === 1 ? [] : [])];
    }
  } else {
    // No prelim round at all - standard LB starts from WB R1 losers directly.
    lbPool = [...wbR1LoserFeeders];
  }

  // Merge in any group-stage losers seeded directly into LB
  if (groupLoserFeeders.length > 0) {
    lbPool = [...lbPool, ...groupLoserFeeders];
  }

  // Reduce lbPool until its size matches the next WB round's size (so each
  // LB survivor can face a fresh WB drop-in 1:1).
  const targetSize = wbRoundsForLosers.length > 1 ? wbRoundsForLosers[1].length : 1;

  while (lbPool.length > targetSize) {
    const { matchIds, nextPool } = pairPool(lbPool);
    losersRounds.push(matchIds);
    lbPool = nextPool;
  }

  for (let wIdx = 1; wIdx < wbRoundsForLosers.length; wIdx++) {
    const dropIns = wbRoundsForLosers[wIdx];

    const mergeMatchIds = [];
    const afterMergePool = [];
    for (let i = 0; i < lbPool.length; i++) {
      const fa = lbPool[i];
      const fb = { fromMatch: dropIns[i], isLoser: true };
      const id = makeMatch(fa, fb);
      mergeMatchIds.push(id);
      afterMergePool.push({ fromMatch: id, isLoser: false });
    }
    losersRounds.push(mergeMatchIds);
    lbPool = afterMergePool;

    if (lbPool.length === 1) break;

    const { matchIds: battleIds, nextPool: afterBattle } = pairPool(lbPool);
    losersRounds.push(battleIds);
    lbPool = afterBattle;
  }

  // -- Grand Final ----------------------------------------------------------
  const gfId = newMatch({ isGrandFinal: true });
  const wbFinalId = winnersRounds[winnersRounds.length - 1][0];
  matchMap[wbFinalId].winnerGoesToMatchId = gfId;
  matchMap[wbFinalId].winnerGoesToSlot    = "p1";
  matchMap[gfId].p1FromMatchId = wbFinalId;

  if (losersRounds.length) {
    const lbFinalId = losersRounds[losersRounds.length - 1][0];
    matchMap[lbFinalId].winnerGoesToMatchId = gfId;
    matchMap[lbFinalId].winnerGoesToSlot    = "p2";
    matchMap[gfId].p2FromMatchId = lbFinalId;
  }

  return {
    matchMap,
    prelimRound: prelimRound.length ? prelimRound : null,
    winnersRounds,
    losersRounds,
    grandFinalId: gfId,
  };
}

// --- Single-elimination bracket (Plate tournament) ---------------------------
function buildSingleElim(rawPlayers, opts = {}) {
  const { shuffle = true, bestOf = 3 } = opts;
  const players = shuffle ? shuffleFisherYates(rawPlayers) : [...rawPlayers];
  const n = players.length;
  let mainSize = 1;
  while (mainSize < n) mainSize *= 2;

  let uid = 0;
  const newId = () => `p${++uid}`;
  let matchNum = 1;
  const matchMap = {};

  const newMatch = (extra = {}) => {
    const id = newId();
    matchMap[id] = {
      id, matchNum: matchNum++,
      p1: null, p2: null,
      winner: null, loser: null,
      isBye: false, autoWinner: null,
      p1FromMatchId: null, p2FromMatchId: null,
      winnerGoesToMatchId: null, winnerGoesToSlot: null,
      bestOf, p1Games: 0, p2Games: 0,
      ...extra,
    };
    return id;
  };

  // Pad with BYEs to reach power-of-2
  const seeded = [...players];
  while (seeded.length < mainSize) seeded.push(null); // null = BYE

  // Build R1
  const r1 = [];
  for (let i = 0; i < mainSize / 2; i++) {
    const p1 = seeded[i];
    const p2 = seeded[mainSize - 1 - i];
    const isBye = !p1 || !p2;
    const auto = isBye ? (p1 || p2) : null;
    const id = newMatch({
      p1: p1 || "BYE", p2: p2 || "BYE",
      isBye, autoWinner: auto, winner: auto,
    });
    r1.push(id);
  }

  const rounds = [r1];
  let prev = r1;
  while (prev.length > 1) {
    const round = [];
    for (let i = 0; i < prev.length; i += 2) {
      const id = newMatch();
      matchMap[prev[i]].winnerGoesToMatchId   = id;
      matchMap[prev[i]].winnerGoesToSlot      = "p1";
      matchMap[prev[i + 1]].winnerGoesToMatchId = id;
      matchMap[prev[i + 1]].winnerGoesToSlot    = "p2";
      matchMap[id].p1FromMatchId = prev[i];
      matchMap[id].p2FromMatchId = prev[i + 1];
      // Pre-populate if previous round was BYE
      if (matchMap[prev[i]].autoWinner) matchMap[id].p1 = matchMap[prev[i]].autoWinner;
      if (matchMap[prev[i + 1]].autoWinner) matchMap[id].p2 = matchMap[prev[i + 1]].autoWinner;
      // Auto-resolve this match if both inputs are known from BYEs
      if (matchMap[id].p1 && matchMap[id].p2 === "BYE") {
        matchMap[id].winner = matchMap[id].p1;
        matchMap[id].isBye = true;
        matchMap[id].autoWinner = matchMap[id].p1;
      } else if (matchMap[id].p2 && matchMap[id].p1 === "BYE") {
        matchMap[id].winner = matchMap[id].p2;
        matchMap[id].isBye = true;
        matchMap[id].autoWinner = matchMap[id].p2;
      }
      round.push(id);
    }
    rounds.push(round);
    prev = round;
  }

  return { matchMap, rounds, finalId: prev[0] };
}

// --- State engine: record / undo a result ------------------------------------
function propagate(matchMap, matchId, winner, loser) {
  const m = matchMap[matchId];
  const updated = { ...matchMap, [matchId]: { ...m, winner, loser: (loser != null ? loser : null) } };
  if (m.winnerGoesToMatchId) {
    const dest = updated[m.winnerGoesToMatchId];
    const next = { ...dest, [m.winnerGoesToSlot]: winner };
    updated[m.winnerGoesToMatchId] = next;
    if (dest.isBye) {
      return propagate(updated, m.winnerGoesToMatchId, winner, null);
    }
  }
  if (m.loserGoesToMatchId) {
    const dest = updated[m.loserGoesToMatchId];
    const next = { ...dest, [m.loserGoesToSlot]: loser };
    updated[m.loserGoesToMatchId] = next;
    if (dest.isBye) {
      return propagate(updated, m.loserGoesToMatchId, loser, null);
    }
  }
  return updated;
}

// Recursively clear a match's result and cascade-clear anything downstream
// that depended on it (used both for undo and for changing a winner).
function clearDownstream(matchMap, matchId) {
  const m = matchMap[matchId];
  if (!m) return matchMap;
  let updated = { ...matchMap };

  const wDest = m.winnerGoesToMatchId;
  const lDest = m.loserGoesToMatchId;

  if (wDest && updated[wDest]) {
    const dest = updated[wDest];
    const slot = m.winnerGoesToSlot;
    if (dest[slot]) {
      updated[wDest] = { ...dest, [slot]: null };
      if (dest.winner) {
        updated = clearDownstream(updated, wDest);
      }
      updated[wDest] = { ...updated[wDest], winner: null, loser: null, p1Games: 0, p2Games: 0 };
    }
  }
  if (lDest && updated[lDest]) {
    const dest = updated[lDest];
    const slot = m.loserGoesToSlot;
    if (dest[slot]) {
      updated[lDest] = { ...dest, [slot]: null };
      if (dest.winner) {
        updated = clearDownstream(updated, lDest);
      }
      updated[lDest] = { ...updated[lDest], winner: null, loser: null, p1Games: 0, p2Games: 0 };
    }
  }
  return updated;
}

function recordWinner(matchMap, matchId, winner) {
  const m = matchMap[matchId];
  if (!m || m.isBye) return matchMap;
  if (!m.p1 || !m.p2) return matchMap;
  const loser = winner === m.p1 ? m.p2 : m.p1;
  return propagate(matchMap, matchId, winner, loser);
}

// Change a previously-recorded winner: clears anything downstream that used
// the old result, then records the new one. Game scores are reset to a
// clean winner/need-loser/0 state so edited matches never show stale or
// inconsistent (e.g. negative) per-player scores.
function changeWinner(matchMap, matchId, newWinner) {
  const m = matchMap[matchId];
  if (!m || m.isBye) return matchMap;
  let cleared = clearDownstream(matchMap, matchId);
  const need = gamesToWin(m.bestOf || 3);
  const isP1Winner = newWinner === m.p1;
  cleared = {
    ...cleared,
    [matchId]: {
      ...cleared[matchId],
      winner: null, loser: null,
      p1Games: isP1Winner ? need : 0,
      p2Games: isP1Winner ? 0 : need,
    },
  };
  return recordWinner(cleared, matchId, newWinner);
}

function slotLabel(matchMap, matchId, slot) {
  const m = matchMap[matchId];
  const fromId = slot === "p1" ? m.p1FromMatchId : m.p2FromMatchId;
  const isLoser = slot === "p1" ? m.p1IsLoserOf : m.p2IsLoserOf;
  if (!fromId) return null;
  const src = matchMap[fromId];
  return isLoser
    ? `Loser of Match ${src.matchNum}`
    : `Winner of Match ${src.matchNum}`;
}

// --- Bracket layout math -------------------------------------------------------
// FIFA's rail keeps a fixed, card-to-card "pitch" for the selected round,
// then doubles that pitch for every round to its right.  Earlier rounds also
// use the base pitch, which is what makes them collapse neatly when a later
// round is selected.  The important detail is that the pitch is derived from
// the selected round, rather than recursively from Round 1.
const BRACKET_BASE_GAP = 14;
// Height of the round title label (font-size 11 + marginBottom 12) above each
// RoundCol's card list - connector gutters need this same top offset so their
// lines land on the card-list baseline, not the title baseline.
const BRACKET_TITLE_BLOCK_HEIGHT = 26;

// A clean knockout tree halves every round, but a Winners prelim can grow
// (1 -> 8), a Losers round can merge new drop-ins (4 -> 4), and a Plate can
// start with a bye.  FIFA's pitch-doubling rule still applies whenever a
// round genuinely halves; otherwise, retain the previous pitch.
function computeTopologyLayout(rounds, activeIndex, cardHeight) {
  const focus = activeIndex >= 0 && activeIndex < rounds.length ? activeIndex : 0;
  const basePitch = cardHeight + BRACKET_BASE_GAP;
  const gaps = [];
  const offsets = [];
  let previousPitch = basePitch;

  for (let i = 0; i < rounds.length; i++) {
    if (i <= focus) {
      gaps[i] = BRACKET_BASE_GAP;
      offsets[i] = 0;
      previousPitch = basePitch;
      continue;
    }

    const previousCount = Math.max(1, rounds[i - 1].length);
    const currentCount = Math.max(1, rounds[i].length);
    // Grow only when this round genuinely eliminates matches.  The cap keeps
    // a prelim/bye from producing an exaggerated jump.
    const ratio = currentCount < previousCount
      ? Math.min(2, previousCount / currentCount)
      : 1;
    const pitch = previousPitch * ratio;
    gaps[i] = Math.max(BRACKET_BASE_GAP, pitch - cardHeight);
    offsets[i] = offsets[i - 1] + (pitch - previousPitch) / 2;
    previousPitch = pitch;
  }
  return { gaps, offsets };
}

// Vertical center (relative to that round's card-list top) of card k in a
// round with the given offset/gap/cardHeight.
function bracketCardCenter(offset, gap, cardHeight, k) {
  return offset + k * (cardHeight + gap) + cardHeight / 2;
}

// Draws the elbow ("bracket") connector lines in the gutter between two
// adjacent rounds. Uses each target match's REAL feeders (p1FromMatchId /
// p2FromMatchId) rather than assuming positional 2:1 pairing - this matters
// because LB "merge" rounds pair an LB survivor with a freshly-dropped WB
// loser, which breaks any simple index-based pairing assumption.
function BracketConnectors({ feederRound, targetRound, matchMap, feederOffset, feederGap, targetOffset, targetGap, cardHeight, gutterWidth, color, hide }) {
  // A large prelim pool can feed many different Round 1 positions. Drawing
  // every long elbow in a narrow gutter produces an unreadable purple wall;
  // the destination card already names its source match, so omit that one
  // exceptional connector group while retaining every normal bracket link.
  if (hide) return null;
  if (!feederRound || !targetRound || !feederRound.length || !targetRound.length || !cardHeight || !matchMap) return null;
  const lineStyle = { stroke: color, strokeWidth: 2, transition: "x1 0.35s cubic-bezier(0.4,0,0.2,1), x2 0.35s cubic-bezier(0.4,0,0.2,1), y1 0.35s cubic-bezier(0.4,0,0.2,1), y2 0.35s cubic-bezier(0.4,0,0.2,1)" };
  const xStart = 0, xMid = gutterWidth / 2, xEnd = gutterWidth;
  const feederIndexOf = new Map(feederRound.map((id, idx) => [id, idx]));
  const lines = [];

  targetRound.forEach((targetId, r) => {
    const t = matchMap[targetId];
    if (!t) return;
    const feederIds = [t.p1FromMatchId, t.p2FromMatchId].filter(id => id != null && feederIndexOf.has(id));
    const yMid = bracketCardCenter(targetOffset, targetGap, cardHeight, r);

    if (feederIds.length === 2) {
      // Both slots trace back into this round - classic elbow connector
      const y1 = bracketCardCenter(feederOffset, feederGap, cardHeight, feederIndexOf.get(feederIds[0]));
      const y2 = bracketCardCenter(feederOffset, feederGap, cardHeight, feederIndexOf.get(feederIds[1]));
      lines.push(<line key={`a-${targetId}`} x1={xStart} y1={y1} x2={xMid} y2={y1} style={lineStyle} />);
      lines.push(<line key={`b-${targetId}`} x1={xStart} y1={y2} x2={xMid} y2={y2} style={lineStyle} />);
      lines.push(<line key={`c-${targetId}`} x1={xMid} y1={y1} x2={xMid} y2={y2} style={lineStyle} />);
      lines.push(<line key={`d-${targetId}`} x1={xMid} y1={yMid} x2={xEnd} y2={yMid} style={lineStyle} />);
    } else if (feederIds.length === 1) {
      // Only one slot traces back into this round (the other is a bye, a
      // direct seed, or - in LB merge rounds - a loser dropping in from a
      // WB round we're not drawing a connector to here). Draw one line.
      const y = bracketCardCenter(feederOffset, feederGap, cardHeight, feederIndexOf.get(feederIds[0]));
      lines.push(<line key={`s-${targetId}`} x1={xStart} y1={y} x2={xEnd} y2={yMid} style={lineStyle} />);
    }
    // 0 feeders in this round: nothing traceable here, draw nothing.
  });

  if (!lines.length) return null;

  const feederExtent = feederOffset + feederRound.length * (cardHeight + feederGap);
  const targetExtent = targetOffset + targetRound.length * (cardHeight + targetGap);
  const height = Math.max(feederExtent, targetExtent) + 40;

  return (
    <svg width={gutterWidth} height={height} style={{ display: "block", overflow: "visible" }}>
      {lines}
    </svg>
  );
}

// --- Score entry helpers ------------------------------------------------------
function applyScoreChange(matchMap, matchId, who, delta) {
  const m = matchMap[matchId];
  if (!m || m.isBye || m.winner) return matchMap; // locked once decided
  const need = gamesToWin(m.bestOf || 3);
  let p1Games = m.p1Games || 0;
  let p2Games = m.p2Games || 0;
  // Clamp to [0, need] so a score can never go negative, and a player's
  // game count can never exceed what's needed to win (e.g. best of 3 ->
  // max 2). The loser keeps whatever count they reached, e.g. a 2-0 leaves
  // the loser at 0, a 2-1 leaves the loser at 1.
  if (who === "p1") p1Games = Math.max(0, Math.min(need, p1Games + delta));
  else p2Games = Math.max(0, Math.min(need, p2Games + delta));

  let updated = { ...matchMap, [matchId]: { ...m, p1Games, p2Games } };

  if (p1Games >= need && m.p1 && m.p2) {
    updated = recordWinner(updated, matchId, m.p1);
  } else if (p2Games >= need && m.p1 && m.p2) {
    updated = recordWinner(updated, matchId, m.p2);
  }
  return updated;
}

// ===========================================================================
// ROUND ROBIN GROUP STAGE
// ===========================================================================

// Distribute n players into k groups, sizes differing by at most 1.
function distributeGroups(players, groupCount) {
  const groups = Array.from({ length: groupCount }, () => []);
  // Snake-seed for fairness (1->A,2->B,...,then reverse) using shuffled order
  const shuffled = shuffleFisherYates(players);
  let gi = 0, dir = 1;
  for (const p of shuffled) {
    groups[gi].push(p);
    gi += dir;
    if (gi === groupCount) { gi = groupCount - 1; dir = -1; }
    else if (gi < 0) { gi = 0; dir = 1; }
  }
  return groups;
}

function suggestGroupCount(n) {
  // Aim for groups of 3-5 players where possible.
  if (n <= 5) return 1;
  for (const target of [4, 5, 3]) {
    const k = Math.round(n / target);
    if (k >= 2 && n / k >= 3 && n / k <= 6) return k;
  }
  return Math.max(1, Math.ceil(n / 4));
}

function buildRoundRobinMatches(group, bestOf) {
  // Round-robin pairing (circle method), with BYE row if odd.
  const players = [...group];
  const hasBye = players.length % 2 === 1;
  if (hasBye) players.push("__BYE__");
  const n = players.length;
  const rounds = [];
  const fixed = players[0];
  let rest = players.slice(1);

  for (let r = 0; r < n - 1; r++) {
    const roundArr = [fixed, ...rest];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = roundArr[i];
      const b = roundArr[n - 1 - i];
      pairs.push([a, b]);
    }
    rounds.push(pairs);
    rest.unshift(rest.pop());
  }

  let uid = 0;
  const matches = [];
  for (const round of rounds) {
    for (const [a, b] of round) {
      if (a === "__BYE__" || b === "__BYE__") {
        const realPlayer = a === "__BYE__" ? b : a;
        matches.push({
          id: `rr${++uid}`, p1: realPlayer, p2: "BYE",
          isBye: true, isWalkover: true,
          winner: realPlayer, loser: null,
          bestOf, p1Games: gamesToWin(bestOf), p2Games: 0,
        });
      } else {
        matches.push({
          id: `rr${++uid}`, p1: a, p2: b,
          isBye: false, winner: null, loser: null,
          bestOf, p1Games: 0, p2Games: 0,
        });
      }
    }
  }
  return matches;
}

function computeStandings(group, matches, tiebreakOverrides) {
  const overrides = tiebreakOverrides || [];
  const stats = {};
  for (const p of group) {
    stats[p] = { player: p, wins: 0, losses: 0, gamesWon: 0, gamesPlayed: 0, played: 0 };
  }
  for (const m of matches) {
    if (m.isWalkover) continue;
    if (!m.winner) continue;
    const loser = m.winner === m.p1 ? m.p2 : m.p1;
    if (stats[m.winner]) { stats[m.winner].wins += 1; stats[m.winner].played += 1; }
    if (stats[loser])    { stats[loser].losses += 1; stats[loser].played += 1; }
    if (stats[m.p1]) { stats[m.p1].gamesWon += m.p1Games; stats[m.p1].gamesPlayed += (m.p1Games + m.p2Games); }
    if (stats[m.p2]) { stats[m.p2].gamesWon += m.p2Games; stats[m.p2].gamesPlayed += (m.p1Games + m.p2Games); }
  }
  const list = Object.values(stats).map(s => ({
    ...s,
    ppg: s.gamesPlayed ? s.gamesWon / s.gamesPlayed : 0,
    gameDiff: s.gamesPlayed ? (s.gamesWon - (s.gamesPlayed - s.gamesWon)) : 0,
  }));
  list.sort((a, b) => {
    if (b.ppg !== a.ppg) return b.ppg - a.ppg;
    if (b.gameDiff !== a.gameDiff) return b.gameDiff - a.gameDiff;
    if (b.gamesWon !== a.gamesWon) return b.gamesWon - a.gamesWon;
    const ai = overrides.indexOf(a.player);
    const bi = overrides.indexOf(b.player);
    if (ai !== -1 && bi === -1) return -1;
    if (bi !== -1 && ai === -1) return 1;
    if (ai !== -1 && bi !== -1) return ai - bi;
    return a.player.localeCompare(b.player);
  });
  return list;
}

// ===========================================================================
// UI: shared bits
// ===========================================================================

// --- Tooltip ------------------------------------------------------------------
function Tooltip({ label, children }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);

  const show = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.top + window.scrollY, left: r.left + r.width / 2 });
    }
    setVisible(true);
  };

  return (
    <>
      <div
        ref={triggerRef}
        style={{ display: "inline-flex", alignItems: "center", cursor: "help" }}
        onMouseEnter={show}
        onMouseLeave={() => setVisible(false)}
        onClick={(e) => { e.stopPropagation(); visible ? setVisible(false) : show(); }}
      >
        {children}
      </div>
      {visible && (
        <div style={{
          position: "fixed",
          top: pos.top - 8,
          left: pos.left,
          transform: "translate(-50%, -100%)",
          background: "#1A1D24",
          border: `1px solid ${BORDER}`,
          borderRadius: 10, padding: "10px 14px",
          fontSize: 13, color: TEXT, fontFamily: FONT,
          whiteSpace: "pre-line", lineHeight: 1.6,
          width: 240, zIndex: 9999,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          pointerEvents: "none",
        }}>
          {label}
          <div style={{
            position: "absolute", top: "100%", left: "50%",
            transform: "translateX(-50%)",
            border: "6px solid transparent",
            borderTopColor: "#1A1D24",
          }} />
        </div>
      )}
    </>
  );
}

function ScoreInline({ m, who, accent, onScore, scale }) {
  if (m.isBye) return null;
  const s = scale || { btn: 18, btnFont: 12 };
  const games = Math.max(0, who === "p1" ? (m.p1Games || 0) : (m.p2Games || 0));
  const disabled = !!m.winner || !m.p1 || !m.p2;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
      <button
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onScore(m.id, who, -1); }}
        style={pipBtnStyle(false, s)}
        aria-label={`Decrease ${who === "p1" ? "first" : "second"} player's score`}
      >−</button>
      <div aria-label={`${games} games`} style={{
        minWidth: s.tier === "desktop" ? 24 : 20,
        textAlign: "center", color: accent,
        fontSize: s.tier === "desktop" ? 20 : 17,
        fontWeight: 700, fontFamily: MONO, lineHeight: 1,
      }}>{games}</div>
      <button
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onScore(m.id, who, 1); }}
        style={pipBtnStyle(true, s)}
        aria-label={`Increase ${who === "p1" ? "first" : "second"} player's score`}
      >+</button>
    </div>
  );
}

function pipBtnStyle(plus, s) {
  const size = (s && s.btn) || 18;
  return {
    width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.22)),
    border: `1px solid ${BORDER}`, background: CARD2, color: TEXT,
    fontSize: (s && s.btnFont) || 12, fontWeight: 600, lineHeight: 1, cursor: "pointer", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}

// --- MatchCard ----------------------------------------------------------------
function MatchCard({ matchId, matchMap, onPickWinner, onChangeWinner, onScore, isLosers, isGrandFinal, useScoring, scale, editingMatchId, setEditingMatchId, readOnly }) {
  const m = matchMap[matchId];
  const accent = isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE;
  const s = scale || { tier: "mobile", cardWidth: 170, pip: 9, btn: 18, btnFont: 12 };

  const players = [
    { player: m.p1, slot: "p1" },
    { player: m.p2, slot: "p2" },
  ];

  const ready   = m.p1 && m.p2 && !m.winner && !m.isBye && m.p1 !== "BYE" && m.p2 !== "BYE";
  const settled = !!m.winner;

  const matchLabel = isGrandFinal ? "FINAL" : `M ${m.matchNum}`;
  const labelRailWidth = s.tier === "desktop" ? 58 : 50;

  // editing state is lifted to parent so it survives tab switches
  const editing = editingMatchId === matchId;
  const setEditing = (v) => setEditingMatchId && setEditingMatchId(v ? matchId : null);

  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${settled ? accent + "88" : BORDER}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 10,
        minWidth: s.cardWidth,
        width: s.cardWidth,
        fontFamily: FONT,
        boxShadow: isGrandFinal && settled ? `0 0 24px ${GOLD}44` : "none",
        overflow: "hidden",
        position: "relative",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* FIFA-style match label rail: it no longer consumes vertical space,
          so the visual/card centre is the centre of the two player rows. */}
      <div style={{
        position: "absolute", inset: "0 auto 0 0", width: labelRailWidth,
        background: `${accent}18`, borderRight: `1px solid ${BORDER}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: accent, fontSize: s.tier === "desktop" ? 14 : 13,
        fontFamily: MONO, letterSpacing: "0.08em", fontWeight: 800,
        writingMode: "vertical-rl", transform: "rotate(180deg)",
        pointerEvents: "none",
      }}>{matchLabel}</div>

      {(ready && !useScoring) && (
        <div style={{ position: "absolute", top: 7, right: 9, zIndex: 1, color: MUTED, fontSize: 10, fontFamily: MONO, letterSpacing: "0.06em", pointerEvents: "none" }}>TAP</div>
      )}
      {settled && !editing && !readOnly && (
        <span
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          style={{ position: "absolute", top: 7, right: 9, zIndex: 1, fontSize: 10, color: GREEN, cursor: "pointer", opacity: hovered ? 1 : 0.7, fontFamily: MONO }}
          title="Tap to change winner"
        >{hovered ? "EDIT" : "v"}</span>
      )}
      {settled && !editing && readOnly && (
        <span style={{ position: "absolute", top: 7, right: 9, zIndex: 1, fontSize: 10, color: GREEN, fontFamily: MONO }}>v</span>
      )}
      {settled && editing && (
        <span
          onClick={(e) => { e.stopPropagation(); setEditing(false); }}
          style={{ position: "absolute", top: 7, right: 9, zIndex: 1, fontSize: 10, color: MUTED, cursor: "pointer", fontWeight: 700, fontFamily: MONO }}
        >CANCEL</span>
      )}

      {players.map(({ player, slot }, i) => {
        const fromLabel = !player ? slotLabel(matchMap, matchId, slot) : null;
        const isWinner  = settled && m.winner === player;
        const isLoserP  = settled && m.loser === player;
        const canTap    = !readOnly && (ready || (settled && editing)) && !!player && player !== "BYE";

        return (
          <div
            key={slot}
            onClick={() => {
              if (!canTap) return;
              if (settled && editing) { onChangeWinner(matchId, player); setEditing(false); }
              else if (ready && !useScoring) onPickWinner(matchId, player);
            }}
            style={{
              padding: s.tier === "desktop" ? "12px 14px 11px" : s.tier === "tablet" ? "10px 12px 9px" : "9px 10px 8px",
              paddingLeft: labelRailWidth + (s.tier === "desktop" ? 14 : s.tier === "tablet" ? 12 : 10),
              borderBottom: i === 0 ? `1px solid ${BORDER}` : "none",
              background: isWinner ? `${accent}22` : isLoserP ? "#ffffff08" : "transparent",
              cursor: canTap ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              gap: 7,
              transition: "background 0.15s",
              minHeight: s.tier === "desktop" ? 50 : s.tier === "tablet" ? 46 : 42,
            }}
          >
            {isWinner && <span style={{ fontSize: 11, color: accent, flexShrink: 0 }}>{"|>"}</span>}
            {isLoserP && <span style={{ fontSize: 11, color: MUTED, flexShrink: 0 }}>x</span>}
            {!isWinner && !isLoserP && <span style={{ width: 14, flexShrink: 0 }} />}

            <div style={{ overflow: "hidden", flex: 1 }}>
              {player && player !== "BYE" ? (
                <div style={{
                  fontSize: s.tier === "desktop" ? 18 : s.tier === "tablet" ? 16 : 15,
                  fontWeight: isWinner ? 700 : 400,
                  color: isLoserP ? MUTED : TEXT,
                  textDecoration: isLoserP ? "line-through" : "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>{player}</div>
              ) : player === "BYE" ? (
                <div style={{ fontSize: 14, color: MUTED, fontStyle: "italic" }}>BYE</div>
              ) : (
                <>
                  <div style={{ fontSize: 14, color: MUTED, fontStyle: "italic" }}>TBD</div>
                  {fromLabel && (
                    <div style={{
                      fontSize: 11, color: isLosers ? BLUE + "bb" : MUTED,
                      fontFamily: MONO, marginTop: 1, letterSpacing: "0.03em",
                    }}>{fromLabel}</div>
                  )}
                </>
              )}
            </div>
            {settled && useScoring && !m.isBye && (
              <div style={{ fontSize: s.tier === "desktop" ? 18 : 15, fontWeight: 700, color: isWinner ? accent : MUTED }}>
                {Math.max(0, slot === "p1" ? (m.p1Games || 0) : (m.p2Games || 0))}
              </div>
            )}
            {!settled && useScoring && !m.isBye && m.p1 && m.p2 && (
              <ScoreInline m={m} who={slot} accent={accent} onScore={onScore} scale={s} />
            )}
            {canTap && !useScoring && (
              <span style={{ fontSize: 18, color: `${accent}55`, flexShrink: 0, lineHeight: 1 }}>{">"}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- SaveBadge ----------------------------------------------------------------
function SaveBadge({ status, error }) {
  if (status === "idle") return null;
  const cfg = {
    saving: { color: MUTED,  label: "Saving..." },
    saved:  { color: GREEN,  label: "Saved" },
    error:  { color: RED,    label: `Save failed: ${error || "unknown error"}` },
  }[status] || null;
  if (!cfg) return null;
  return (
    <div style={{
      fontSize: 11, fontFamily: MONO, color: cfg.color,
      letterSpacing: "0.05em", flexShrink: 0, maxWidth: 200,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{cfg.label}</div>
  );
}

function RoundCol({ title, matchIds, matchMap, onPickWinner, onChangeWinner, onScore, isLosers, isGrandFinal, spacing, offset, useScoring, scale, editingMatchId, setEditingMatchId, readOnly, isActive }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{
        fontSize: 11, fontFamily: "inherit",
        color: isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE,
        letterSpacing: "0.08em", fontWeight: 700, marginBottom: 12,
        textTransform: "uppercase", paddingLeft: 2,
        opacity: isActive === false ? 0.55 : 1,
        transition: "opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
      }}>{title}</div>

      <div style={{
        display: "flex", flexDirection: "column", gap: (spacing != null ? spacing : 16),
        justifyContent: "flex-start", flex: 1,
        paddingTop: offset || 0,
        transition: "gap 0.35s cubic-bezier(0.4, 0, 0.2, 1), padding-top 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
        {(Array.isArray(matchIds) ? matchIds : [matchIds]).map(id => (
          <div key={id} data-bracket-card="true">
            <MatchCard
              matchId={id} matchMap={matchMap}
              onPickWinner={onPickWinner} onChangeWinner={onChangeWinner} onScore={onScore}
              isLosers={isLosers} isGrandFinal={isGrandFinal} useScoring={useScoring} scale={scale}
              editingMatchId={editingMatchId} setEditingMatchId={setEditingMatchId} readOnly={readOnly}
            />
          </div>
        ))}
      </div>
    </div>
  );
}


// ===========================================================================
// SETUP SCREEN
// ===========================================================================

// ===========================================================================
// HISTORY SCREEN
// ===========================================================================

function HistoryScreen({ onBack }) {
  const [history, setHistory] = useState(() => loadHistory());
  const [expanded, setExpanded] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const handleDelete = (id) => {
    deleteFromHistory(id);
    setHistory(loadHistory());
    setConfirmDelete(null);
    if (expanded === id) setExpanded(null);
  };

  const formatDate = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
        + " - " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return iso; }
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT }}>
      {/* Header */}
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "14px 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "6px 12px", cursor: "pointer", fontSize: 14, fontFamily: "inherit", flexShrink: 0 }}>Back</button>
          <div>
            <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: GOLD, letterSpacing: "0.06em", textTransform: "uppercase" }}>Tournament History</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{history.length} {history.length === 1 ? "tournament" : "tournaments"}</div>
          </div>
        </div>
      </div>

      <div style={{ padding: "20px 16px 40px" }}>
        {history.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: MUTED }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}></div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>No past tournaments yet</div>
            <div style={{ fontSize: 14, color: MUTED }}>Completed tournaments will appear here automatically once a champion is crowned.</div>
          </div>
        )}

        {history.map((entry) => {
          const isOpen = expanded === entry.id;
          const isConfirm = confirmDelete === entry.id;

          // Group results by round type for display
          const allResults = entry.results || [];

          return (
            <div key={entry.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, marginBottom: 12, overflow: "hidden" }}>
              {/* Entry header */}
              <div
                onClick={() => setExpanded(isOpen ? null : entry.id)}
                style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Single compact line: name/date - champion - format - players */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.name || formatDate(entry.completedAt)}
                    </span>
                    <span style={{ color: BORDER, flexShrink: 0 }}>|</span>
                    <span style={{ fontSize: 13, flexShrink: 0 }}>T</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: GOLD, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {entry.champion}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "nowrap", overflow: "hidden" }}>
                    {entry.name && (
                      <span style={{ fontSize: 11, color: MUTED, flexShrink: 0, whiteSpace: "nowrap" }}>{formatDate(entry.completedAt)}</span>
                    )}
                    {entry.name && <span style={{ fontSize: 11, color: BORDER, flexShrink: 0 }}>|</span>}
                    <span style={{ fontSize: 11, color: MUTED, flexShrink: 0, whiteSpace: "nowrap" }}>{entry.playerCount}p</span>
                    <span style={{ fontSize: 11, color: BORDER, flexShrink: 0 }}>|</span>
                    <span style={{ fontSize: 11, color: MUTED, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.format}</span>
                    {entry.lbChampion && <span style={{ fontSize: 11, color: BORDER, flexShrink: 0 }}>|</span>}
                    {entry.lbChampion && <span style={{ fontSize: 11, color: BLUE, flexShrink: 0, whiteSpace: "nowrap" }}>LB: {entry.lbChampion}</span>}
                  </div>
                </div>
                <div style={{ fontSize: 20, color: MUTED, flexShrink: 0 }}>{isOpen ? "v" : ">"}</div>
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div style={{ borderTop: `1px solid ${BORDER}`, padding: "14px 16px" }}>

                  {/* Players */}
                  <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Players</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
                    {(entry.players || []).map((p) => (
                      <span key={p} style={{
                        fontSize: 13, padding: "4px 10px", borderRadius: 8,
                        background: p === entry.champion ? `${GOLD}22` : CARD2,
                        border: `1px solid ${p === entry.champion ? GOLD + "66" : BORDER}`,
                        color: p === entry.champion ? GOLD : TEXT,
                        fontWeight: p === entry.champion ? 700 : 400,
                      }}>
                        {p === entry.champion ? "[W] " : ""}{p}
                      </span>
                    ))}
                  </div>

                  {/* Results */}
                  {allResults.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Results</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {allResults.map((r) => {
                          const label = r.isGrandFinal ? "Grand Final"
                            : r.isPrelim ? "WB Prelim"
                            : r.isLBPrelim ? "LB Prelim"
                            : r.isLB ? `LB - Match ${r.num}`
                            : `WB - Match ${r.num}`;
                          const accentColor = r.isGrandFinal ? GOLD : (r.isPrelim || r.isLBPrelim || r.isLB) ? BLUE : PURPLE;
                          const scored = r.p1Games > 0 || r.p2Games > 0;
                          return (
                            <div key={r.num} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: CARD2, borderRadius: 10, borderLeft: `3px solid ${accentColor}` }}>
                              <div style={{ fontSize: 11, color: accentColor, fontWeight: 600, minWidth: 100, flexShrink: 0 }}>{label}</div>
                              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 14, fontWeight: r.winner === r.p1 ? 700 : 400, color: r.winner === r.p1 ? TEXT : MUTED, textDecoration: r.winner !== r.p1 ? "line-through" : "none" }}>{r.p1}</span>
                                {scored && <span style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}>{r.p1Games}-{r.p2Games}</span>}
                                <span style={{ fontSize: 12, color: MUTED }}>vs</span>
                                <span style={{ fontSize: 14, fontWeight: r.winner === r.p2 ? 700 : 400, color: r.winner === r.p2 ? TEXT : MUTED, textDecoration: r.winner !== r.p2 ? "line-through" : "none" }}>{r.p2}</span>
                              </div>
                              <span style={{ fontSize: 12, color: accentColor, flexShrink: 0 }}>Winner: {r.winner}</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* Group stage summary */}
                  {entry.groupSummary && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 18, marginBottom: 10 }}>Group Stage</div>
                      {entry.groupSummary.map((g, gi) => (
                        <div key={gi} style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: PURPLE, marginBottom: 6 }}>Group {String.fromCharCode(65 + gi)}</div>
                          {g.standings.map((s, si) => (
                            <div key={s.player} style={{ display: "flex", gap: 10, padding: "5px 10px", background: si < g.advance ? `${GREEN}11` : "transparent", borderRadius: 6, fontSize: 13 }}>
                              <span style={{ color: si < g.advance ? GREEN : MUTED, fontWeight: 700, minWidth: 16 }}>{si + 1}</span>
                              <span style={{ flex: 1, fontWeight: si < g.advance ? 600 : 400 }}>{s.player}</span>
                              <span style={{ color: MUTED, fontFamily: MONO, fontSize: 12 }}>{s.wins}-{s.losses}</span>
                              <span style={{ color: MUTED, fontFamily: MONO, fontSize: 12 }}>{s.ppg.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  )}

                  {/* Delete */}
                  <div style={{ marginTop: 18, borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
                    {!isConfirm ? (
                      <button onClick={() => setConfirmDelete(entry.id)} style={{ background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED, fontSize: 13, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                        Delete this record
                      </button>
                    ) : (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 13, color: MUTED }}>Delete permanently?</span>
                        <button onClick={() => handleDelete(entry.id)} style={{ background: RED, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Delete</button>
                        <button onClick={() => setConfirmDelete(null)} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, fontSize: 13, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ===========================================================================
// SETUP SCREEN
// ===========================================================================

function SetupScreen({ onGenerateBracket, onGenerateGroups, savedExists, savedAt, onResume, onDiscard, loadError, onHistory, logoDataUrl, onSetLogo }) {
  const [mode, setMode] = useState("bracket"); // "bracket" | "groups"
  const [tournamentName, setTournamentName] = useState("");
  const [count, setCount] = useState(8);
  const [names, setNames] = useState(Array.from({ length: 8 }, () => ""));
  const [grandFinalEnabled, setGrandFinalEnabled] = useState(true);
  const [elimType, setElimType] = useState("double"); // "single" | "double"
  const [bestOf, setBestOf] = useState(3);
  const [useScoring, setUseScoring] = useState(true);

  // Group stage settings
  const [groupCount, setGroupCount] = useState(2);
  const [advancePerGroup, setAdvancePerGroup] = useState(2);
  const [groupsTouched, setGroupsTouched] = useState(false);

  // Plate settings (shared across both modes)
  const [plateEnabled, setPlateEnabled] = useState(false);
  const [platePlayers, setPlatePlayers] = useState([]);

  const updateCount = (n) => {
    const c = Math.max(2, Math.min(64, n));
    setCount(c);
    setNames(prev => {
      const next = [...prev];
      while (next.length < c) next.push("");
      return next.slice(0, c);
    });
    if (!groupsTouched) setGroupCount(suggestGroupCount(c));
  };

  const perfect = isPow2(count);
  const effectiveGroupCount = Math.max(1, Math.min(groupCount, count));
  const groupSizes = useMemo(() => {
    const base = Math.floor(count / effectiveGroupCount);
    const extra = count % effectiveGroupCount;
    return Array.from({ length: effectiveGroupCount }, (_, i) => base + (i < extra ? 1 : 0));
  }, [count, effectiveGroupCount]);

  const qualifierCount = effectiveGroupCount * advancePerGroup;
  const resultingBracketSize = nextPow2(qualifierCount || 1);
  const scale = useViewportScale();
  const contentMaxWidth = scale.tier === "desktop" ? 640 : "none";

  // Sync plate players list when names change (for bracket mode)
  // Don't auto-manage for groups - plate is chosen at advance time
  const cleanNames = names.map((n, i) => n.trim() || `Player ${i + 1}`);

  const logoInputRef = useRef(null);
  const [logoError, setLogoError] = useState(null);
  const handleLogoFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) { setLogoError("Please choose an image file"); return; }
    try {
      // Cap to a responsible display size (400x200), preserving aspect ratio
      const dataUrl = await resizeImageFile(file, 400, 200);
      onSetLogo && onSetLogo(dataUrl);
      setLogoError(null);
    } catch (err) {
      setLogoError("Could not load that image");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, paddingBottom: 160 }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "20px 20px 14px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            {logoDataUrl ? (
              <div style={{ position: "relative" }}>
                <img src={logoDataUrl} alt="Tournament logo" style={{ display: "block", maxWidth: 400, maxHeight: 200, width: "auto", height: "auto", objectFit: "contain", borderRadius: 8 }} />
                <button onClick={() => onSetLogo && onSetLogo(null)} title="Remove logo"
                  style={{ position: "absolute", top: -8, right: -8, width: 24, height: 24, borderRadius: "50%", background: CARD2, border: `1px solid ${BORDER}`, color: MUTED, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>x</button>
              </div>
            ) : (
              <button onClick={() => logoInputRef.current && logoInputRef.current.click()}
                style={{ padding: "8px 16px", background: "transparent", border: `1px dashed ${BORDER}`, borderRadius: 10, color: MUTED, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                + Add Logo
              </button>
            )}
            <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoFile} style={{ display: "none" }} />
          </div>
          {logoError && <div style={{ textAlign: "center", fontSize: 11, color: RED, marginBottom: 8 }}>{logoError}</div>}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 12, fontFamily: MONO, color: GOLD, letterSpacing: "0.2em", marginBottom: 4 }}>TOURNAMENT BUILDER</div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.5px" }}>New Tournament</div>
            </div>
            <button onClick={onHistory} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10, color: TEXT, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, flexShrink: 0, marginBottom: 2 }}>
              History
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>

        {loadError && (
          <div style={{ margin: "16px 20px 0", padding: "12px 16px", background: `${RED}14`, border: `1px solid ${RED}55`, borderRadius: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: RED, marginBottom: 3 }}>Could not load saved tournament</div>
            <div style={{ fontSize: 12, color: MUTED }}>{loadError}</div>
          </div>
        )}

        {savedExists && (
          <div style={{ margin: "16px 20px 0", padding: "14px 16px", background: `${GOLD}14`, border: `1px solid ${GOLD}55`, borderRadius: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Resume saved tournament?</div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
              {savedAt ? `Last saved ${new Date(savedAt).toLocaleString()}` : "You have an in-progress tournament saved on this device."}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onResume} style={{ flex: 1, padding: "9px", background: GOLD, border: "none", borderRadius: 8, color: "#0D0F14", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Resume</button>
              <button onClick={onDiscard} style={{ flex: 1, padding: "9px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
            </div>
          </div>
        )}

        {!savedExists && !loadError && (
          <div style={{ margin: "16px 20px 0", padding: "10px 14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
            <div style={{ fontSize: 11, color: MUTED, fontFamily: MONO }}>No saved tournament found on this device yet.</div>
          </div>
        )}

        {/* Tournament name */}
        <div style={{ padding: "20px 20px 0" }}>
          <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 10, textTransform: "uppercase" }}>Tournament Name</div>
          <input
            value={tournamentName}
            onChange={e => setTournamentName(e.target.value)}
            placeholder={`e.g. Summer Smash ${new Date().getFullYear()}`}
            style={{ width: "100%", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 16px", color: TEXT, fontSize: 16, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
          />
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>Optional - the date will be used if left blank.</div>
        </div>

        {/* Mode toggle */}
        <div style={{ padding: "20px 20px 0" }}>
          <div style={{ display: "flex", gap: 8, background: CARD2, padding: 4, borderRadius: 12, border: `1px solid ${BORDER}` }}>
            {[{ k: "bracket", l: "Knockout Only" }, { k: "groups", l: "Groups + Knockout" }].map(({ k, l }) => (
              <button key={k} onClick={() => setMode(k)} style={{
                flex: 1, padding: "9px 0", borderRadius: 9, border: "none",
                background: mode === k ? GOLD : "transparent",
                color: mode === k ? "#0D0F14" : MUTED,
                fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit",
              }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ padding: "24px 20px 0" }}>

          {/* Scoring */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Scoring</div>
            <div onClick={() => setUseScoring(v => !v)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: CARD2, border: `1px solid ${useScoring ? GOLD + "66" : BORDER}`,
              borderRadius: 12, padding: "12px 14px", cursor: "pointer", marginBottom: 12,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>Track game scores</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>{useScoring ? "Tap +/- to enter scores" : "Just tap the winner"}</div>
              </div>
              <div style={{ width: 44, height: 26, borderRadius: 13, background: useScoring ? GOLD : BORDER, position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: 4, left: useScoring ? 22 : 4, width: 18, height: 18, borderRadius: 9, background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
            {useScoring && (
              <div style={{ display: "flex", gap: 8 }}>
                {[3, 5, 7].map(v => (
                  <button key={v} onClick={() => setBestOf(v)} style={{
                    flex: 1, padding: "10px 0", borderRadius: 10,
                    border: `1px solid ${bestOf === v ? GOLD : BORDER}`,
                    background: bestOf === v ? `${GOLD}22` : CARD2,
                    color: bestOf === v ? GOLD : MUTED,
                    fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit",
                  }}>Best of {v}</button>
                ))}
              </div>
            )}
          </div>

          {/* Elim format - knockout-only mode */}
          {mode === "bracket" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Format</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {[{ k: "single", l: "Single Elimination" }, { k: "double", l: "Double Elimination" }].map(({ k, l }) => (
                  <button key={k} onClick={() => setElimType(k)} style={{
                    flex: 1, padding: "10px 0", borderRadius: 10,
                    border: `1px solid ${elimType === k ? PURPLE : BORDER}`,
                    background: elimType === k ? `${PURPLE}22` : CARD2,
                    color: elimType === k ? PURPLE : MUTED,
                    fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
                  }}>{l}</button>
                ))}
              </div>
              {elimType === "double" && (
                <div onClick={() => setGrandFinalEnabled(v => !v)} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: CARD2, border: `1px solid ${grandFinalEnabled ? GOLD + "66" : BORDER}`,
                  borderRadius: 12, padding: "12px 14px", cursor: "pointer",
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>Grand Final</div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>{grandFinalEnabled ? "LB winner faces WB winner" : "WB winner is champion"}</div>
                  </div>
                  <div style={{ width: 44, height: 26, borderRadius: 13, background: grandFinalEnabled ? GOLD : BORDER, position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 4, left: grandFinalEnabled ? 22 : 4, width: 18, height: 18, borderRadius: 9, background: "#fff", transition: "left 0.2s" }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Plate tournament */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Plate Tournament</div>
            <div onClick={() => setPlateEnabled(v => !v)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: CARD2, border: `1px solid ${plateEnabled ? "#FB923C66" : BORDER}`,
              borderRadius: 12, padding: "12px 14px", cursor: "pointer",
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>Enable Plate</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
                  Single-elim bracket running alongside - add players once the tournament is underway.
                </div>
              </div>
              <div style={{ width: 44, height: 26, borderRadius: 13, background: plateEnabled ? "#FB923C" : BORDER, position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: 4, left: plateEnabled ? 22 : 4, width: 18, height: 18, borderRadius: 9, background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
          </div>

          {/* Group settings */}
          {mode === "groups" && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Groups</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <button onClick={() => { setGroupsTouched(true); setGroupCount(g => Math.max(1, Math.min(count, g - 1))); }} style={{
                  width: 44, height: 48, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                  color: TEXT, fontSize: 22, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                }}>-</button>
                <input
                  type="number"
                  min={1} max={count}
                  value={effectiveGroupCount}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) { setGroupsTouched(true); setGroupCount(Math.max(1, Math.min(count, v))); }
                  }}
                  onFocus={e => e.target.select()}
                  style={{
                    flex: 1, height: 48, textAlign: "center",
                    fontSize: 24, fontWeight: 700, color: PURPLE,
                    background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                    outline: "none", fontFamily: MONO,
                    MozAppearance: "textfield",
                  }}
                />
                <button onClick={() => { setGroupsTouched(true); setGroupCount(g => Math.max(1, Math.min(count, g + 1))); }} style={{
                  width: 44, height: 48, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                  color: TEXT, fontSize: 22, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                }}>+</button>
              </div>
              <div style={{ fontSize: 12, color: MUTED, textAlign: "center", fontFamily: MONO, marginBottom: 16 }}>
                Sizes: {groupSizes.join(", ")}
              </div>
              <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 10, textTransform: "uppercase" }}>Advance Per Group</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {[1, 2, 3, 4].map(v => (
                  <button key={v} onClick={() => setAdvancePerGroup(v)} style={{
                    flex: 1, padding: "10px 0", borderRadius: 10,
                    border: `1px solid ${advancePerGroup === v ? PURPLE : BORDER}`,
                    background: advancePerGroup === v ? `${PURPLE}22` : CARD2,
                    color: advancePerGroup === v ? PURPLE : MUTED,
                    fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit",
                  }}>Top {v}</button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: MUTED, textAlign: "center", fontFamily: MONO }}>
                {qualifierCount} qualifiers {"->"} {resultingBracketSize}-player bracket
              </div>
            </div>
          )}

          {/* Player count */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Number of Players</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => updateCount(count - 1)} style={{
                width: 44, height: 52, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                color: TEXT, fontSize: 24, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              }}>-</button>
              <input
                type="number"
                min={2} max={64}
                value={count}
                onChange={e => {
                  const raw = e.target.value;
                  const v = parseInt(raw, 10);
                  if (isNaN(v)) return;
                  // Only sanity-cap during typing (avoid runaway array growth from
                  // a stray extra digit); the real 2-64 clamp happens on blur.
                  // Clamping the true minimum here would corrupt multi-digit entry:
                  // typing "1" of "16" would jump to "2", then "6" appends to make "26".
                  const c = Math.max(0, Math.min(200, v));
                  setCount(c);
                  setNames(prev => {
                    const next = [...prev];
                    while (next.length < c) next.push("");
                    return next.slice(0, c);
                  });
                  if (!groupsTouched) setGroupCount(suggestGroupCount(c));
                }}
                onFocus={e => e.target.select()}
                onBlur={e => {
                  const v = parseInt(e.target.value, 10);
                  updateCount(isNaN(v) ? 8 : v);
                }}
                style={{
                  flex: 1, height: 52, textAlign: "center",
                  fontSize: 28, fontWeight: 700, color: GOLD,
                  background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                  outline: "none", fontFamily: MONO,
                  MozAppearance: "textfield",
                }}
              />
              <button onClick={() => updateCount(count + 1)} style={{
                width: 44, height: 52, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                color: TEXT, fontSize: 24, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              }}>+</button>
            </div>
            {mode === "bracket" && (
              <div style={{ marginTop: 10, fontSize: 12, color: perfect ? GREEN : MUTED, textAlign: "center", fontFamily: MONO }}>
                {perfect ? "Perfect bracket - no prelim needed" : (() => {
                  let mainSz = 1;
                  while (mainSz * 2 <= count) mainSz *= 2;
                  const ov = count - mainSz;
                  const prelims = Math.ceil(ov / 2);
                  return `Prelim round: ${prelims} match${prelims > 1 ? "es" : ""} -> ${mainSz}-player bracket`;
                })()}
              </div>
            )}
          </div>

          {/* Player names */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 11, fontFamily: FONT, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>Player Names</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {names.map((name, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: CARD2, border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: MONO, color: MUTED, flexShrink: 0 }}>{i + 1}</div>
                  <input
                    value={name}
                    onChange={e => { const n = [...names]; n[i] = e.target.value; setNames(n); }}
                    placeholder={`Player ${i + 1}`}
                    style={{ flex: 1, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 14px", color: TEXT, fontSize: 16, outline: "none", fontFamily: "inherit" }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 20px", background: `linear-gradient(to top, ${BG} 80%, ${BG}00)` }}>
        <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>
          <button
            onClick={() => {
              const names2 = cleanNames;
              if (mode === "bracket") {
                onGenerateBracket(names2, grandFinalEnabled, useScoring, bestOf, tournamentName.trim(), elimType, plateEnabled);
              } else {
                onGenerateGroups(names2, effectiveGroupCount, advancePerGroup, useScoring, bestOf, grandFinalEnabled, tournamentName.trim(), plateEnabled);
              }
            }}
            style={{ width: "100%", padding: scale.tier === "desktop" ? "18px" : "16px", background: GOLD, border: "none", borderRadius: 14, color: "#0D0F14", fontSize: scale.tier === "desktop" ? 18 : 16, fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em", fontFamily: "inherit" }}
          >
            {mode === "bracket" ? "Generate Bracket ->" : "Generate Groups ->"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// GROUP STAGE SCREEN
// ===========================================================================

function GroupStageScreen({ groupState, setGroupState, onBack, onAdvanceToBracket, saveStatus, saveError }) {
  const { groups, matchesByGroup, advancePerGroup, useScoring, bestOf, plateEnabled: groupPlateEnabled, tiebreakOverrides = {} } = groupState;
  const [activeGroup, setActiveGroup] = useState(0);
  const [showTieModal, setShowTieModal] = useState(false);
  const [tieModalGroup, setTieModalGroup] = useState(null);
  const [tieModalOrder, setTieModalOrder] = useState([]);
  const scale = useViewportScale();

  const handleScore = useCallback((groupIdx, matchId, who, delta) => {
    setGroupState(prev => {
      const list = [...prev.matchesByGroup[groupIdx]];
      const idx = list.findIndex(m => m.id === matchId);
      if (idx === -1) return prev;
      const m = list[idx];
      if (m.winner || m.isBye) return prev;
      const need = gamesToWin(m.bestOf || 3);
      let p1Games = m.p1Games || 0, p2Games = m.p2Games || 0;
      if (who === "p1") p1Games = Math.max(0, Math.min(need, p1Games + delta));
      else p2Games = Math.max(0, Math.min(need, p2Games + delta));
      let winner = null, loser = null;
      if (p1Games >= need) { winner = m.p1; loser = m.p2; }
      else if (p2Games >= need) { winner = m.p2; loser = m.p1; }
      list[idx] = { ...m, p1Games, p2Games, winner, loser };
      return { ...prev, matchesByGroup: { ...prev.matchesByGroup, [groupIdx]: list } };
    });
  }, [setGroupState]);

  const handlePick = useCallback((groupIdx, matchId, winner) => {
    setGroupState(prev => {
      const list = [...prev.matchesByGroup[groupIdx]];
      const idx = list.findIndex(m => m.id === matchId);
      if (idx === -1) return prev;
      const m = list[idx];
      const loser = winner === m.p1 ? m.p2 : m.p1;
      const need = gamesToWin(m.bestOf || 3);
      list[idx] = { ...m, winner, loser, p1Games: winner === m.p1 ? need : 0, p2Games: winner === m.p2 ? need : 0 };
      return { ...prev, matchesByGroup: { ...prev.matchesByGroup, [groupIdx]: list } };
    });
  }, [setGroupState]);

  const handleChangeWinner = useCallback((groupIdx, matchId, newWinner) => {
    setGroupState(prev => {
      const list = [...prev.matchesByGroup[groupIdx]];
      const idx = list.findIndex(m => m.id === matchId);
      if (idx === -1) return prev;
      const m = list[idx];
      const newLoser = newWinner === m.p1 ? m.p2 : m.p1;
      const need = gamesToWin(m.bestOf || 3);
      list[idx] = { ...m, winner: newWinner, loser: newLoser, p1Games: newWinner === m.p1 ? need : 0, p2Games: newWinner === m.p2 ? need : 0 };
      return { ...prev, matchesByGroup: { ...prev.matchesByGroup, [groupIdx]: list } };
    });
  }, [setGroupState]);

  const allStandings = groups.map((g, i) => computeStandings(g, matchesByGroup[i] || [], tiebreakOverrides[i] || []));
  const totalMatches = Object.values(matchesByGroup).flat().filter(m => !m.isBye).length;
  const doneMatches = Object.values(matchesByGroup).flat().filter(m => m.winner && !m.isBye).length;
  const allComplete = totalMatches > 0 && doneMatches === totalMatches;

  const qualifiers = allStandings.flatMap(s => s.slice(0, advancePerGroup).map(x => x.player));

  const handleTiebreakOverride = useCallback((groupIdx, orderedPlayers) => {
    setGroupState(prev => ({
      ...prev,
      tiebreakOverrides: { ...(prev.tiebreakOverrides || {}), [groupIdx]: orderedPlayers },
    }));
  }, [setGroupState]);

  const clearTieOverride = (groupIdx) => {
    setGroupState(prev => {
      const o = { ...(prev.tiebreakOverrides || {}) };
      delete o[groupIdx];
      return { ...prev, tiebreakOverrides: o };
    });
  };

  const openTieModal = (groupIdx) => {
    const standings = allStandings[groupIdx];
    const overrides = tiebreakOverrides[groupIdx] || [];
    const tiedSet = new Set();
    standings.forEach((s, i) => {
      standings.forEach((other, j) => {
        if (i === j) return;
        const same = s.ppg.toFixed(3) === other.ppg.toFixed(3) && s.gameDiff === other.gameDiff && s.gamesWon === other.gamesWon;
        const crosses = (i < advancePerGroup) !== (j < advancePerGroup);
        if (same && crosses) { tiedSet.add(s.player); tiedSet.add(other.player); }
      });
    });
    const tiedPlayers = [...tiedSet];
    setTieModalGroup(groupIdx);
    setTieModalOrder(overrides.length > 0 ? overrides : tiedPlayers);
    setShowTieModal(true);
  };

  const moveTiePlayer = (idx, dir) => {
    setTieModalOrder(prev => {
      const next = [...prev];
      const t = idx + dir;
      if (t < 0 || t >= next.length) return prev;
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });
  };

  const applyTieOverride = () => {
    if (tieModalGroup !== null) handleTiebreakOverride(tieModalGroup, tieModalOrder);
    setShowTieModal(false);
  };

  // Advance modal state
  const [showModal, setShowModal] = useState(false);
  const [platePlayers, setPlatePlayers] = useState([]);
  const allPlayers = groups.flat();

  const openModal = () => {
    setPlatePlayers([]);
    setShowModal(true);
  };

  const doAdvance = () => {
    onAdvanceToBracket({ qualifiers, plateEnabled: groupPlateEnabled });
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "14px 16px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "6px 12px", cursor: "pointer", fontSize: 15, fontFamily: "inherit", flexShrink: 0 }}>Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontFamily: MONO, color: PURPLE, letterSpacing: "0.06em", textTransform: "uppercase" }}>Group Stage</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{groups.length} groups - {doneMatches}/{totalMatches} matches</div>
          </div>
        </div>
        <div style={{ marginTop: 10, height: 3, background: BORDER, borderRadius: 2 }}>
          <div style={{ height: "100%", borderRadius: 2, background: PURPLE, width: `${totalMatches ? (doneMatches / totalMatches) * 100 : 0}%`, transition: "width 0.3s" }} />
        </div>
        <div style={{ marginTop: 6 }}><SaveBadge status={saveStatus} error={saveError} /></div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto" }}>
          {groups.map((g, i) => (
            <button key={i} onClick={() => setActiveGroup(i)} style={{
              flex: "0 0 auto", padding: "6px 14px",
              background: activeGroup === i ? `${PURPLE}22` : "transparent",
              border: `1px solid ${activeGroup === i ? PURPLE : BORDER}`,
              borderRadius: 8, color: activeGroup === i ? PURPLE : MUTED,
              fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: MONO,
            }}>GROUP {String.fromCharCode(65 + i)}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px 140px", maxWidth: scale.tier === "desktop" ? 760 : "none", margin: "0 auto" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
          Group {String.fromCharCode(65 + activeGroup)} Standings
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "visible", marginBottom: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 52px 60px 64px", padding: "8px 14px", fontSize: 11, color: MUTED, fontFamily: FONT, fontWeight: 600, borderBottom: `1px solid ${BORDER}`, letterSpacing: "0.03em" }}>
            <div>#</div><div>Player</div>
            <Tooltip label={"Wins - Losses\n\nNumber of matches won and lost in this group."}><span style={{ borderBottom: `1px dashed ${MUTED}`, cursor: "help" }}>W-L</span></Tooltip>
            <Tooltip label={"Points Per Game\n\nGames won divided by total games played.\nRange: 0.00 to 1.00"}><span style={{ borderBottom: `1px dashed ${MUTED}`, cursor: "help" }}>PPG</span></Tooltip>
            <Tooltip label={"Game Differential\n\nGames won minus games lost across all matches.\nUsed as tiebreaker after PPG."}><span style={{ borderBottom: `1px dashed ${MUTED}`, cursor: "help" }}>+/-GMS</span></Tooltip>
          </div>
          {allStandings[activeGroup].map((s, i) => {
            const isTied = allStandings[activeGroup].some((o, j) => {
              if (i === j) return false;
              const same = s.ppg.toFixed(3) === o.ppg.toFixed(3) && s.gameDiff === o.gameDiff && s.gamesWon === o.gamesWon;
              return same && (i < advancePerGroup) !== (j < advancePerGroup);
            });
            return (
              <div key={s.player} style={{
                display: "grid", gridTemplateColumns: "28px 1fr 52px 60px 64px",
                padding: "11px 14px", fontSize: 15,
                background: i < advancePerGroup ? `${GREEN}11` : "transparent",
                borderBottom: i < allStandings[activeGroup].length - 1 ? `1px solid ${BORDER}` : "none",
                outline: isTied ? `2px solid ${GOLD}88` : "none", outlineOffset: -2,
              }}>
                <div style={{ color: i < advancePerGroup ? GREEN : MUTED, fontWeight: 700 }}>{i + 1}</div>
                <div style={{ fontWeight: i < advancePerGroup ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.player}
                  {isTied && <span style={{ fontSize: 11, color: GOLD, marginLeft: 6 }}>TIE</span>}
                </div>
                <div style={{ color: MUTED, fontFamily: MONO, fontSize: 13 }}>{s.wins}-{s.losses}</div>
                <div style={{ color: MUTED, fontFamily: MONO, fontSize: 13 }}>{s.ppg.toFixed(2)}</div>
                <div style={{ color: s.gameDiff > 0 ? GREEN : s.gameDiff < 0 ? RED : MUTED, fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{s.gameDiff > 0 ? "+" : ""}{s.gameDiff}</div>
              </div>
            );
          })}
          {(() => {
            const hasTie = allStandings[activeGroup].some((s, i) => allStandings[activeGroup].some((o, j) => {
              if (i === j) return false;
              const same = s.ppg.toFixed(3) === o.ppg.toFixed(3) && s.gameDiff === o.gameDiff && s.gamesWon === o.gamesWon;
              return same && (i < advancePerGroup) !== (j < advancePerGroup);
            }));
            if (!hasTie) return null;
            const hasOverride = (tiebreakOverrides[activeGroup] || []).length > 0;
            return (
              <div style={{ padding: "12px 14px", background: `${GOLD}14`, borderTop: `1px solid ${GOLD}44` }}>
                <div style={{ fontSize: 13, color: GOLD, fontWeight: 600, marginBottom: 6 }}>Tie at the qualification boundary</div>
                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, marginBottom: 10 }}>
                  Players marked TIE are equal on all tiebreakers. Use the button below to set the order manually, or play a playoff match and enter the result above.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => openTieModal(activeGroup)} style={{ flex: 1, padding: "9px 0", background: `${GOLD}22`, border: `1px solid ${GOLD}`, borderRadius: 8, color: GOLD, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Set Order Manually</button>
                  {hasOverride && <button onClick={() => clearTieOverride(activeGroup)} style={{ padding: "9px 14px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Reset</button>}
                </div>
              </div>
            );
          })()}
        </div>
        <div style={{ marginBottom: 20, padding: "10px 14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, marginBottom: 8 }}>How standings are ranked</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {[
              ["1. PPG", "Points per game - games won divided by total games played"],
              ["2. +/-GMS", "Game differential - games won minus games lost"],
              ["3. Games won", "Total games won across all matches"],
              ["4. Alphabetical", "Last resort - use Set Order Manually to override"],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <span style={{ color: TEXT, fontWeight: 600, flexShrink: 0, minWidth: 90 }}>{label}</span>
                <span style={{ color: MUTED }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Matches</div>        <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Matches</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(matchesByGroup[activeGroup] || []).map(m => {
            const shim = { [m.id]: { ...m, matchNum: m.id.replace("rr", ""), winnerGoesToMatchId: null, loserGoesToMatchId: null, p1FromMatchId: null, p2FromMatchId: null } };
            return (
              <div key={m.id}>
                <MatchCard matchId={m.id} matchMap={shim}
                  onPickWinner={(id, w) => handlePick(activeGroup, id, w)}
                  onChangeWinner={(id, w) => handleChangeWinner(activeGroup, id, w)}
                  onScore={(id, who, delta) => handleScore(activeGroup, id, who, delta)}
                  isLosers={false} isGrandFinal={false} useScoring={useScoring}
                  scale={{ ...scale, cardWidth: "100%" }} />
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 20px", background: `linear-gradient(to top, ${BG} 85%, ${BG}00)` }}>
        <button disabled={!allComplete} onClick={openModal} style={{
          width: "100%", padding: "16px", background: allComplete ? GOLD : CARD2,
          border: allComplete ? "none" : `1px solid ${BORDER}`, borderRadius: 14,
          color: allComplete ? "#0D0F14" : MUTED, fontSize: 17, fontWeight: 700,
          cursor: allComplete ? "pointer" : "not-allowed", fontFamily: "inherit",
        }}>
          {allComplete ? `Advance ${qualifiers.length} Qualifiers to Bracket ->` : `Finish all matches first (${doneMatches}/${totalMatches})`}
        </button>
      </div>

      {/* Advance modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 200, display: "flex", alignItems: "flex-end" }}>
          <div style={{ background: CARD, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 20px 40px", width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Knockout Stage</div>
            <div style={{ fontSize: 14, color: MUTED, marginBottom: 20 }}>These {qualifiers.length} players advance to the bracket.</div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 24 }}>
              {qualifiers.map(p => <span key={p} style={{ fontSize: 13, padding: "4px 10px", background: `${GREEN}22`, border: `1px solid ${GREEN}44`, borderRadius: 8, color: GREEN, fontWeight: 600 }}>{p}</span>)}
            </div>

            {groupPlateEnabled && (
              <div style={{ padding: "12px 14px", background: `#FB923C11`, border: `1px solid #FB923C44`, borderRadius: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#FB923C", fontWeight: 600 }}>Plate enabled</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>You can add plate players from the bracket screen once the tournament is underway.</div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: "14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button onClick={doAdvance} style={{ flex: 2, padding: "14px", background: GOLD, border: "none", borderRadius: 12, color: "#0D0F14", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Generate Brackets {"->"}</button>
            </div>
          </div>
        </div>
      )}

      {showTieModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 200, display: "flex", alignItems: "flex-end" }}>
          <div style={{ background: CARD, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 20px 40px", width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              Resolve Tie - Group {String.fromCharCode(65 + (tieModalGroup || 0))}
            </div>
            <div style={{ fontSize: 14, color: MUTED, marginBottom: 20, lineHeight: 1.5 }}>
              These players are equal on all stats. Use the arrows to reorder them. Players higher up will rank higher in the standings.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
              {tieModalOrder.map((player, idx) => {
                const standings = allStandings[tieModalGroup || 0];
                const tiedSet = new Set(tieModalOrder);
                const nonTiedQ = standings.filter((s, i) => i < advancePerGroup && !tiedSet.has(s.player)).length;
                const slotsForTied = advancePerGroup - nonTiedQ;
                const willQualify = idx < slotsForTied;
                return (
                  <div key={player} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, background: willQualify ? `${GREEN}18` : CARD2, border: `1px solid ${willQualify ? GREEN + "55" : BORDER}` }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{player}</div>
                      <div style={{ fontSize: 12, color: willQualify ? GREEN : MUTED, marginTop: 2 }}>{willQualify ? "Qualifies" : "Does not qualify"}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <button onClick={() => moveTiePlayer(idx, -1)} disabled={idx === 0}
                        style={{ width: 36, height: 30, borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD2, color: idx === 0 ? BORDER : TEXT, fontSize: 14, cursor: idx === 0 ? "default" : "pointer", fontFamily: "inherit" }}>up</button>
                      <button onClick={() => moveTiePlayer(idx, 1)} disabled={idx === tieModalOrder.length - 1}
                        style={{ width: 36, height: 30, borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD2, color: idx === tieModalOrder.length - 1 ? BORDER : TEXT, fontSize: 14, cursor: idx === tieModalOrder.length - 1 ? "default" : "pointer", fontFamily: "inherit" }}>dn</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>This only affects the order of tied players.</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowTieModal(false)} style={{ flex: 1, padding: "14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button onClick={applyTieOverride} style={{ flex: 2, padding: "14px", background: GOLD, border: "none", borderRadius: 12, color: "#0D0F14", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Apply Order</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// BRACKET SCREEN
// ===========================================================================

function BracketScreen({ bracketData, setMatchMap, plateData, setPlateMatchMap, plateEnabled, onBuildPlate, players, onBack, grandFinalEnabled, useScoring, isSingleElim, saveStatus, saveError, closedBrackets, setClosedBrackets, onAllBracketsClosed }) {
  const { matchMap, winnersRounds, losersRounds, grandFinalId, prelimRound } = bracketData;
  const allWbRounds = prelimRound ? [prelimRound, ...winnersRounds] : winnersRounds;
  const scale = useViewportScale();

  // Plate management modal state
  const [showPlateModal, setShowPlateModal] = useState(false);
  const [plateInputs, setPlateInputs] = useState(() =>
    plateData ? (plateData.rounds || []).flat().map(id => plateData.matchMap[id]).filter(m => m.p1 && m.p1 !== "BYE").map(m => m.p1) : ["", ""]
  );

  const openPlateModal = () => {
    // Pre-fill from existing plate if any, else start with 2 empty fields
    if (plateData) {
      const existing = Object.values(plateData.matchMap).filter(m => !m.isBye && m.p1 && m.p1 !== "BYE").map(m => [m.p1, m.p2]).flat().filter((v, i, a) => v && v !== "BYE" && a.indexOf(v) === i);
      setPlateInputs(existing.length >= 2 ? existing : ["", ""]);
    } else {
      setPlateInputs(["", ""]);
    }
    setShowPlateModal(true);
  };

  const addPlateSlot = () => setPlateInputs(p => [...p, ""]);
  const removePlateSlot = (i) => setPlateInputs(p => p.filter((_, idx) => idx !== i));

  const generatePlate = () => {
    const valid = plateInputs.map(n => n.trim()).filter(Boolean);
    if (valid.length < 2) return;
    onBuildPlate(valid);
    setShowPlateModal(false);
  };

  const handlePick = useCallback((matchId, winner) => {
    setMatchMap(prev => recordWinner(prev, matchId, winner));
  }, [setMatchMap]);
  const handleChangeWinner = useCallback((matchId, newWinner) => {
    setMatchMap(prev => changeWinner(prev, matchId, newWinner));
  }, [setMatchMap]);
  const handleScore = useCallback((matchId, who, delta) => {
    setMatchMap(prev => applyScoreChange(prev, matchId, who, delta));
  }, [setMatchMap]);

  const wbTotal = Object.values(matchMap).filter(m => !m.isBye).length;
  const wbDone  = Object.values(matchMap).filter(m => m.winner && !m.isBye).length;
  const plTotal = plateData ? Object.values(plateData.matchMap).filter(m => !m.isBye).length : 0;
  const plDone  = plateData ? Object.values(plateData.matchMap).filter(m => m.winner && !m.isBye).length : 0;
  const totalMatches = wbTotal + plTotal;
  const doneCount = wbDone + plDone;

  const wbFinalId = winnersRounds[winnersRounds.length - 1][0];
  const champion = isSingleElim
    ? (matchMap[wbFinalId] && matchMap[wbFinalId].winner)
    : (grandFinalEnabled ? (matchMap[grandFinalId] && matchMap[grandFinalId].winner) : (matchMap[wbFinalId] && matchMap[wbFinalId].winner));

  const ORANGE = "#FB923C";
  const [activeTab, setActiveTab] = useState("wb-0");
  const [showCloseOut, setShowCloseOut] = useState(false);
  const [editingMatchId, setEditingMatchId] = useState(null);
  const bracketScrollRef = useRef(null);

  // Measure the real rendered height of a match card so the bracket
  // alignment/connector math lines up pixel-for-pixel, rather than guessing.
  const [cardHeight, setCardHeight] = useState(
    scale.tier === "desktop" ? 172 : scale.tier === "tablet" ? 156 : 144
  );
  useEffect(() => {
    const el = document.querySelector('[data-bracket-card="true"]');
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setCardHeight(h);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale.tier, useScoring]);

  // On mount, ensure scroll starts at top-left
  useEffect(() => {
    if (bracketScrollRef.current) {
      bracketScrollRef.current.scrollTop = 0;
      bracketScrollRef.current.scrollLeft = 0;
    }
  }, []);
  // closedBrackets now passed in as a prop from App so it can be persisted/resumed

  // Derive current section from activeTab key prefix
  const activeSection = activeTab.startsWith("wb") ? "wb"
    : activeTab === "gf" ? "gf"
    : activeTab.startsWith("lb") ? "lb"
    : activeTab.startsWith("plate") ? "plate"
    : "wb";

  const plateChampionCheck = plateData ? (plateData.matchMap[plateData.finalId] && plateData.matchMap[plateData.finalId].winner) : null;
  const plateInProgress = plateData && !plateChampionCheck;
  const plateComplete = plateData && !!plateChampionCheck;

  const currentTabClosed = closedBrackets[activeSection] || false;

  const lbChampion = !isSingleElim && losersRounds.length > 0
    ? (matchMap[losersRounds[losersRounds.length - 1][0]] && matchMap[losersRounds[losersRounds.length - 1][0]].winner)
    : null;
  const lbComplete = !isSingleElim && !!lbChampion;
  const lbInProgress = !isSingleElim && losersRounds.length > 0 && !lbChampion;
  const wbInProgress = !champion;

  const currentTabChampion = (() => {
    if (activeSection === "wb" || activeSection === "gf") return champion;
    if (activeSection === "lb") return lbChampion;
    if (activeSection === "plate") return plateChampionCheck;
    return null;
  })();
  // "Settled" means this bracket either doesn't apply, or has been explicitly
  // closed by the user - NOT simply "no champion yet". This is what fixes the
  // bug where an in-progress WB (no champion yet) was mistaken for a
  // non-existent one when closing out LB/Plate.
  const lbApplicable = !isSingleElim && losersRounds.length > 0 && !grandFinalEnabled;
  const plateApplicable = !!plateData;
  const wbSettled = !!closedBrackets.wb;
  const lbSettled = !lbApplicable || !!closedBrackets.lb;
  const plateSettled = !plateApplicable || !!closedBrackets.plate;

  const isLastBracket = (() => {
    const closingWb = activeSection === "wb" || activeSection === "gf";
    const closingLb = activeSection === "lb";
    const closingPlate = activeSection === "plate";
    // Closing WB: still have LB or plate unsettled (in progress or awaiting close)?
    if (closingWb) return lbSettled && plateSettled;
    // Closing LB: still have WB or plate unsettled?
    if (closingLb) return wbSettled && plateSettled;
    // Closing plate: last only if WB and LB are both already settled
    if (closingPlate) return wbSettled && lbSettled;
    return true;
  })();

  const handleCloseOut = () => {
    setClosedBrackets(prev => ({ ...prev, [activeSection]: true }));
    setShowCloseOut(true);
  };

  const handleFinalDismiss = () => {
    setShowCloseOut(false);
    if (onAllBracketsClosed) onAllBracketsClosed();
    onBack();
  };

  const handleCloseOutDismiss = () => {
    setShowCloseOut(false);
    // Navigate to the next bracket that still needs attention (in progress or awaiting close)
    if (activeSection === "plate") {
      if (!wbSettled) setActiveTab("wb-0");
      else if (!lbSettled) setActiveTab("lb-0");
    } else if (activeSection === "wb" || activeSection === "gf") {
      if (!lbSettled) setActiveTab("lb-0");
      else if (!plateSettled) setActiveTab("plate-0");
    } else if (activeSection === "lb") {
      if (!wbSettled) setActiveTab("wb-0");
      else if (!plateSettled) setActiveTab("plate-0");
    }
  };

  const wbLabel = (i, total) => {
    if (prelimRound && i === 0) return "Prelim";
    const adj = prelimRound ? i - 1 : i;
    if (i === total - 1) return isSingleElim ? "Final" : "WB Final";
    if (i === total - 2) return isSingleElim ? "Semi-Final" : "WB Semi";
    if (i === total - 3) return isSingleElim ? "Quarter-Final" : "WB Quarter";
    return adj === 0 ? "Round 1" : `Round ${adj + 1}`;
  };

  const lbLabel = (i) => {
    if (i === losersRounds.length - 1) return "LB Final";
    const hasPrelim = losersRounds.length > 0 && losersRounds[0].some(id => matchMap[id].isLBPrelim);
    if (hasPrelim) { if (i === 0) return "LB Prelim"; return i === 1 ? "LB Round 1" : `LB Round ${i}`; }
    return i === 0 ? "LB Round 1" : `LB Round ${i + 1}`;
  };

  // WB round-by-round gap/offset layout, driven by whichever WB round is
  // currently active. GF is NOT part of this array - it's a straight 1:1
  // feed from the WB final, so its position is derived separately below
  // (matching the WB final's own offset exactly, not the pair-midpoint math).
  const gutterWidth = scale.tier === "desktop" ? 40 : 28;
  const wbActiveIndex = activeSection === "wb" ? parseInt(activeTab.split("-")[1], 10) : -1;
  // A prelim round can make the sequence 1 -> 8 -> 4 -> 2 -> 1 (for
  // example, a 15-player tournament), rather than a simple binary tree.
  // Use the same count-aware layout as LB/Plate so the prelim is an entry
  // feed, not a spacing multiplier for every Winners round that follows.
  const wbLayout = computeTopologyLayout(allWbRounds, wbActiveIndex, cardHeight);
  // GF's card must line up with the WB final (single match, 1:1), so it
  // simply inherits the WB final round's own top offset.
  const gfOffset = wbLayout.offsets[allWbRounds.length - 1] || 0;

  // Plate round-by-round layout (independent bracket, own active state)
  const plateRoundsArr = plateData ? (plateData.rounds || []) : [];
  const plateActiveIndex = activeSection === "plate" ? parseInt(activeTab.split("-")[1], 10) : -1;
  const plateLayout = computeTopologyLayout(plateRoundsArr, plateActiveIndex, cardHeight);

  // LB round-by-round layout (independent bracket, own active state). LB
  // round sizes don't always halve cleanly (some rounds merge in WB losers
  // without eliminating anyone), so connector lines only draw where the
  // ratio between adjacent rounds is a clean 2:1 or 1:1 - see BracketConnectors.
  const lbActiveIndex = activeSection === "lb" ? parseInt(activeTab.split("-")[1], 10) : -1;
  const lbLayout = computeTopologyLayout(losersRounds, lbActiveIndex, cardHeight);

  // Pill nav: one button per WB round + GF + LB + Plate
  const roundTabs = [
    ...allWbRounds.map((_, i) => ({
      key: `wb-${i}`,
      colId: `round-col-wb-${i}`,
      label: wbLabel(i, allWbRounds.length),
      color: PURPLE,
      section: "wb",
    })),
    ...(!isSingleElim && grandFinalEnabled ? [{
      key: "gf",
      colId: "round-col-gf-0",
      label: "Grand Final",
      color: GOLD,
      section: "gf",
    }] : []),
    ...(!isSingleElim && losersRounds.length > 0 ? losersRounds.map((_, i) => ({
      key: `lb-${i}`,
      colId: `round-col-lb-${i}`,
      label: lbLabel(i),
      color: BLUE,
      section: "lb",
    })) : []),
    ...(plateData ? (plateData.rounds || []).map((_, i) => {
      const pr = plateData.rounds || [];
      const isLast = i === pr.length - 1;
      const label = isLast ? "Plate Final" : i === pr.length - 2 ? "Semi Final" : i === pr.length - 3 ? "Qtr Final" : `Plate Rd ${i + 1}`;
      return {
        key: `plate-${i}`,
        colId: `round-col-plate-${i}`,
        label,
        color: "#FB923C",
        section: "plate",
      };
    }) : []),
  ];

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "14px 16px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "6px 12px", cursor: "pointer", fontSize: 15, fontFamily: "inherit", flexShrink: 0 }}>Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontFamily: MONO, color: GOLD, letterSpacing: "0.06em", textTransform: "uppercase" }}>{isSingleElim ? "Single Elimination" : "Double Elimination"}</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{players.length} Players - {doneCount}/{totalMatches} matches</div>
          </div>
          {champion && (
            <div style={{ flexShrink: 0, textAlign: "right" }}>
              <div style={{ fontSize: 10, fontFamily: MONO, color: GOLD, letterSpacing: "0.1em" }}>CHAMPION</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{champion}</div>
            </div>
          )}
        </div>
        <div style={{ marginTop: 10, height: 3, background: BORDER, borderRadius: 2 }}>
          <div style={{ height: "100%", borderRadius: 2, background: GOLD, width: `${totalMatches ? (doneCount / totalMatches) * 100 : 0}%`, transition: "width 0.3s" }} />
        </div>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SaveBadge status={saveStatus} error={saveError} />
          {plateEnabled && (
            <button onClick={openPlateModal} style={{
              background: plateData ? "#FB923C22" : CARD2,
              border: `1px solid ${plateData ? "#FB923C" : BORDER}`,
              borderRadius: 8, color: plateData ? "#FB923C" : MUTED,
              fontSize: 12, fontWeight: 600, padding: "5px 12px",
              cursor: "pointer", fontFamily: "inherit",
            }}>
              {plateData ? "Manage Plate" : "Set Up Plate"}
            </button>
          )}
        </div>
        {/* Section pills: Winners / Losers / Plate */}
        <div style={{ display: "flex", gap: 8, marginTop: 12, marginBottom: 8 }}>
          {[
            { key: "wb", label: isSingleElim ? "Bracket" : "Winners", color: PURPLE, colId: "round-col-wb-0" },
            ...(!isSingleElim && losersRounds.length > 0 ? [{ key: "lb", label: "Losers", color: BLUE, colId: "round-col-lb-0" }] : []),
            ...(plateData ? [{ key: "plate", label: "Plate", color: "#FB923C", colId: "round-col-plate-0" }] : []),
          ].map(({ key, label, color, colId }) => {
            const isActive = activeSection === key;
            return (
              <button key={key} onClick={() => {
                setActiveTab(key === "lb" ? "lb-0" : key === "plate" ? "plate-0" : "wb-0");
                setTimeout(() => {
                  const col = document.getElementById(colId);
                  const container = bracketScrollRef.current;
                  if (col && container) {
                    const colLeft = col.getBoundingClientRect().left;
                    const containerLeft = container.getBoundingClientRect().left;
                    const target = container.scrollLeft + colLeft - containerLeft - 16;
                    container.scrollTo({ left: target, top: 0, behavior: "smooth" });
                    window.scrollTo({ top: container.getBoundingClientRect().top + window.scrollY - 100, behavior: "smooth" });
                  }
                }, 30);
              }} style={{
                padding: "8px 18px",
                background: isActive ? color : CARD,
                border: `2px solid ${isActive ? color : BORDER}`,
                borderRadius: 20,
                color: isActive ? "#fff" : MUTED,
                fontSize: 13, fontWeight: isActive ? 700 : 500,
                cursor: "pointer", fontFamily: "inherit",
                whiteSpace: "nowrap", transition: "all 0.15s ease",
              }}>{label}</button>
            );
          })}
        </div>

        {/* Round pills for current section */}
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
          {roundTabs.filter(t => t.section === activeSection || (activeSection === "wb" && t.section === "gf")).map(({ key, colId, label, color }) => {
            const isActive = activeTab === key;
            return (
              <button key={key} onClick={() => {
                setActiveTab(key);
                setTimeout(() => {
                  const col = document.getElementById(colId);
                  const container = bracketScrollRef.current;
                  if (col && container) {
                    const colLeft = col.getBoundingClientRect().left;
                    const containerLeft = container.getBoundingClientRect().left;
                    const target = container.scrollLeft + colLeft - containerLeft - 16;
                    container.scrollTo({ left: target, top: 0, behavior: "smooth" });
                    window.scrollTo({ top: container.getBoundingClientRect().top + window.scrollY - 100, behavior: "smooth" });
                  }
                }, 30);
              }} style={{
                flex: "0 0 auto", padding: "6px 14px",
                background: isActive ? TEXT : "transparent",
                border: `1.5px solid ${isActive ? TEXT : BORDER}`,
                borderRadius: 16,
                color: isActive ? BG : MUTED,
                fontSize: 12, fontWeight: isActive ? 700 : 400,
                cursor: "pointer", fontFamily: "inherit",
                whiteSpace: "nowrap", transition: "all 0.15s ease",
              }}>{label}</button>
            );
          })}
        </div>
      </div>

      {/* Plate management modal */}
      {showPlateModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 200, display: "flex", alignItems: "flex-end" }}>
          <div style={{ background: CARD, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 20px 40px", width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Plate Tournament</div>
            <div style={{ fontSize: 14, color: MUTED, marginBottom: 20 }}>Enter the names of players in the plate.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              {plateInputs.map((val, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ width: 26, height: 26, borderRadius: 6, background: CARD2, border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: MUTED, flexShrink: 0, fontFamily: MONO }}>{i + 1}</div>
                  <input value={val} onChange={e => setPlateInputs(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                    placeholder={`Player ${i + 1}`}
                    style={{ flex: 1, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 14px", color: TEXT, fontSize: 15, outline: "none", fontFamily: "inherit" }} />
                  {plateInputs.length > 2 && (
                    <button onClick={() => removePlateSlot(i)} style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${BORDER}`, background: CARD2, color: MUTED, fontSize: 16, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>x</button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addPlateSlot} style={{ width: "100%", padding: "10px", background: "transparent", border: `1px dashed ${BORDER}`, borderRadius: 10, color: MUTED, fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginBottom: 20 }}>+ Add Player</button>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>{plateInputs.filter(n => n.trim()).length} players{plateData ? " - this will replace the existing plate bracket." : ""}</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowPlateModal(false)} style={{ flex: 1, padding: "14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button onClick={generatePlate} disabled={plateInputs.filter(n => n.trim()).length < 2}
                style={{ flex: 2, padding: "14px", background: plateInputs.filter(n => n.trim()).length >= 2 ? "#FB923C" : CARD2, border: "none", borderRadius: 12, color: plateInputs.filter(n => n.trim()).length >= 2 ? "#0D0F14" : MUTED, fontSize: 15, fontWeight: 700, cursor: plateInputs.filter(n => n.trim()).length >= 2 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                {plateData ? "Regenerate Plate" : "Generate Plate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* All rounds in ONE continuous horizontal scroll.
          Tab nav scrolls to the relevant column via id anchors.
          WB, LB, Plate are all visible - separated by dividers. */}
      <div ref={bracketScrollRef} style={{ overflowX: "auto", overflowY: "auto", padding: "24px 0 140px", WebkitOverflowScrolling: "touch" }}>
        <div style={{ display: "inline-flex", gap: 0, alignItems: "flex-start", padding: "0 16px", minWidth: "max-content" }}>

          {/* Winners Bracket / Single-elim rounds */}
          {allWbRounds.map((round, i) => {
            const isActive = activeTab === `wb-${i}`;
            const isLastWbRound = i === allWbRounds.length - 1;
            const nextCount = isLastWbRound
              ? (!isSingleElim && grandFinalEnabled ? 1 : 0)
              : allWbRounds[i + 1].length;
            return (
              <Fragment key={`wb-frag-${i}`}>
                <div id={`round-col-wb-${i}`} style={{ flexShrink: 0, paddingRight: nextCount > 0 ? 0 : (scale.tier === "desktop" ? 40 : 28) }}>
                  <RoundCol
                    title={wbLabel(i, allWbRounds.length)}
                    matchIds={round} matchMap={matchMap}
                    onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore}
                    isLosers={false} useScoring={useScoring} scale={scale}
                    editingMatchId={editingMatchId} setEditingMatchId={setEditingMatchId} readOnly={closedBrackets.wb}
                    isActive={isActive}
                    spacing={wbLayout.gaps[i]}
                    offset={wbLayout.offsets[i]}
                  />
                </div>
                {nextCount > 0 && (
                  <div style={{ flexShrink: 0, width: gutterWidth, paddingTop: BRACKET_TITLE_BLOCK_HEIGHT }}>
                    <BracketConnectors
                      feederRound={round} targetRound={isLastWbRound ? [grandFinalId] : allWbRounds[i + 1]}
                      matchMap={matchMap}
                      feederOffset={wbLayout.offsets[i]} feederGap={wbLayout.gaps[i]}
                      targetOffset={isLastWbRound ? gfOffset : wbLayout.offsets[i + 1]}
                      targetGap={isLastWbRound ? 0 : wbLayout.gaps[i + 1]}
                      cardHeight={cardHeight} gutterWidth={gutterWidth} color={isLastWbRound ? GOLD : PURPLE}
                      hide={!!prelimRound && i === 0}
                    />
                  </div>
                )}
              </Fragment>
            );
          })}

          {/* Grand Final column (double-elim only) */}
          {!isSingleElim && grandFinalEnabled && (
            <div id="round-col-gf-0" style={{ flexShrink: 0, paddingRight: scale.tier === "desktop" ? 40 : 28 }}>
              <div style={{ fontSize: 11, color: GOLD, letterSpacing: "0.08em", fontWeight: 700, marginBottom: 12, textTransform: "uppercase" }}>Grand Final</div>
              <div style={{ paddingTop: gfOffset, transition: "padding-top 0.35s cubic-bezier(0.4, 0, 0.2, 1)" }}>
                <div data-bracket-card="true">
                  <MatchCard matchId={grandFinalId} matchMap={matchMap}
                    onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore}
                    isLosers={false} isGrandFinal={true} useScoring={useScoring} scale={scale}
                    editingMatchId={editingMatchId} setEditingMatchId={setEditingMatchId} readOnly={closedBrackets.wb} />
                </div>
                {champion && (
                  <div style={{ marginTop: 20, padding: 16, background: `${GOLD}14`, border: `1px solid ${GOLD}55`, borderRadius: 12, textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontFamily: MONO, color: GOLD, letterSpacing: "0.1em", marginBottom: 6 }}>CHAMPION</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>{champion}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Single-elim champion card */}
          {isSingleElim && champion && (
            <div style={{ flexShrink: 0, paddingRight: scale.tier === "desktop" ? 40 : 28, paddingTop: 24 }}>
              <div style={{ padding: 20, background: `${GOLD}14`, border: `1px solid ${GOLD}55`, borderRadius: 12, textAlign: "center", minWidth: 180 }}>
                <div style={{ fontSize: 11, fontFamily: MONO, color: GOLD, letterSpacing: "0.1em", marginBottom: 8 }}>CHAMPION</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>{champion}</div>
              </div>
            </div>
          )}

          {/* No-GF double-elim champion */}
          {!grandFinalEnabled && !isSingleElim && champion && (
            <div style={{ flexShrink: 0, paddingRight: scale.tier === "desktop" ? 40 : 28, paddingTop: 24 }}>
              <div style={{ padding: 20, background: `${GOLD}14`, border: `1px solid ${GOLD}55`, borderRadius: 12, textAlign: "center", minWidth: 180 }}>
                <div style={{ fontSize: 11, fontFamily: MONO, color: GOLD, letterSpacing: "0.1em", marginBottom: 8 }}>CHAMPION</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>{champion}</div>
              </div>
            </div>
          )}

          {/* Losers Bracket (double-elim only) - separated by a divider */}
          {!isSingleElim && losersRounds.length > 0 && (
            <>
              <div style={{ flexShrink: 0, width: 2, alignSelf: "stretch", background: BORDER, marginRight: scale.tier === "desktop" ? 40 : 28 }} />
              {losersRounds.map((round, i) => {
                const isActive = activeTab === `lb-${i}`;
                const isLastLbRound = i === losersRounds.length - 1;
                const nextCount = isLastLbRound ? 0 : losersRounds[i + 1].length;
                return (
                  <Fragment key={`lb-frag-${i}`}>
                    <div id={`round-col-lb-${i}`} style={{ flexShrink: 0, paddingRight: nextCount > 0 ? 0 : (scale.tier === "desktop" ? 40 : 28) }}>
                      <RoundCol
                        title={lbLabel(i)} matchIds={round} matchMap={matchMap}
                        onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore}
                        isLosers={true} useScoring={useScoring} scale={scale}
                        editingMatchId={editingMatchId} setEditingMatchId={setEditingMatchId} readOnly={closedBrackets.lb}
                        isActive={isActive}
                        spacing={lbLayout.gaps[i]}
                        offset={lbLayout.offsets[i]}
                      />
                    </div>
                    {nextCount > 0 && (
                      <div style={{ flexShrink: 0, width: gutterWidth, paddingTop: BRACKET_TITLE_BLOCK_HEIGHT }}>
                        <BracketConnectors
                          feederRound={round} targetRound={losersRounds[i + 1]}
                          matchMap={matchMap}
                          feederOffset={lbLayout.offsets[i]} feederGap={lbLayout.gaps[i]}
                          targetOffset={lbLayout.offsets[i + 1]} targetGap={lbLayout.gaps[i + 1]}
                          cardHeight={cardHeight} gutterWidth={gutterWidth} color={BLUE}
                          hide={round.some(id => matchMap[id] && matchMap[id].isLBPrelim)}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </>
          )}

          {/* Plate bracket - separated by a divider */}
          {plateData && (() => {
            const pm = plateData.matchMap;
            const pr = plateData.rounds || [];
            const plateChampion = pm[plateData.finalId] && pm[plateData.finalId].winner;
            return (
              <>
                <div style={{ flexShrink: 0, width: 2, alignSelf: "stretch", background: BORDER, marginRight: scale.tier === "desktop" ? 40 : 28 }} />
                {pr.map((round, i) => {
                  const isLast = i === pr.length - 1;
                  const lbl = isLast ? "Plate Final" : i === pr.length - 2 ? "Semi Final" : i === pr.length - 3 ? "Qtr Final" : `Plate Rd ${i + 1}`;
                  const isActive = activeTab === `plate-${i}`;
                  const nextCount = isLast ? 0 : pr[i + 1].length;
                  return (
                    <Fragment key={`plate-frag-${i}`}>
                      <div id={`round-col-plate-${i}`} style={{ flexShrink: 0, paddingRight: nextCount > 0 ? 0 : (scale.tier === "desktop" ? 40 : 28) }}>
                        <RoundCol
                          title={lbl} matchIds={round} matchMap={pm}
                          onPickWinner={(id, w) => setPlateMatchMap(prev => recordWinner(prev, id, w))}
                          onChangeWinner={(id, w) => setPlateMatchMap(prev => changeWinner(prev, id, w))}
                          onScore={(id, who, d) => setPlateMatchMap(prev => applyScoreChange(prev, id, who, d))}
                          isLosers={false} useScoring={useScoring} scale={scale}
                          editingMatchId={editingMatchId} setEditingMatchId={setEditingMatchId} readOnly={closedBrackets.plate}
                          isActive={isActive}
                          spacing={plateLayout.gaps[i]}
                          offset={plateLayout.offsets[i]}
                        />
                      </div>
                      {nextCount > 0 && (
                        <div style={{ flexShrink: 0, width: gutterWidth, paddingTop: BRACKET_TITLE_BLOCK_HEIGHT }}>
                          <BracketConnectors
                            feederRound={round} targetRound={pr[i + 1]}
                            matchMap={pm}
                            feederOffset={plateLayout.offsets[i]} feederGap={plateLayout.gaps[i]}
                            targetOffset={plateLayout.offsets[i + 1]} targetGap={plateLayout.gaps[i + 1]}
                            cardHeight={cardHeight} gutterWidth={gutterWidth} color={ORANGE}
                          />
                        </div>
                      )}
                    </Fragment>
                  );
                })}
                {plateChampion && (
                  <div style={{ flexShrink: 0, paddingTop: 24 }}>
                    <div style={{ fontSize: 11, color: "#FB923C", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 12, textTransform: "uppercase" }}>Plate Winner</div>
                    <div style={{ padding: 20, background: "#FB923C14", border: "1px solid #FB923C55", borderRadius: 12, textAlign: "center", minWidth: 180 }}>
                      <div style={{ fontSize: 11, fontFamily: MONO, color: "#FB923C", letterSpacing: "0.1em", marginBottom: 8 }}>PLATE CHAMPION</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#FB923C" }}>{plateChampion}</div>
                    </div>
                  </div>
                )}
              </>
            );
          })()}

        </div>
      </div>

      {/* Next up bar */}
      {activeSection !== "gf" && (() => {
        let ids = [], color = PURPLE, map = matchMap;
        if (activeSection === "wb") { ids = winnersRounds.flat(); color = PURPLE; }
        else if (activeSection === "lb") { ids = losersRounds.flat(); color = BLUE; }
        else if (activeSection === "plate" && plateData) { ids = (plateData.rounds || []).flat(); color = ORANGE; map = plateData.matchMap; }
        const next = ids.find(id => { const m = map[id]; return m && m.p1 && m.p2 && !m.winner && !m.isBye; });
        if (!next) return null;
        const m = map[next];
        return (
          <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: `linear-gradient(to top, ${BG} 70%, ${BG}00)`, padding: "20px 16px 16px" }}>
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
              <div>
                <div style={{ fontSize: 11, fontFamily: MONO, color, letterSpacing: "0.1em", marginBottom: 4 }}>NEXT - MATCH {m.matchNum}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{m.p1} <span style={{ color: MUTED, fontWeight: 400 }}>vs</span> {m.p2}</div>
              </div>
              <div style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}>{useScoring ? "Score above" : "Tap above"}</div>
            </div>
          </div>
        );
      })()}

      {/* When a Grand Final exists, LB doesn't get its own close-out ceremony -
          it just feeds into GF. Once LB is done, offer a simple way to jump
          to whichever of WB / Grand Final still needs attention. */}
      {activeSection === "lb" && grandFinalEnabled && lbComplete && !showCloseOut && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: `linear-gradient(to top, ${BG} 70%, ${BG}00)`, padding: "20px 16px 16px", display: "flex", gap: 10 }}>
          {!wbSettled && (
            <button onClick={() => setActiveTab("wb-0")}
              style={{ flex: 1, padding: "16px", background: `${GOLD}18`, border: `1px solid ${GOLD}`, borderRadius: 14, color: GOLD, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              {wbInProgress ? "Continue to Winners Bracket" : "Go to Winners Bracket"}
            </button>
          )}
          <button onClick={() => setActiveTab("gf")}
            style={{ flex: 1, padding: "16px", background: GOLD, border: "none", borderRadius: 14, color: "#0D0F14", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            Go to Grand Final
          </button>
        </div>
      )}

      {/* Close out button - show for current tab's bracket when it has a champion and isn't already closed */}
      {currentTabChampion && !currentTabClosed && !showCloseOut && !(activeSection === "lb" && grandFinalEnabled) && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: `linear-gradient(to top, ${BG} 70%, ${BG}00)`, padding: "20px 16px 16px" }}>
          <button
            onClick={handleCloseOut}
            style={{ width: "100%", padding: "16px", background: GOLD, border: "none", borderRadius: 14, color: "#0D0F14", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em" }}
          >
            {activeSection === "plate" ? "Close Out Plate" : activeSection === "lb" ? "Close Out Losers Bracket" : "Close Out Tournament"}
          </button>
        </div>
      )}

      {/* Close-out overlay */}
      {showCloseOut && (
        <div style={{ position: "fixed", inset: 0, background: "#0F172A", zIndex: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px" }}>
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 30%, ${activeSection === "plate" ? "#FB923C18" : activeSection === "lb" ? BLUE + "18" : GOLD + "18"} 0%, transparent 70%)`, pointerEvents: "none" }} />

          <div style={{ position: "relative", textAlign: "center", maxWidth: 400, width: "100%" }}>
            <div style={{ fontSize: 72, marginBottom: 8 }}>{activeSection === "plate" ? "Plate" : activeSection === "lb" ? "LB" : "W"}</div>
            <div style={{ fontSize: 13, fontFamily: MONO, color: activeSection === "plate" ? ORANGE : activeSection === "lb" ? BLUE : GOLD, letterSpacing: "0.2em", marginBottom: 12, textTransform: "uppercase" }}>
              {activeSection === "plate" ? "Plate Champion" : activeSection === "lb" ? "Losers Bracket Champion" : "Tournament Champion"}
            </div>
            <div style={{ fontSize: 36, fontWeight: 700, color: activeSection === "plate" ? ORANGE : activeSection === "lb" ? BLUE : GOLD, marginBottom: 8, lineHeight: 1.1 }}>
              {currentTabChampion}
            </div>

            <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 10 }}>
              {isLastBracket ? (
                <button onClick={handleFinalDismiss}
                  style={{ width: "100%", padding: "16px", background: GOLD, border: "none", borderRadius: 12, color: "#0D0F14", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  Back to Tournament Setup
                </button>
              ) : (
                <>
                  {/* Navigate to LB if it isn't settled yet (still running or awaiting close) */}
                  {!lbSettled && activeSection !== "lb" && (
                    <button onClick={() => { setShowCloseOut(false); setActiveTab("lb-0"); }}
                      style={{ width: "100%", padding: "14px", background: `${BLUE}18`, border: `1px solid ${BLUE}`, borderRadius: 12, color: BLUE, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      {lbInProgress ? "Continue to Losers Bracket" : "Close Out Losers Bracket"}
                    </button>
                  )}
                  {/* Navigate to plate if it isn't settled yet */}
                  {!plateSettled && activeSection !== "plate" && (
                    <button onClick={() => { setShowCloseOut(false); setActiveTab("plate-0"); }}
                      style={{ width: "100%", padding: "14px", background: `${ORANGE}18`, border: `1px solid ${ORANGE}`, borderRadius: 12, color: ORANGE, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      {plateInProgress ? "Continue to Plate" : "Close Out Plate"}
                    </button>
                  )}
                  {/* Navigate back to main WB if it isn't settled yet - whether still being played or finished-but-unclosed */}
                  {!wbSettled && activeSection !== "wb" && activeSection !== "gf" && (
                    <button onClick={() => { setShowCloseOut(false); setActiveTab("wb-0"); }}
                      style={{ width: "100%", padding: "14px", background: `${GOLD}18`, border: `1px solid ${GOLD}`, borderRadius: 12, color: GOLD, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      {wbInProgress ? "Continue to Main Bracket" : "Close Out Main Tournament"}
                    </button>
                  )}
                  <button onClick={handleCloseOutDismiss}
                    style={{ width: "100%", padding: "14px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, color: TEXT, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                    Back to Bracket
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// APP
// ===========================================================================

export default function App() {
  useEffect(() => {
    if (!document.getElementById("inter-font")) {
      const link = document.createElement("link");
      link.id = "inter-font"; link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  const [screen, setScreen] = useState("loading");
  const [players, setPlayers] = useState([]);
  const [grandFinal, setGrandFinal] = useState(true);
  const [useScoring, setUseScoring] = useState(true);
  const [bestOf, setBestOf] = useState(3);
  const [tournamentName, setTournamentName] = useState("");
  const [isSingleElim, setIsSingleElim] = useState(false);

  const [bracketData, setBracketData] = useState(null);
  const [plateData, setPlateData] = useState(null);
  const [groupState, setGroupStateRaw] = useState(null);

  const [savedSnapshot, setSavedSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const saveTimer = useRef(null);
  const latestStateRef = useRef(null);
  const tournamentIdRef = useRef(null);
  const [closedBrackets, setClosedBrackets] = useState({});
  const [logoDataUrl, setLogoDataUrlState] = useState(() => {
    try { return localStorage.getItem(LOGO_KEY) || null; } catch (e) { return null; }
  });
  const setLogoDataUrl = (dataUrl) => {
    setLogoDataUrlState(dataUrl);
    try {
      if (dataUrl) localStorage.setItem(LOGO_KEY, dataUrl);
      else localStorage.removeItem(LOGO_KEY);
    } catch (e) {}
  };

  const [saveStatus, setSaveStatus] = useState("idle");
  const [saveError, setSaveError] = useState(null);

  // -- Load on mount ------------------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { localStorage.removeItem(STORAGE_KEY); }
        if (parsed && (parsed.bracketData || parsed.groupState)) setSavedSnapshot(parsed);
      }
    } catch (e) {
      console.warn("localStorage unavailable:", e);
    } finally {
      setScreen("setup");
    }
  }, []);

  // -- Keep ref current ---------------------------------------------------
  useEffect(() => {
    latestStateRef.current = { screen, players, grandFinal, useScoring, bestOf, tournamentName, isSingleElim, plateEnabled, bracketData, plateData, groupState, closedBrackets };
  }, [screen, players, grandFinal, useScoring, bestOf, tournamentName, isSingleElim, bracketData, plateData, groupState, closedBrackets]);

  // -- Save ---------------------------------------------------------------
  const flushSave = useCallback(() => {
    const s = latestStateRef.current;
    if (!s || s.screen === "loading" || s.screen === "setup" || s.screen === "history") return;
    // Ensure a stable tournament id exists as soon as we're on an active
    // bracket, so it can be persisted and correctly restored on Resume
    // (prevents duplicate history entries from a regenerated id).
    if (s.screen === "bracket" && s.bracketData && !tournamentIdRef.current) {
      tournamentIdRef.current = `t_${Date.now()}`;
    }
    const snapshot = {
      screen: s.screen, players: s.players, grandFinal: s.grandFinal,
      useScoring: s.useScoring, bestOf: s.bestOf,
      tournamentName: s.tournamentName || "",
      isSingleElim: s.isSingleElim,
      plateEnabled: s.plateEnabled,
      bracketData: s.bracketData ? { ...s.bracketData } : null,
      plateData: s.plateData ? { ...s.plateData } : null,
      groupState: s.groupState,
      closedBrackets: s.closedBrackets || {},
      tournamentId: tournamentIdRef.current,
      savedAt: new Date().toISOString(),
    };
    setSaveStatus("saving");
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      setSaveStatus("saved");
      setSaveError(null);
      setSavedSnapshot(snapshot);
    } catch (e) {
      setSaveStatus("error");
      setSaveError(e && e.message ? e.message : String(e));
    }

    // Auto-save to history when champion exists
    if (s.screen === "bracket" && s.bracketData) {
      const { matchMap, winnersRounds, losersRounds, grandFinalId } = s.bracketData;
      const summary = summariseBracket(matchMap, s.players, s.grandFinal, winnersRounds, losersRounds, grandFinalId);
      if (summary && summary.champion) {
        const groupSummary = s.groupState ? s.groupState.groups.map((g, i) => ({
          standings: computeStandings(g, s.groupState.matchesByGroup[i] || []),
          advance: s.groupState.advancePerGroup,
        })) : null;
        // Get LB champion if double-elim
        const lb = s.bracketData.losersRounds || [];
        const lbWinner = !s.isSingleElim && lb.length > 0
          ? (s.bracketData.matchMap[lb[lb.length - 1][0]] && s.bracketData.matchMap[lb[lb.length - 1][0]].winner)
          : null;
        const entry = {
          id: tournamentIdRef.current,
          name: s.tournamentName || "",
          champion: summary.champion,
          lbChampion: lbWinner || null,
          players: s.groupState ? s.groupState.groups.flat() : summary.players,
          results: summary.results,
          playerCount: s.groupState ? s.groupState.groups.flat().length : (summary.players || []).length,
          format: s.isSingleElim ? "Single Elimination" : "Double Elimination",
          bestOf: s.bestOf,
          hasGroups: !!s.groupState,
          groupSummary,
          completedAt: new Date().toISOString(),
        };
        saveToHistory(entry);
      }
    }

    // Auto-save plate to history as a separate entry when plate has a champion
    if (s.screen === "bracket" && s.plateData) {
      const plateChamp = s.plateData.matchMap[s.plateData.finalId] && s.plateData.matchMap[s.plateData.finalId].winner;
      if (plateChamp) {
        const mainName = s.tournamentName || "";
        const plateName = mainName ? `${mainName} Plate` : `Plate`;
        const plateResults = Object.values(s.plateData.matchMap)
          .filter(m => m.winner && !m.isBye)
          .sort((a, b) => a.matchNum - b.matchNum)
          .map(m => ({
            num: m.matchNum, p1: m.p1, p2: m.p2,
            winner: m.winner, p1Games: m.p1Games || 0, p2Games: m.p2Games || 0,
            isGrandFinal: m.matchNum === Math.max(...Object.values(s.plateData.matchMap).map(x => x.matchNum)),
          }));
        const plateEntry = {
          id: `${tournamentIdRef.current || "t"}_plate`,
          name: plateName,
          champion: plateChamp,
          players: plateResults.map(r => [r.p1, r.p2]).flat().filter((v, i, a) => v && v !== "BYE" && a.indexOf(v) === i),
          results: plateResults,
          playerCount: plateResults.map(r => [r.p1, r.p2]).flat().filter((v, i, a) => v && v !== "BYE" && a.indexOf(v) === i).length,
          format: "Plate (Single Elimination)",
          bestOf: s.bestOf,
          hasGroups: false,
          groupSummary: null,
          completedAt: new Date().toISOString(),
        };
        saveToHistory(plateEntry);
      }
    }
  }, []);

  useEffect(() => {
    if (screen === "loading" || screen === "setup" || screen === "history") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flushSave(); }, 150);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [screen, players, grandFinal, useScoring, bestOf, tournamentName, isSingleElim, bracketData, plateData, groupState, flushSave]);

  useEffect(() => {
    const onHide = () => { flushSave(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, [flushSave]);

  // -- Setters ------------------------------------------------------------
  const setGroupState = useCallback((updater) => {
    setGroupStateRaw(prev => typeof updater === "function" ? updater(prev) : updater);
  }, []);

  const setMatchMap = useCallback((updater) => {
    setBracketData(prev => {
      if (!prev) return prev;
      return { ...prev, matchMap: typeof updater === "function" ? updater(prev.matchMap) : updater };
    });
  }, []);

  const setPlateMatchMap = useCallback((updater) => {
    setPlateData(prev => {
      if (!prev) return prev;
      return { ...prev, matchMap: typeof updater === "function" ? updater(prev.matchMap) : updater };
    });
  }, []);

  // -- Generate handlers --------------------------------------------------
  const [plateEnabled, setPlateEnabled] = useState(false); // whether plate is enabled for current tournament

  const handleGenerateBracket = (names, gf, scoring, bo, name, elimType, platEn) => {
    tournamentIdRef.current = `t_${Date.now()}`;
    setClosedBrackets({});
    const single = elimType === "single";
    const data = single
      ? (() => { const d = buildSingleElim(names, { shuffle: true, bestOf: bo }); return { ...d, winnersRounds: d.rounds, losersRounds: [], grandFinalId: d.finalId, prelimRound: null }; })()
      : buildBracket(names, { shuffle: true, bestOf: bo });
    setPlayers(names);
    setGrandFinal(gf);
    setUseScoring(scoring);
    setBestOf(bo);
    setTournamentName(name || "");
    setIsSingleElim(single);
    setPlateEnabled(!!platEn);
    setBracketData(data);
    setPlateData(null); // plate built later from bracket screen
    setGroupStateRaw(null);
    setScreen("bracket");
  };

  const handleGenerateGroups = (names, groupCount, advancePerGroup, scoring, bo, gf, name, platEn) => {
    tournamentIdRef.current = `t_${Date.now()}`;
    setClosedBrackets({});
    const groups = distributeGroups(names, groupCount);
    const matchesByGroup = {};
    groups.forEach((g, i) => { matchesByGroup[i] = buildRoundRobinMatches(g, bo); });
    setPlayers(names);
    setGrandFinal(gf);
    setUseScoring(scoring);
    setBestOf(bo);
    setTournamentName(name || "");
    setIsSingleElim(false);
    setPlateEnabled(!!platEn);
    setGroupStateRaw({ groups, matchesByGroup, advancePerGroup, useScoring: scoring, bestOf: bo, grandFinal: gf, plateEnabled: !!platEn });
    setBracketData(null);
    setPlateData(null);
    setScreen("groups");
  };

  const handleAdvanceToBracket = ({ qualifiers, plateEnabled: platEn }) => {
    setClosedBrackets({});
    const wrap = (d) => ({ ...d, winnersRounds: d.rounds, losersRounds: [], grandFinalId: d.finalId, prelimRound: null });
    const wb = wrap(buildSingleElim(qualifiers, { shuffle: true, bestOf }));
    setPlayers(qualifiers);
    setIsSingleElim(true);
    setPlateEnabled(!!platEn);
    setBracketData(wb);
    setPlateData(null); // plate built later from bracket screen
    setScreen("bracket");
  };

  const handleResume = () => {
    if (!savedSnapshot) return;
    setPlayers(savedSnapshot.players || []);
    setGrandFinal(savedSnapshot.grandFinal != null ? savedSnapshot.grandFinal : true);
    setUseScoring(savedSnapshot.useScoring != null ? savedSnapshot.useScoring : true);
    setBestOf(savedSnapshot.bestOf != null ? savedSnapshot.bestOf : 3);
    setTournamentName(savedSnapshot.tournamentName || "");
    setIsSingleElim(savedSnapshot.isSingleElim != null ? savedSnapshot.isSingleElim : false);
    setPlateEnabled(savedSnapshot.plateEnabled != null ? savedSnapshot.plateEnabled : false);
    setBracketData(savedSnapshot.bracketData || null);
    setPlateData(savedSnapshot.plateData || null);
    setGroupStateRaw(savedSnapshot.groupState || null);
    setClosedBrackets(savedSnapshot.closedBrackets || {});
    // Restore the original tournament id so re-closing a bracket updates the
    // existing history entry instead of creating a duplicate.
    tournamentIdRef.current = savedSnapshot.tournamentId || null;
    const s = savedSnapshot.screen;
    setScreen(s && s !== "setup" && s !== "loading" ? s : "setup");
  };

  const handleDiscard = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    setSavedSnapshot(null);
  };

  const handleBackToSetup = () => setScreen("setup");

  // -- Render -------------------------------------------------------------
  if (screen === "loading") {
    return <div style={{ minHeight: "100vh", background: BG, color: MUTED, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>Loading...</div>;
  }

  if (screen === "history") return <HistoryScreen onBack={handleBackToSetup} />;

  if (screen === "setup") {
    return (
      <SetupScreen
        onGenerateBracket={handleGenerateBracket}
        onGenerateGroups={handleGenerateGroups}
        savedExists={!!savedSnapshot}
        savedAt={(savedSnapshot && savedSnapshot.savedAt) || null}
        onResume={handleResume}
        onDiscard={handleDiscard}
        loadError={loadError}
        onHistory={() => setScreen("history")}
        logoDataUrl={logoDataUrl}
        onSetLogo={setLogoDataUrl}
      />
    );
  }

  if (screen === "groups" && groupState) {
    return (
      <GroupStageScreen
        groupState={groupState}
        setGroupState={setGroupState}
        onBack={handleBackToSetup}
        onAdvanceToBracket={handleAdvanceToBracket}
        saveStatus={saveStatus}
        saveError={saveError}
      />
    );
  }

  if (screen === "bracket" && bracketData) {
    return (
      <BracketScreen
        bracketData={bracketData}
        setMatchMap={setMatchMap}
        plateData={plateData}
        setPlateMatchMap={setPlateMatchMap}
        plateEnabled={plateEnabled}
        onBuildPlate={(players) => {
          const data = buildSingleElim(players, { shuffle: false, bestOf });
          setPlateData(data);
        }}
        players={players}
        onBack={handleBackToSetup}
        grandFinalEnabled={grandFinal}
        useScoring={useScoring}
        isSingleElim={isSingleElim}
        saveStatus={saveStatus}
        saveError={saveError}
        closedBrackets={closedBrackets}
        setClosedBrackets={setClosedBrackets}
        onAllBracketsClosed={() => {
          // Tournament is fully wrapped up - clear the saved snapshot so it
          // can no longer be resumed. Cancel any pending debounced save first
          // so it can't write the snapshot back after we clear it.
          if (saveTimer.current) clearTimeout(saveTimer.current);
          try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
          setSavedSnapshot(null);
        }}
      />
    );
  }

  return null;
}
