import { useState, useCallback, useMemo, useEffect, useRef } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const GOLD   = "#F0B429";
const PURPLE = "#A78BFA";
const BLUE   = "#4A90D9";
const GREEN  = "#34D399";
const RED    = "#F87171";
const BG     = "#0D0F14";
const CARD   = "#1A1D24";
const CARD2  = "#22262F";
const BORDER = "#2E3340";
const TEXT   = "#E8EAF0";
const MUTED  = "#6B7280";
const FONT   = "'SF Pro Display', -apple-system, system-ui, sans-serif";

const STORAGE_KEY = "tournament:active-state";

// ─── Responsive sizing ────────────────────────────────────────────────────────
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
  if (width >= 1024) return { tier: "desktop", scale: 1.35, cardWidth: 220, pip: 13, btn: 28, btnFont: 17 };
  if (width >= 640)  return { tier: "tablet",  scale: 1.15, cardWidth: 190, pip: 11, btn: 23, btnFont: 14 };
  return { tier: "mobile", scale: 1, cardWidth: 170, pip: 9, btn: 18, btnFont: 12 };
}

// ─── Generic helpers ──────────────────────────────────────────────────────────
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

// ─── Bracket Builder (double elimination) ────────────────────────────────────
/**
 * Builds a double-elimination bracket using a PRELIM round for non-power-of-2
 * player counts, so the main bracket is always a clean power of 2 with no BYEs.
 */
function buildBracket(rawPlayers, opts = {}) {
  const { shuffle = true, bestOf = 3 } = opts;
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

  // ── Prelim Round ─────────────────────────────────────────────────────────
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

  // ── Build WB R1 ──────────────────────────────────────────────────────────
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

  // ── Winners Bracket subsequent rounds ────────────────────────────────────
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

  // ── Losers Bracket ───────────────────────────────────────────────────────
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
    // No prelim round at all — standard LB starts from WB R1 losers directly.
    lbPool = [...wbR1LoserFeeders];
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

  // ── Grand Final ──────────────────────────────────────────────────────────
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

// ─── State engine: record / undo a result ────────────────────────────────────
function propagate(matchMap, matchId, winner, loser) {
  const m = matchMap[matchId];
  const updated = { ...matchMap, [matchId]: { ...m, winner, loser: loser ?? null } };
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
// the old result, then records the new one.
function changeWinner(matchMap, matchId, newWinner) {
  const m = matchMap[matchId];
  if (!m || m.isBye) return matchMap;
  let cleared = clearDownstream(matchMap, matchId);
  cleared = { ...cleared, [matchId]: { ...cleared[matchId], winner: null, loser: null } };
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

// ─── Score entry helpers ──────────────────────────────────────────────────────
function applyScoreChange(matchMap, matchId, who, delta) {
  const m = matchMap[matchId];
  if (!m || m.isBye || m.winner) return matchMap; // locked once decided
  const need = gamesToWin(m.bestOf || 3);
  let p1Games = m.p1Games || 0;
  let p2Games = m.p2Games || 0;
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

// ═══════════════════════════════════════════════════════════════════════════
// ROUND ROBIN GROUP STAGE
// ═══════════════════════════════════════════════════════════════════════════

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

function computeStandings(group, matches) {
  const stats = {};
  for (const p of group) {
    stats[p] = { player: p, wins: 0, losses: 0, gamesWon: 0, gamesPlayed: 0, played: 0 };
  }
  for (const m of matches) {
    if (m.isWalkover) continue; // walkovers don't count toward stats
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
    return a.player.localeCompare(b.player);
  });
  return list;
}

// ═══════════════════════════════════════════════════════════════════════════
// UI: shared bits
// ═══════════════════════════════════════════════════════════════════════════

function ScorePips({ m, accent, onScore, disabled, scale }) {
  const need = gamesToWin(m.bestOf || 3);
  if (m.isBye) return null;
  const s = scale || { pip: 9, btn: 18, btnFont: 12 };
  const Row = ({ who, games, other }) => (
    <div style={{ display: "flex", alignItems: "center", gap: Math.round(s.btn * 0.33) }}>
      <button
        disabled={disabled || !!m.winner || !m.p1 || !m.p2}
        onClick={(e) => { e.stopPropagation(); onScore(m.id, who, -1); }}
        style={pipBtnStyle(false, s)}
      >−</button>
      <div style={{ display: "flex", gap: 4, minWidth: (s.pip + 4) * need }}>
        {Array.from({ length: need }).map((_, i) => (
          <div key={i} style={{
            width: s.pip, height: s.pip, borderRadius: Math.max(2, Math.round(s.pip * 0.25)),
            background: i < games ? accent : BORDER,
            transition: "background 0.15s",
          }} />
        ))}
      </div>
      <button
        disabled={disabled || !!m.winner || !m.p1 || !m.p2}
        onClick={(e) => { e.stopPropagation(); onScore(m.id, who, 1); }}
        style={pipBtnStyle(true, s)}
      >+</button>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: Math.round(s.btn * 0.22), padding: `${Math.round(s.btn * 0.33)}px 10px ${Math.round(s.btn * 0.44)}px` }}>
      <Row who="p1" games={m.p1Games || 0} />
      <Row who="p2" games={m.p2Games || 0} />
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

// ─── MatchCard ────────────────────────────────────────────────────────────────
function MatchCard({ matchId, matchMap, onPickWinner, onChangeWinner, onScore, isLosers, isGrandFinal, useScoring, scale }) {
  const m = matchMap[matchId];
  const accent = isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE;
  const s = scale || { tier: "mobile", cardWidth: 170, pip: 9, btn: 18, btnFont: 12 };

  const players = [
    { player: m.p1, slot: "p1" },
    { player: m.p2, slot: "p2" },
  ];

  const ready   = m.p1 && m.p2 && !m.winner && !m.isBye && m.p1 !== "BYE" && m.p2 !== "BYE";
  const settled = !!m.winner;

  const headerLabel = isGrandFinal ? "GRAND FINAL"
    : isLosers ? `LB · MATCH ${m.matchNum}`
    : `MATCH ${m.matchNum}`;

  const [editing, setEditing] = useState(false);

  return (
    <div style={{
      background: CARD,
      border: `1px solid ${settled ? accent + "55" : BORDER}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10,
      minWidth: s.cardWidth,
      width: s.cardWidth,
      fontFamily: FONT,
      boxShadow: isGrandFinal && settled ? `0 0 24px ${GOLD}44` : "none",
      overflow: "hidden",
    }}>
      <div style={{
        padding: "5px 10px",
        fontSize: 9,
        fontFamily: "monospace",
        color: accent,
        letterSpacing: "0.1em",
        fontWeight: 700,
        background: `${accent}18`,
        borderBottom: `1px solid ${BORDER}`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span>{headerLabel}</span>
        {ready && !useScoring && <span style={{ color: MUTED, fontSize: 8 }}>TAP TO PICK</span>}
        {settled && !editing && (
          <span
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            style={{ fontSize: 8, color: GREEN, cursor: "pointer", textDecoration: "underline dotted" }}
            title="Change winner"
          >✓ DONE · EDIT</span>
        )}
        {settled && editing && (
          <span
            onClick={(e) => { e.stopPropagation(); setEditing(false); }}
            style={{ fontSize: 8, color: MUTED, cursor: "pointer" }}
          >CLOSE</span>
        )}
      </div>

      {players.map(({ player, slot }, i) => {
        const fromLabel = !player ? slotLabel(matchMap, matchId, slot) : null;
        const isWinner  = settled && m.winner === player;
        const isLoserP  = settled && m.loser === player;
        const canTap    = (ready || (settled && editing)) && !!player && player !== "BYE";

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
            {isWinner && <span style={{ fontSize: 9, color: accent, flexShrink: 0 }}>▶</span>}
            {isLoserP && <span style={{ fontSize: 9, color: MUTED, flexShrink: 0 }}>✕</span>}
            {!isWinner && !isLoserP && <span style={{ width: 14, flexShrink: 0 }} />}

            <div style={{ overflow: "hidden", flex: 1 }}>
              {player && player !== "BYE" ? (
                <div style={{
                  fontSize: s.tier === "desktop" ? 16 : s.tier === "tablet" ? 14 : 13,
                  fontWeight: isWinner ? 700 : 400,
                  color: isLoserP ? MUTED : TEXT,
                  textDecoration: isLoserP ? "line-through" : "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>{player}</div>
              ) : player === "BYE" ? (
                <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>BYE</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>TBD</div>
                  {fromLabel && (
                    <div style={{
                      fontSize: 9, color: isLosers ? BLUE + "bb" : MUTED,
                      fontFamily: "monospace", marginTop: 1, letterSpacing: "0.03em",
                    }}>{fromLabel}</div>
                  )}
                </>
              )}
            </div>
            {settled && useScoring && !m.isBye && (
              <div style={{ fontSize: s.tier === "desktop" ? 16 : 13, fontWeight: 700, color: isWinner ? accent : MUTED }}>
                {slot === "p1" ? m.p1Games : m.p2Games}
              </div>
            )}
            {canTap && !useScoring && (
              <span style={{ fontSize: 18, color: `${accent}55`, flexShrink: 0, lineHeight: 1 }}>›</span>
            )}
          </div>
        );
      })}

      {useScoring && !settled && !m.isBye && m.p1 && m.p2 && (
        <ScorePips m={m} accent={accent} onScore={onScore} scale={s} />
      )}
    </div>
  );
}

function RoundCol({ title, matchIds, matchMap, onPickWinner, onChangeWinner, onScore, isLosers, isGrandFinal, spacing, useScoring, scale }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{
        fontSize: 9, fontFamily: "monospace",
        color: isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE,
        letterSpacing: "0.15em", fontWeight: 700, marginBottom: 12,
        textTransform: "uppercase", paddingLeft: 2,
      }}>{title}</div>

      <div style={{
        display: "flex", flexDirection: "column", gap: spacing ?? 16,
        justifyContent: "space-around", flex: 1,
      }}>
        {(Array.isArray(matchIds) ? matchIds : [matchIds]).map(id => (
          <MatchCard
            key={id} matchId={id} matchMap={matchMap}
            onPickWinner={onPickWinner} onChangeWinner={onChangeWinner} onScore={onScore}
            isLosers={isLosers} isGrandFinal={isGrandFinal} useScoring={useScoring} scale={scale}
          />
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function SetupScreen({ onGenerateBracket, onGenerateGroups, savedExists, onResume, onDiscard, loadError }) {
  const [mode, setMode] = useState("bracket"); // "bracket" | "groups"
  const [count, setCount] = useState(8);
  const [names, setNames] = useState(Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`));
  const [grandFinalEnabled, setGrandFinalEnabled] = useState(true);
  const [bestOf, setBestOf] = useState(3);
  const [useScoring, setUseScoring] = useState(true);

  // Group stage settings
  const [groupCount, setGroupCount] = useState(2);
  const [advancePerGroup, setAdvancePerGroup] = useState(2);
  const [groupsTouched, setGroupsTouched] = useState(false);

  const updateCount = (n) => {
    const c = Math.max(2, Math.min(64, n));
    setCount(c);
    setNames(prev => {
      const next = [...prev];
      while (next.length < c) next.push(`Player ${next.length + 1}`);
      return next.slice(0, c);
    });
    if (!groupsTouched) setGroupCount(suggestGroupCount(c));
  };

  const byes = nextPow2(count) - count;
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

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, paddingBottom: 160 }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "20px 20px 14px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: GOLD, letterSpacing: "0.2em", marginBottom: 4 }}>TOURNAMENT BUILDER</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.5px" }}>New Tournament</div>
        </div>
      </div>

      <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>
      {loadError && (
        <div style={{ margin: "16px 20px 0", padding: "12px 16px", background: `${RED}14`, border: `1px solid ${RED}55`, borderRadius: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: RED, marginBottom: 3 }}>Could not load saved tournament</div>
          <div style={{ fontSize: 11, color: MUTED }}>{loadError}</div>
        </div>
      )}

      {savedExists && (
        <div style={{ margin: "16px 20px 0", padding: "14px 16px", background: `${GOLD}14`, border: `1px solid ${GOLD}55`, borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Resume saved tournament?</div>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>You have an in-progress tournament saved on this device.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onResume} style={{ flex: 1, padding: "9px", background: GOLD, border: "none", borderRadius: 8, color: "#0D0F14", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Resume</button>
            <button onClick={onDiscard} style={{ flex: 1, padding: "9px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
          </div>
        </div>
      )}

      {/* Mode toggle */}
      <div style={{ padding: "20px 20px 0" }}>
        <div style={{ display: "flex", gap: 8, background: CARD2, padding: 4, borderRadius: 12, border: `1px solid ${BORDER}` }}>
          {[{ k: "bracket", l: "Knockout Only" }, { k: "groups", l: "Groups → Knockout" }].map(({ k, l }) => (
            <button key={k} onClick={() => setMode(k)} style={{
              flex: 1, padding: "9px 0", borderRadius: 9, border: "none",
              background: mode === k ? GOLD : "transparent",
              color: mode === k ? "#0D0F14" : MUTED,
              fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit",
            }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "24px 20px 0" }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 12, textTransform: "uppercase" }}>Number of Players</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {["-", "+"].map((sym, di) => (
              <button key={sym} onClick={() => updateCount(count + (di ? 1 : -1))} style={{
                width: scale.tier === "desktop" ? 52 : 44, height: scale.tier === "desktop" ? 52 : 44,
                background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                color: TEXT, fontSize: scale.tier === "desktop" ? 26 : 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}>{sym}</button>
            ))}
            <div style={{ flex: 1, textAlign: "center", fontSize: 38, fontWeight: 700, color: GOLD, fontFamily: "monospace" }}>{count}</div>
          </div>

          {mode === "bracket" && (
            <div style={{ marginTop: 10, fontSize: 11, color: perfect ? GREEN : MUTED, textAlign: "center", fontFamily: "monospace" }}>
              {perfect ? "✓ Perfect bracket — no prelim needed" : (() => {
                let mainSz = 1;
                while (mainSz * 2 <= count) mainSz *= 2;
                const ov = count - mainSz;
                const prelims = Math.ceil(ov / 2);
                return `Prelim round: ${prelims} match${prelims > 1 ? "es" : ""} → clean ${mainSz}-player bracket`;
              })()}
            </div>
          )}
        </div>

        {mode === "groups" && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 12, textTransform: "uppercase" }}>Groups</div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
              {["-", "+"].map((sym, di) => (
                <button key={sym} onClick={() => { setGroupsTouched(true); setGroupCount(g => Math.max(1, Math.min(count, g + (di ? 1 : -1)))); }} style={{
                  width: 40, height: 40, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10,
                  color: TEXT, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                }}>{sym}</button>
              ))}
              <div style={{ flex: 1, textAlign: "center", fontSize: 28, fontWeight: 700, color: PURPLE, fontFamily: "monospace" }}>{effectiveGroupCount}</div>
            </div>
            <div style={{ fontSize: 11, color: MUTED, textAlign: "center", fontFamily: "monospace", marginBottom: 16 }}>
              Sizes: {groupSizes.join(", ")} {groupSizes.some(s => s % 2 === 1) ? "· odd groups get a walkover round" : ""}
            </div>

            <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>Advance Per Group</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {[1, 2, 3, 4].map(v => (
                <button key={v} onClick={() => setAdvancePerGroup(v)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10,
                  border: `1px solid ${advancePerGroup === v ? PURPLE : BORDER}`,
                  background: advancePerGroup === v ? `${PURPLE}22` : CARD2,
                  color: advancePerGroup === v ? PURPLE : MUTED,
                  fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit",
                }}>Top {v}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: MUTED, textAlign: "center", fontFamily: "monospace" }}>
              {qualifierCount} qualifiers → {resultingBracketSize}-player knockout bracket
              {qualifierCount !== resultingBracketSize && ` (${resultingBracketSize - qualifierCount} prelim spot${resultingBracketSize - qualifierCount !== 1 ? "s" : ""} in bracket)`}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 12, textTransform: "uppercase" }}>Player Names</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {names.map((name, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: CARD2, border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontFamily: "monospace", color: MUTED, flexShrink: 0 }}>{i + 1}</div>
                <input
                  value={name}
                  onChange={e => { const n = [...names]; n[i] = e.target.value; setNames(n); }}
                  placeholder={`Player ${i + 1}`}
                  style={{ flex: 1, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 14px", color: TEXT, fontSize: 15, outline: "none", fontFamily: "inherit" }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: "24px 20px 8px" }}>
        <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 12, textTransform: "uppercase" }}>Scoring</div>
        <div onClick={() => setUseScoring(v => !v)} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: CARD2, border: `1px solid ${useScoring ? GOLD + "66" : BORDER}`,
          borderRadius: 12, padding: "12px 14px", cursor: "pointer", marginBottom: 12,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Track game scores</div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>{useScoring ? "Tap +/- to enter game scores; winner is automatic" : "Just tap the winner's name"}</div>
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
                fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit",
              }}>Best of {v}</button>
            ))}
          </div>
        )}
      </div>

      {mode === "bracket" && (
        <div style={{ padding: "24px 20px 8px" }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 12, textTransform: "uppercase" }}>Format</div>
          <div onClick={() => setGrandFinalEnabled(v => !v)} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: CARD2, border: `1px solid ${grandFinalEnabled ? GOLD + "66" : BORDER}`,
            borderRadius: 12, padding: "12px 14px", cursor: "pointer",
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Grand Final</div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>{grandFinalEnabled ? "LB winner faces WB winner" : "WB winner is champion"}</div>
            </div>
            <div style={{ width: 44, height: 26, borderRadius: 13, background: grandFinalEnabled ? GOLD : BORDER, position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 4, left: grandFinalEnabled ? 22 : 4, width: 18, height: 18, borderRadius: 9, background: "#fff", transition: "left 0.2s" }} />
            </div>
          </div>
        </div>
      )}
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 20px", background: `linear-gradient(to top, ${BG} 80%, transparent)` }}>
        <div style={{ maxWidth: contentMaxWidth, margin: "0 auto" }}>
        <button
          onClick={() => {
            const cleanNames = names.map(n => n.trim() || null).filter(Boolean);
            if (mode === "bracket") {
              onGenerateBracket(cleanNames, grandFinalEnabled, useScoring, bestOf);
            } else {
              onGenerateGroups(cleanNames, effectiveGroupCount, advancePerGroup, useScoring, bestOf, grandFinalEnabled);
            }
          }}
          style={{ width: "100%", padding: scale.tier === "desktop" ? "18px" : "16px", background: GOLD, border: "none", borderRadius: 14, color: "#0D0F14", fontSize: scale.tier === "desktop" ? 18 : 16, fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em", fontFamily: "inherit" }}
        >
          {mode === "bracket" ? "Generate Bracket →" : "Generate Groups →"}
        </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP STAGE SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function GroupStageScreen({ groupState, setGroupState, onBack, onAdvanceToBracket }) {
  const { groups, matchesByGroup, advancePerGroup, useScoring, bestOf } = groupState;
  const [activeGroup, setActiveGroup] = useState(0);
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
      let winner = m.winner, loser = m.loser;
      if (p1Games >= need) { winner = m.p1; loser = m.p2; }
      else if (p2Games >= need) { winner = m.p2; loser = m.p1; }
      list[idx] = { ...m, p1Games, p2Games, winner, loser };
      const updated = { ...prev, matchesByGroup: { ...prev.matchesByGroup, [groupIdx]: list } };
      return updated;
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
      list[idx] = { ...m, winner, loser, p1Games: winner === m.p1 ? need : (m.p1Games||0), p2Games: winner === m.p2 ? need : (m.p2Games||0) };
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

  const allStandings = groups.map((g, i) => computeStandings(g, matchesByGroup[i] || []));
  const totalMatches = Object.values(matchesByGroup).flat().filter(m => !m.isBye).length;
  const doneMatches = Object.values(matchesByGroup).flat().filter(m => m.winner && !m.isBye).length;
  const allComplete = totalMatches > 0 && doneMatches === totalMatches;

  const qualifiers = allStandings.flatMap(s => s.slice(0, advancePerGroup).map(x => x.player));

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "14px 16px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "6px 12px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", flexShrink: 0 }}>← Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, fontFamily: "monospace", color: PURPLE, letterSpacing: "0.2em" }}>GROUP STAGE</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{groups.length} groups · {doneMatches}/{totalMatches} matches</div>
          </div>
        </div>
        <div style={{ marginTop: 10, height: 3, background: BORDER, borderRadius: 2 }}>
          <div style={{ height: "100%", borderRadius: 2, background: PURPLE, width: `${totalMatches ? (doneMatches / totalMatches) * 100 : 0}%`, transition: "width 0.3s" }} />
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 12, overflowX: "auto" }}>
          {groups.map((g, i) => (
            <button key={i} onClick={() => setActiveGroup(i)} style={{
              flex: "0 0 auto", padding: "6px 14px",
              background: activeGroup === i ? `${PURPLE}22` : "transparent",
              border: `1px solid ${activeGroup === i ? PURPLE : BORDER}`,
              borderRadius: 8, color: activeGroup === i ? PURPLE : MUTED,
              fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "monospace", letterSpacing: "0.05em",
            }}>GROUP {String.fromCharCode(65 + i)}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px 140px", maxWidth: scale.tier === "desktop" ? 760 : "none", margin: "0 auto" }}>
        {/* Standings table */}
        <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>
          Group {String.fromCharCode(65 + activeGroup)} Standings
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 36px 50px 50px", padding: "8px 12px", fontSize: 9, color: MUTED, fontFamily: "monospace", borderBottom: `1px solid ${BORDER}` }}>
            <div>#</div><div>PLAYER</div><div>W-L</div><div>PPG</div><div>DIFF</div>
          </div>
          {allStandings[activeGroup].map((s, i) => (
            <div key={s.player} style={{
              display: "grid", gridTemplateColumns: "24px 1fr 36px 50px 50px",
              padding: "9px 12px", fontSize: 13,
              background: i < advancePerGroup ? `${GREEN}11` : "transparent",
              borderBottom: i < allStandings[activeGroup].length - 1 ? `1px solid ${BORDER}` : "none",
            }}>
              <div style={{ color: i < advancePerGroup ? GREEN : MUTED, fontWeight: 700 }}>{i + 1}</div>
              <div style={{ fontWeight: i < advancePerGroup ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.player}</div>
              <div style={{ color: MUTED, fontFamily: "monospace", fontSize: 11 }}>{s.wins}-{s.losses}</div>
              <div style={{ color: MUTED, fontFamily: "monospace", fontSize: 11 }}>{s.ppg.toFixed(2)}</div>
              <div style={{ color: s.gameDiff > 0 ? GREEN : s.gameDiff < 0 ? RED : MUTED, fontFamily: "monospace", fontSize: 11 }}>{s.gameDiff > 0 ? "+" : ""}{s.gameDiff}</div>
            </div>
          ))}
        </div>

        {/* Matches */}
        <div style={{ fontSize: 10, fontFamily: "monospace", color: MUTED, letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>Matches</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(matchesByGroup[activeGroup] || []).map(m => {
            const matchMapShim = { [m.id]: { ...m, matchNum: m.id.replace("rr", ""), winnerGoesToMatchId: null, loserGoesToMatchId: null, p1FromMatchId: null, p2FromMatchId: null } };
            return (
              <div key={m.id} style={{ width: "100%" }}>
                <MatchCard
                  matchId={m.id}
                  matchMap={matchMapShim}
                  onPickWinner={(id, w) => handlePick(activeGroup, id, w)}
                  onChangeWinner={(id, w) => handleChangeWinner(activeGroup, id, w)}
                  onScore={(id, who, delta) => handleScore(activeGroup, id, who, delta)}
                  isLosers={false}
                  isGrandFinal={false}
                  useScoring={useScoring}
                  scale={{ ...scale, cardWidth: "100%" }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 20px", background: `linear-gradient(to top, ${BG} 85%, transparent)` }}>
        <button
          disabled={!allComplete}
          onClick={() => onAdvanceToBracket(qualifiers)}
          style={{
            width: "100%", padding: "16px", background: allComplete ? GOLD : CARD2,
            border: allComplete ? "none" : `1px solid ${BORDER}`, borderRadius: 14,
            color: allComplete ? "#0D0F14" : MUTED, fontSize: 15, fontWeight: 700,
            cursor: allComplete ? "pointer" : "not-allowed", fontFamily: "inherit",
          }}
        >
          {allComplete ? `Advance ${qualifiers.length} Qualifiers to Bracket →` : `Finish all matches to advance (${doneMatches}/${totalMatches})`}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BRACKET SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function BracketScreen({ bracketData, setMatchMap, players, onBack, grandFinalEnabled, useScoring }) {
  const { matchMap, winnersRounds, losersRounds, grandFinalId, prelimRound } = bracketData;
  const allWbRounds = prelimRound ? [prelimRound, ...winnersRounds] : winnersRounds;
  const scale = useViewportScale();

  const handlePick = useCallback((matchId, winner) => {
    setMatchMap(prev => recordWinner(prev, matchId, winner));
  }, [setMatchMap]);

  const handleChangeWinner = useCallback((matchId, newWinner) => {
    setMatchMap(prev => changeWinner(prev, matchId, newWinner));
  }, [setMatchMap]);

  const handleScore = useCallback((matchId, who, delta) => {
    setMatchMap(prev => applyScoreChange(prev, matchId, who, delta));
  }, [setMatchMap]);

  const totalMatches = Object.values(matchMap).filter(m => !m.isBye).length;
  const doneCount    = Object.values(matchMap).filter(m => m.winner && !m.isBye).length;
  const wbFinalId  = winnersRounds[winnersRounds.length - 1][0];
  const champion   = grandFinalEnabled ? matchMap[grandFinalId]?.winner : matchMap[wbFinalId]?.winner;

  const [activeTab, setActiveTab] = useState("wb");

  const wbLabel = (i, total) => {
    if (prelimRound && i === 0) return "WB PRELIM";
    const adj = prelimRound ? i - 1 : i;
    if (i === total - 1) return "WB FINAL";
    return adj === 0 ? "WB ROUND 1" : `WB ROUND ${adj + 1}`;
  };

  const lbLabel = (i) => {
    if (i === losersRounds.length - 1) return "LB FINAL";
    const hasPrelim = losersRounds.length > 0 && losersRounds[0].some(id => matchMap[id].isLBPrelim);
    if (hasPrelim) {
      if (i === 0) return "LB PRELIM";
      return i === 1 ? "LB ROUND 1" : `LB ROUND ${i}`;
    }
    return i === 0 ? "LB ROUND 1" : `LB ROUND ${i + 1}`;
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT }}>
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: "14px 16px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT, padding: "6px 12px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", flexShrink: 0 }}>← Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, fontFamily: "monospace", color: GOLD, letterSpacing: "0.2em" }}>DOUBLE ELIMINATION</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{players.length} Players · {doneCount}/{totalMatches} matches</div>
          </div>
          {champion && (
            <div style={{ flexShrink: 0, textAlign: "right" }}>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: GOLD, letterSpacing: "0.1em" }}>CHAMPION</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{champion}</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 10, height: 3, background: BORDER, borderRadius: 2 }}>
          <div style={{ height: "100%", borderRadius: 2, background: GOLD, width: `${totalMatches ? (doneCount / totalMatches) * 100 : 0}%`, transition: "width 0.3s" }} />
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          {[
            { key: "wb", label: "Winners", color: PURPLE },
            { key: "lb", label: "Losers", color: BLUE },
            ...(grandFinalEnabled ? [{ key: "gf", label: "Final", color: GOLD }] : []),
          ].map(({ key, label, color }) => (
            <button key={key} onClick={() => setActiveTab(key)} style={{
              flex: 1, padding: "6px 0",
              background: activeTab === key ? `${color}22` : "transparent",
              border: `1px solid ${activeTab === key ? color : BORDER}`,
              borderRadius: 8, color: activeTab === key ? color : MUTED,
              fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "monospace", letterSpacing: "0.05em",
            }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, padding: "10px 16px", borderBottom: `1px solid ${BORDER}`, background: CARD, flexWrap: "wrap" }}>
        {[{ color: PURPLE, label: "Winners" }, { color: BLUE, label: "Losers" }, { color: GOLD, label: "Grand Final" }, { color: GREEN, label: "Complete" }].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: MUTED }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />{label}
          </div>
        ))}
      </div>

      <div style={{ overflowX: "auto", padding: "20px 16px 120px" }}>
        {activeTab === "wb" && (
          <div style={{ display: "flex", gap: scale.tier === "desktop" ? 48 : 32, alignItems: "flex-start" }}>
            {allWbRounds.map((round, i) => (
              <RoundCol
                key={i} title={wbLabel(i, allWbRounds.length)} matchIds={round} matchMap={matchMap}
                onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore}
                isLosers={false} useScoring={useScoring} scale={scale}
                spacing={i === 0 ? 16 : 16 * Math.pow(2, Math.max(0, i - (prelimRound ? 1 : 0)))}
              />
            ))}
          </div>
        )}

        {activeTab === "lb" && (
          losersRounds.length === 0
            ? <div style={{ color: MUTED, padding: 20, fontStyle: "italic" }}>No losers bracket (2 players)</div>
            : <div style={{ display: "flex", gap: scale.tier === "desktop" ? 48 : 32, alignItems: "flex-start" }}>
                {losersRounds.map((round, i) => (
                  <RoundCol
                    key={i} title={lbLabel(i)} matchIds={round} matchMap={matchMap}
                    onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore}
                    isLosers={true} useScoring={useScoring} spacing={16} scale={scale}
                  />
                ))}
              </div>
        )}

        {activeTab === "gf" && grandFinalEnabled && (
          <div>
            <div style={{ fontSize: 11, fontFamily: "monospace", color: GOLD, letterSpacing: "0.15em", marginBottom: 20, padding: "8px 0 8px", borderBottom: `1px solid ${GOLD}33` }}>◆ GRAND FINAL</div>
            <div style={{ marginBottom: 16, fontSize: 12, color: MUTED }}>WB Finalist vs LB Champion — first to lose drops out entirely.</div>
            <MatchCard matchId={grandFinalId} matchMap={matchMap} onPickWinner={handlePick} onChangeWinner={handleChangeWinner} onScore={handleScore} isLosers={false} isGrandFinal={true} useScoring={useScoring} scale={scale} />
            {champion && (
              <div style={{ marginTop: 28, padding: 20, background: `${GOLD}11`, border: `1px solid ${GOLD}55`, borderRadius: 12, textAlign: "center", boxShadow: `0 0 32px ${GOLD}22` }}>
                <div style={{ fontSize: 10, fontFamily: "monospace", color: GOLD, letterSpacing: "0.2em", marginBottom: 8 }}>🏆 TOURNAMENT CHAMPION</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: GOLD }}>{champion}</div>
              </div>
            )}
          </div>
        )}

        {!grandFinalEnabled && champion && (
          <div style={{ marginTop: 16, padding: 20, background: `${GOLD}11`, border: `1px solid ${GOLD}55`, borderRadius: 12, textAlign: "center", boxShadow: `0 0 32px ${GOLD}22` }}>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: GOLD, letterSpacing: "0.2em", marginBottom: 8 }}>🏆 TOURNAMENT CHAMPION</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: GOLD }}>{champion}</div>
          </div>
        )}
      </div>

      {activeTab !== "gf" && (() => {
        const allIds = activeTab === "wb" ? winnersRounds.flat() : losersRounds.flat();
        const next = allIds.find(id => { const m = matchMap[id]; return m.p1 && m.p2 && !m.winner && !m.isBye; });
        if (!next) return null;
        const m = matchMap[next];
        return (
          <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: `linear-gradient(to top, ${BG} 60%, transparent)`, padding: "20px 16px 16px" }}>
            <div style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: activeTab === "wb" ? PURPLE : BLUE, letterSpacing: "0.1em", marginBottom: 4 }}>NEXT UP · MATCH {m.matchNum}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{m.p1} <span style={{ color: MUTED, fontWeight: 400 }}>vs</span> {m.p2}</div>
              </div>
              <div style={{ fontSize: 10, color: MUTED, fontFamily: "monospace" }}>{useScoring ? "Score above ↑" : "Tap players above ↑"}</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════════════════

export default function App() {
  const [screen, setScreen] = useState("loading"); // loading | setup | groups | bracket
  const [players, setPlayers] = useState([]);
  const [grandFinal, setGrandFinal] = useState(true);
  const [useScoring, setUseScoring] = useState(true);
  const [bestOf, setBestOf] = useState(3);

  const [bracketData, setBracketData] = useState(null); // { matchMap, winnersRounds, losersRounds, grandFinalId, prelimRound }
  const [groupState, setGroupStateRaw] = useState(null); // { groups, matchesByGroup, advancePerGroup, useScoring, bestOf }

  const [savedSnapshot, setSavedSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const saveTimer = useRef(null);
  const latestStateRef = useRef(null);

  // Load saved state on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        // A successful get() with no stored key can return null OR throw,
        // depending on backend — handle both as "nothing saved".
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setSavedSnapshot(parsed);
        }
      } catch (e) {
        // Distinguish "key not found" (expected, no save yet) from a real
        // storage failure so we don't silently hide actual problems.
        const msg = String(e && e.message ? e.message : e);
        if (!/not found|no such key|404/i.test(msg)) {
          setLoadError(msg);
        }
      } finally {
        setScreen("setup");
      }
    })();
  }, []);

  // Keep a ref of the latest persistable state so we can flush it
  // synchronously on tab close/hide, not just on the debounce timer.
  useEffect(() => {
    latestStateRef.current = { screen, players, grandFinal, useScoring, bestOf, bracketData, groupState };
  }, [screen, players, grandFinal, useScoring, bestOf, bracketData, groupState]);

  const flushSave = useCallback(async () => {
    const s = latestStateRef.current;
    if (!s || s.screen === "loading" || s.screen === "setup") return;
    const snapshot = {
      screen: s.screen, players: s.players, grandFinal: s.grandFinal,
      useScoring: s.useScoring, bestOf: s.bestOf,
      bracketData: s.bracketData ? { ...s.bracketData } : null,
      groupState: s.groupState,
      savedAt: new Date().toISOString(),
    };
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(snapshot), false);
    } catch (e) {
      // ignore storage errors
    }
  }, []);

  // Persist whenever core state changes (debounced)
  useEffect(() => {
    if (screen === "loading" || screen === "setup") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flushSave(); }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [screen, players, grandFinal, useScoring, bestOf, bracketData, groupState, flushSave]);

  // Also flush immediately when the tab is hidden/closed, since the app
  // may close before the debounce timer fires.
  useEffect(() => {
    const onHide = () => { flushSave(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [flushSave]);

  const setGroupState = useCallback((updater) => {
    setGroupStateRaw(prev => typeof updater === "function" ? updater(prev) : updater);
  }, []);

  const setMatchMap = useCallback((updater) => {
    setBracketData(prev => {
      if (!prev) return prev;
      const nextMap = typeof updater === "function" ? updater(prev.matchMap) : updater;
      return { ...prev, matchMap: nextMap };
    });
  }, []);

  const handleGenerateBracket = (names, gf, scoring, bo) => {
    const data = buildBracket(names, { shuffle: true, bestOf: bo });
    setPlayers(names);
    setGrandFinal(gf);
    setUseScoring(scoring);
    setBestOf(bo);
    setBracketData(data);
    setGroupStateRaw(null);
    setScreen("bracket");
  };

  const handleGenerateGroups = (names, groupCount, advancePerGroup, scoring, bo, gf) => {
    const groups = distributeGroups(names, groupCount);
    const matchesByGroup = {};
    groups.forEach((g, i) => { matchesByGroup[i] = buildRoundRobinMatches(g, bo); });
    setPlayers(names);
    setGrandFinal(gf);
    setUseScoring(scoring);
    setBestOf(bo);
    setGroupStateRaw({ groups, matchesByGroup, advancePerGroup, useScoring: scoring, bestOf: bo, grandFinal: gf });
    setBracketData(null);
    setScreen("groups");
  };

  const handleAdvanceToBracket = (qualifiers) => {
    const data = buildBracket(qualifiers, { shuffle: true, bestOf });
    setPlayers(qualifiers);
    setBracketData(data);
    setScreen("bracket");
  };

  const handleResume = () => {
    if (!savedSnapshot) return;
    setPlayers(savedSnapshot.players || []);
    setGrandFinal(savedSnapshot.grandFinal ?? true);
    setUseScoring(savedSnapshot.useScoring ?? true);
    setBestOf(savedSnapshot.bestOf ?? 3);
    setBracketData(savedSnapshot.bracketData || null);
    setGroupStateRaw(savedSnapshot.groupState || null);
    setScreen(savedSnapshot.screen && savedSnapshot.screen !== "setup" && savedSnapshot.screen !== "loading" ? savedSnapshot.screen : "setup");
  };

  const handleDiscard = async () => {
    try { await window.storage.delete(STORAGE_KEY, false); } catch (e) {}
    setSavedSnapshot(null);
  };

  const handleBackToSetup = () => {
    setScreen("setup");
  };

  if (screen === "loading") {
    return <div style={{ minHeight: "100vh", background: BG, color: MUTED, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>Loading…</div>;
  }

  if (screen === "setup") {
    return (
      <SetupScreen
        onGenerateBracket={handleGenerateBracket}
        onGenerateGroups={handleGenerateGroups}
        savedExists={!!savedSnapshot}
        onResume={handleResume}
        onDiscard={handleDiscard}
        loadError={loadError}
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
      />
    );
  }

  if (screen === "bracket" && bracketData) {
    return (
      <BracketScreen
        bracketData={bracketData}
        setMatchMap={setMatchMap}
        players={players}
        onBack={handleBackToSetup}
        grandFinalEnabled={grandFinal}
        useScoring={useScoring}
      />
    );
  }

  return null;
}
