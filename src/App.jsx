import { useState, useCallback, useMemo } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const GOLD   = "#F0B429";
const PURPLE = "#A78BFA";
const BLUE   = "#4A90D9";
const GREEN  = "#34D399";
const BG     = "#0D0F14";
const CARD   = "#1A1D24";
const CARD2  = "#22262F";
const BORDER = "#2E3340";
const TEXT   = "#E8EAF0";
const MUTED  = "#6B7280";

// ─── Bracket Builder ──────────────────────────────────────────────────────────
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

/**
 * Builds a double-elimination bracket using a PRELIM round for non-power-of-2
 * player counts, so the main bracket is always a clean power of 2 with no BYEs.
 *
 * Strategy:
 *   mainSize = largest power of 2 <= players.length
 *   overflow  = players.length - mainSize
 *   - overflow players play prelim matches; winners enter WB R1
 *   - remaining (mainSize - overflow) players get byes straight into WB R1
 *   - If odd overflow, one prelim player gets a BYE in prelims (shown as BYE)
 *   - Main bracket (WB R1 onward) is always exactly mainSize players, no BYEs
 *
 * 10 players → mainSize=8, overflow=2 → 1 prelim match, 8 in WB R1 (clean)
 * 12 players → mainSize=8, overflow=4 → 2 prelim matches, 8 in WB R1 (clean)
 * 13 players → mainSize=8, overflow=5 → 3 prelim matches (1 has a BYE), 8 in WB R1
 */
function buildBracket(rawPlayers) {
  const players = shuffleFisherYates(rawPlayers);
  const n        = players.length;
  // mainSize = largest power of 2 <= n (so main bracket has no byes)
  let mainSize = 1;
  while (mainSize * 2 <= n) mainSize *= 2;

  const overflow = n - mainSize; // how many extra players need prelim spots

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
      isPrelim: false, isBye: false, autoWinner: null,
      p1FromMatchId: null, p2FromMatchId: null,
      p1IsLoserOf: false, p2IsLoserOf: false,
      winnerGoesToMatchId: null, winnerGoesToSlot: null,
      loserGoesToMatchId:  null, loserGoesToSlot:  null,
      ...extra,
    };
    return id;
  };

  // ── Seeding ──────────────────────────────────────────────────────────────
  // Seeds 1..mainSize enter WB R1 directly.
  // Seeds mainSize+1..n play prelim matches.
  // Convention: bottom seeds play prelims against each other;
  // winners take the spots of seeds (mainSize - overflow + 1)..mainSize in WB R1.

  // WB R1 slots: array of mainSize entries, each either a player name or
  // { fromPrelimMatchId } meaning the winner of a prelim fills this slot.
  const wbR1Slots = []; // length = mainSize / 2 matches

  // Players seeded directly into WB R1 (top seeds): players[0..mainSize-overflow-1]
  const directPlayers = players.slice(0, mainSize - overflow);
  // Players who play prelims (bottom seeds): players[mainSize-overflow..n-1]
  const prelimPlayers = players.slice(mainSize - overflow);

  // ── Prelim Round ─────────────────────────────────────────────────────────
  const prelimRound = [];
  // Pair prelim players. If odd count, last one gets a BYE.
  const needsBye = prelimPlayers.length % 2 === 1;
  const prelimPairs = [];
  for (let i = 0; i + 1 < prelimPlayers.length; i += 2) {
    prelimPairs.push([prelimPlayers[i], prelimPlayers[i+1]]);
  }
  if (needsBye) {
    // Last prelim player gets a bye — pair with null
    prelimPairs.push([prelimPlayers[prelimPlayers.length - 1], null]);
  }

  for (const [a, b] of prelimPairs) {
    const isBye   = !b;
    const auto    = isBye ? a : null;
    const id = newMatch({
      p1: a, p2: isBye ? "BYE" : b,
      isPrelim: true, isBye, autoWinner: auto, winner: auto,
    });
    prelimRound.push(id);
  }

  // ── Build WB R1 ──────────────────────────────────────────────────────────
  // WB R1 has mainSize/2 matches.
  // Seeding: match i pairs seed (i+1) vs seed (mainSize - i).
  // Bottom seeds (mainSize - overflow + 1 .. mainSize) are replaced by prelim winners.

  // Build a list of mainSize "seed slots" — either a player name or a prelim match id
  const seedSlots = [
    ...directPlayers,                          // seeds 1..mainSize-overflow
    ...prelimRound.map(id => ({ fromPrelim: id })), // seeds mainSize-overflow+1..mainSize
  ];
  // seedSlots.length === mainSize

  const wbR1 = [];
  for (let i = 0; i < mainSize / 2; i++) {
    const topSlot = seedSlots[i];
    const botSlot = seedSlots[mainSize - 1 - i];

    const id = newMatch();
    const m  = matchMap[id];

    // Fill p1
    if (typeof topSlot === 'string') {
      m.p1 = topSlot;
    } else {
      // Winner of a prelim match fills this slot
      matchMap[topSlot.fromPrelim].winnerGoesToMatchId = id;
      matchMap[topSlot.fromPrelim].winnerGoesToSlot    = 'p1';
      m.p1FromMatchId = topSlot.fromPrelim;
      // If it was a BYE prelim, pre-populate
      if (matchMap[topSlot.fromPrelim].autoWinner) {
        m.p1 = matchMap[topSlot.fromPrelim].autoWinner;
      }
    }

    // Fill p2
    if (typeof botSlot === 'string') {
      m.p2 = botSlot;
    } else {
      matchMap[botSlot.fromPrelim].winnerGoesToMatchId = id;
      matchMap[botSlot.fromPrelim].winnerGoesToSlot    = 'p2';
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
      matchMap[prev[i]].winnerGoesToSlot      = 'p1';
      matchMap[prev[i+1]].winnerGoesToMatchId = id;
      matchMap[prev[i+1]].winnerGoesToSlot    = 'p2';
      matchMap[id].p1FromMatchId = prev[i];
      matchMap[id].p2FromMatchId = prev[i+1];
      round.push(id);
    }
    winnersRounds.push(round);
    prev = round;
  }

  // ── Losers Bracket ───────────────────────────────────────────────────────
  // All prelim losers + all WB R1 losers enter a pool.
  // We run pairing rounds (with BYEs for odd sizes) until the pool is small
  // enough to merge 1-for-1 with WB R2 drop-ins, then continue alternating
  // merge and battle rounds until 1 LB survivor remains.
  //
  // Key: a feeder is { fromMatch, isLoser } — winner or loser of a prior match.
  // BYE matches auto-advance one player (p2='BYE', winner set immediately).

  const losersRounds = [];
  const wbRoundsForLosers = winnersRounds.slice(0, -1); // exclude WB Final

  // Build initial pool: prelim losers first, then WB R1 losers
  // prelim losers: loser of each real prelim match (skip BYE prelims — no real loser)
  // WB R1 losers: loser of every WB R1 match
  let lbPool = [
    ...prelimRound
      .filter(id => !matchMap[id].isBye)
      .map(id => ({ fromMatch: id, isLoser: true })),
    ...wbR1.map(id => ({ fromMatch: id, isLoser: true })),
  ];

  // Helper: wire two feeders into a new match, return match id
  const makeMatch = (fa, fb) => {
    const id = newMatch();
    const slotA = fa.isLoser ? 'loser' : 'winner';
    matchMap[fa.fromMatch][slotA + 'GoesToMatchId'] = id;
    matchMap[fa.fromMatch][slotA + 'GoesToSlot']    = 'p1';
    matchMap[id].p1FromMatchId = fa.fromMatch;
    matchMap[id].p1IsLoserOf   = fa.isLoser;
    const slotB = fb.isLoser ? 'loser' : 'winner';
    matchMap[fb.fromMatch][slotB + 'GoesToMatchId'] = id;
    matchMap[fb.fromMatch][slotB + 'GoesToSlot']    = 'p2';
    matchMap[id].p2FromMatchId = fb.fromMatch;
    matchMap[id].p2IsLoserOf   = fb.isLoser;
    return id;
  };

  // Helper: pair a pool of feeders into matches. Odd one out gets a BYE match
  // (auto-winner), so it advances to the next round as a winner feeder.
  // Returns { matchIds, nextPool } where nextPool are winner-feeders from this round.
  const pairPool = (pool) => {
    const matchIds = [];
    const nextPool = [];
    for (let i = 0; i + 1 < pool.length; i += 2) {
      const id = makeMatch(pool[i], pool[i + 1]);
      matchIds.push(id);
      nextPool.push({ fromMatch: id, isLoser: false });
    }
    if (pool.length % 2 === 1) {
      // Odd player out: BYE match — pre-set p2='BYE', winner propagates when p1 arrives
      const fa = pool[pool.length - 1];
      const id = newMatch({ isBye: true, p2: 'BYE' });
      const slotA = fa.isLoser ? 'loser' : 'winner';
      matchMap[fa.fromMatch][slotA + 'GoesToMatchId'] = id;
      matchMap[fa.fromMatch][slotA + 'GoesToSlot']    = 'p1';
      matchMap[id].p1FromMatchId = fa.fromMatch;
      matchMap[id].p1IsLoserOf   = fa.isLoser;
      matchIds.push(id);
      nextPool.push({ fromMatch: id, isLoser: false });
    }
    return { matchIds, nextPool };
  };

  // Reduce lbPool until its size === wbRoundsForLosers[1].length (i.e. wbR2 size),
  // which is always wbR1.length / 2.
  // Each pairPool round halves the pool (ceil division due to BYE for odd).
  const targetSize = wbRoundsForLosers.length > 1 ? wbRoundsForLosers[1].length : 1;

  while (lbPool.length > targetSize) {
    const { matchIds, nextPool } = pairPool(lbPool);
    losersRounds.push(matchIds);
    lbPool = nextPool;
  }

  // lbPool now has exactly targetSize feeders (all winners of prior LB rounds).
  // Alternate: merge round (vs WB drop-ins) then battle round.
  for (let wIdx = 1; wIdx < wbRoundsForLosers.length; wIdx++) {
    const dropIns = wbRoundsForLosers[wIdx];

    // Merge: each lbPool winner faces a WB drop-in loser
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

    if (lbPool.length === 1) break; // LB Final feeder — stop here

    // Battle: survivors play each other (halves the pool)
    const { matchIds: battleIds, nextPool: afterBattle } = pairPool(lbPool);
    losersRounds.push(battleIds);
    lbPool = afterBattle;
  }


  // ── Grand Final ──────────────────────────────────────────────────────────
  const gfId = newMatch({ isGrandFinal: true });
  const wbFinalId = winnersRounds[winnersRounds.length - 1][0];
  matchMap[wbFinalId].winnerGoesToMatchId = gfId;
  matchMap[wbFinalId].winnerGoesToSlot    = 'p1';
  matchMap[gfId].p1FromMatchId = wbFinalId;

  if (losersRounds.length) {
    const lbFinalId = losersRounds[losersRounds.length - 1][0];
    matchMap[lbFinalId].winnerGoesToMatchId = gfId;
    matchMap[lbFinalId].winnerGoesToSlot    = 'p2';
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

// ─── State engine: record a result ───────────────────────────────────────────
function propagate(matchMap, matchId, winner, loser) {
  const m = matchMap[matchId];
  const updated = { ...matchMap, [matchId]: { ...m, winner, loser: loser ?? null } };
  if (m.winnerGoesToMatchId) {
    const dest = updated[m.winnerGoesToMatchId];
    const next = { ...dest, [m.winnerGoesToSlot]: winner };
    updated[m.winnerGoesToMatchId] = next;
    // If dest was a BYE match and now has its real player, auto-resolve it
    if (dest.isBye) {
      return propagate(updated, m.winnerGoesToMatchId, winner, null);
    }
  }
  if (m.loserGoesToMatchId) {
    const dest = updated[m.loserGoesToMatchId];
    const next = { ...dest, [m.loserGoesToSlot]: loser };
    updated[m.loserGoesToMatchId] = next;
    // If dest was a BYE match and now has its real player, auto-resolve it
    if (dest.isBye) {
      return propagate(updated, m.loserGoesToMatchId, loser, null);
    }
  }
  return updated;
}

function recordWinner(matchMap, matchId, winner) {
  const m = matchMap[matchId];
  if (!m || m.isBye) return matchMap;
  if (!m.p1 || !m.p2) return matchMap; // not ready
  const loser = winner === m.p1 ? m.p2 : m.p1;
  return propagate(matchMap, matchId, winner, loser);
}

// ─── Helper: describe where a slot's player comes from ───────────────────────
function slotLabel(matchMap, matchId, slot) {
  const m = matchMap[matchId];
  const fromId = slot === 'p1' ? m.p1FromMatchId : m.p2FromMatchId;
  const isLoser = slot === 'p1' ? m.p1IsLoserOf  : m.p2IsLoserOf;
  if (!fromId) return null;
  const src = matchMap[fromId];
  return isLoser
    ? `Loser of Match ${src.matchNum}`
    : `Winner of Match ${src.matchNum}`;
}

// ─── MatchCard ────────────────────────────────────────────────────────────────
function MatchCard({ matchId, matchMap, onPickWinner, isLosers, isGrandFinal }) {
  const m = matchMap[matchId];
  const accent = isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE;

  const players = [
    { player: m.p1, slot: 'p1' },
    { player: m.p2, slot: 'p2' },
  ];

  const ready   = m.p1 && m.p2 && !m.winner && !m.isBye && m.p1 !== "BYE" && m.p2 !== "BYE";
  const settled = !!m.winner;

  const headerLabel = isGrandFinal ? "GRAND FINAL"
    : isLosers ? `LB · MATCH ${m.matchNum}`
    : `MATCH ${m.matchNum}`;

  return (
    <div style={{
      background: CARD,
      border: `1px solid ${settled ? accent + "55" : BORDER}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10,
      minWidth: 170,
      width: 170,
      fontFamily: "'SF Pro Display', -apple-system, system-ui, sans-serif",
      boxShadow: isGrandFinal && settled ? `0 0 24px ${GOLD}44` : "none",
      overflow: "hidden",
    }}>
      {/* Header */}
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
        {ready && <span style={{ color: MUTED, fontSize: 8 }}>TAP TO PICK</span>}
        {settled && <span style={{ fontSize: 8, color: GREEN }}>✓ DONE</span>}
      </div>

      {/* Player rows */}
      {players.map(({ player, slot }, i) => {
        const fromLabel = !player ? slotLabel(matchMap, matchId, slot) : null;
        const isWinner  = settled && m.winner === player;
        const isLoserP  = settled && m.loser  === player;
        const canTap    = ready && !!player && player !== "BYE";

        return (
          <div
            key={slot}
            onClick={() => canTap && onPickWinner(matchId, player)}
            style={{
              padding: "9px 10px 8px",
              borderBottom: i === 0 ? `1px solid ${BORDER}` : "none",
              background: isWinner ? `${accent}22` : isLoserP ? "#ffffff08" : "transparent",
              cursor: canTap ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              gap: 7,
              transition: "background 0.15s",
              minHeight: 42,
            }}
          >
            {/* Win indicator */}
            {isWinner && (
              <span style={{ fontSize: 9, color: accent, flexShrink: 0 }}>▶</span>
            )}
            {isLoserP && (
              <span style={{ fontSize: 9, color: MUTED, flexShrink: 0 }}>✕</span>
            )}
            {!isWinner && !isLoserP && (
              <span style={{ width: 14, flexShrink: 0 }} />
            )}

            <div style={{ overflow: "hidden", flex: 1 }}>
              {player && player !== "BYE" ? (
                <div style={{
                  fontSize: 13,
                  fontWeight: isWinner ? 700 : 400,
                  color: isLoserP ? MUTED : TEXT,
                  textDecoration: isLoserP ? "line-through" : "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {player}
                </div>
              ) : player === "BYE" ? (
                <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>BYE</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>TBD</div>
                  {fromLabel && (
                    <div style={{
                      fontSize: 9,
                      color: isLosers ? BLUE + "bb" : MUTED,
                      fontFamily: "monospace",
                      marginTop: 1,
                      letterSpacing: "0.03em",
                    }}>
                      {fromLabel}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Tap hint on ready matches */}
            {canTap && (
              <span style={{
                fontSize: 18,
                color: `${accent}55`,
                flexShrink: 0,
                lineHeight: 1,
              }}>›</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── RoundCol ─────────────────────────────────────────────────────────────────
function RoundCol({ title, matchIds, matchMap, onPickWinner, isLosers, isGrandFinal, spacing }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{
        fontSize: 9,
        fontFamily: "monospace",
        color: isGrandFinal ? GOLD : isLosers ? BLUE : PURPLE,
        letterSpacing: "0.15em",
        fontWeight: 700,
        marginBottom: 12,
        textTransform: "uppercase",
        paddingLeft: 2,
      }}>{title}</div>

      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing ?? 16,
        justifyContent: "space-around",
        flex: 1,
      }}>
        {(Array.isArray(matchIds) ? matchIds : [matchIds]).map(id => (
          <MatchCard
            key={id}
            matchId={id}
            matchMap={matchMap}
            onPickWinner={onPickWinner}
            isLosers={isLosers}
            isGrandFinal={isGrandFinal}
          />
        ))}
      </div>
    </div>
  );
}

// ─── SetupScreen ──────────────────────────────────────────────────────────────
function SetupScreen({ onGenerate }) {
  const [count, setCount] = useState(8);
  const [names, setNames] = useState(
    Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`)
  );

  const updateCount = (n) => {
    const c = Math.max(2, Math.min(64, n));
    setCount(c);
    setNames(prev => {
      const next = [...prev];
      while (next.length < c) next.push(`Player ${next.length + 1}`);
      return next.slice(0, c);
    });
  };

  const [grandFinalEnabled, setGrandFinalEnabled] = useState(true);
  const byes = nextPow2(count) - count;
  const perfect = isPow2(count);

  return (
    <div style={{ minHeight:"100vh", background:BG, color:TEXT,
      fontFamily:"'SF Pro Display',-apple-system,system-ui,sans-serif",
      paddingBottom: 160 }}>

      {/* Header */}
      <div style={{ background:CARD, borderBottom:`1px solid ${BORDER}`,
        padding:"20px 20px 14px", position:"sticky", top:0, zIndex:10 }}>
        <div style={{ fontSize:10, fontFamily:"monospace", color:GOLD,
          letterSpacing:"0.2em", marginBottom:4 }}>DOUBLE ELIMINATION</div>
        <div style={{ fontSize:26, fontWeight:700, letterSpacing:"-0.5px" }}>
          Tournament Builder
        </div>
      </div>

      <div style={{ padding:"24px 20px 0" }}>
        {/* Count picker */}
        <div style={{ marginBottom:28 }}>
          <div style={{ fontSize:10, fontFamily:"monospace", color:MUTED,
            letterSpacing:"0.1em", marginBottom:12, textTransform:"uppercase" }}>
            Number of Players
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
            {["-","+"].map((sym, di) => (
              <button key={sym} onClick={() => updateCount(count + (di ? 1 : -1))}
                style={{ width:44, height:44, background:CARD2,
                  border:`1px solid ${BORDER}`, borderRadius:10,
                  color:TEXT, fontSize:22, cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                {sym}
              </button>
            ))}
            <div style={{ flex:1, textAlign:"center", fontSize:38,
              fontWeight:700, color:GOLD, fontFamily:"monospace" }}>{count}</div>
          </div>
          <div style={{ marginTop:10, fontSize:11, color: perfect ? GREEN : MUTED,
            textAlign:"center", fontFamily:"monospace" }}>
            {perfect
              ? "✓ Perfect bracket — no prelim needed"
              : (() => {
                  let mainSz = 1;
                  while (mainSz * 2 <= count) mainSz *= 2;
                  const ov = count - mainSz;
                  const prelims = Math.ceil(ov / 2);
                  return `Prelim round: ${prelims} match${prelims>1?"es":""} → clean ${mainSz}-player bracket`;
                })()
          }
          </div>
        </div>

        {/* Names */}
        <div>
          <div style={{ fontSize:10, fontFamily:"monospace", color:MUTED,
            letterSpacing:"0.1em", marginBottom:12, textTransform:"uppercase" }}>
            Player Names
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {names.map((name, i) => (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:28, height:28, borderRadius:6, background:CARD2,
                  border:`1px solid ${BORDER}`, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:10, fontFamily:"monospace",
                  color:MUTED, flexShrink:0 }}>{i+1}</div>
                <input
                  value={name}
                  onChange={e => {
                    const n=[...names]; n[i]=e.target.value; setNames(n);
                  }}
                  placeholder={`Player ${i+1}`}
                  style={{ flex:1, background:CARD2, border:`1px solid ${BORDER}`,
                    borderRadius:10, padding:"10px 14px", color:TEXT,
                    fontSize:15, outline:"none", fontFamily:"inherit" }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Grand Final toggle — scrollable, above the fixed button */}
      <div style={{ padding:"24px 20px 8px" }}>
        <div style={{ fontSize:10, fontFamily:"monospace", color:MUTED,
          letterSpacing:"0.1em", marginBottom:12, textTransform:"uppercase" }}>
          Format
        </div>
        <div onClick={() => setGrandFinalEnabled(v => !v)}
          style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
            background:CARD2, border:`1px solid ${grandFinalEnabled ? GOLD+"66" : BORDER}`,
            borderRadius:12, padding:"12px 14px", cursor:"pointer" }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:TEXT }}>Grand Final</div>
            <div style={{ fontSize:11, color:MUTED, marginTop:3 }}>
              {grandFinalEnabled ? "LB winner faces WB winner" : "WB winner is champion"}
            </div>
          </div>
          <div style={{
            width:44, height:26, borderRadius:13,
            background: grandFinalEnabled ? GOLD : BORDER,
            position:"relative", transition:"background 0.2s", flexShrink:0 }}>
            <div style={{
              position:"absolute", top:4,
              left: grandFinalEnabled ? 22 : 4,
              width:18, height:18, borderRadius:9,
              background:"#fff",
              transition:"left 0.2s" }} />
          </div>
        </div>
      </div>

      {/* Generate */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0,
        padding:"16px 20px",
        background:`linear-gradient(to top, ${BG} 80%, transparent)` }}>
        <button
          onClick={() => onGenerate(names.map(n => n.trim() || null).filter(Boolean), grandFinalEnabled)}
          style={{ width:"100%", padding:"16px", background:GOLD,
            border:"none", borderRadius:14, color:"#0D0F14",
            fontSize:16, fontWeight:700, cursor:"pointer",
            letterSpacing:"0.02em", fontFamily:"inherit" }}>
          Generate Bracket →
        </button>
      </div>
    </div>
  );
}

// ─── BracketScreen ────────────────────────────────────────────────────────────
function BracketScreen({ players, onBack, grandFinalEnabled = true }) {
  const initial = useMemo(() => buildBracket(players), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [matchMap, setMatchMap] = useState(() => initial.matchMap);
  const { winnersRounds, losersRounds, grandFinalId, prelimRound } = initial;
  const allWbRounds = prelimRound ? [prelimRound, ...winnersRounds] : winnersRounds;

  const handlePick = useCallback((matchId, winner) => {
    setMatchMap(prev => recordWinner(prev, matchId, winner));
  }, []);

  const totalMatches = Object.keys(matchMap).length;
  const doneCount    = Object.values(matchMap).filter(m => m.winner).length;
  // Champion: GF winner if enabled, otherwise WB Final winner
  const wbFinalId  = winnersRounds[winnersRounds.length - 1][0];
  const champion   = grandFinalEnabled
    ? matchMap[grandFinalId]?.winner
    : matchMap[wbFinalId]?.winner;

  const [activeTab, setActiveTab] = useState("wb");

  const wbLabel = (i, total) => {
    if (prelimRound && i === 0) return "WB PRELIM";
    const adj = prelimRound ? i - 1 : i;
    if (i === total - 1) return "WB FINAL";
    return adj === 0 ? "WB ROUND 1" : `WB ROUND ${adj + 1}`;
  };

  const lbLabel = (i, total) => {
    if (i === total - 1) return "LB FINAL";
    // If there's a LB Prelim, round 0 is "LB PRELIM", round 1 is "LB R1", etc.
    const hasPrelim = losersRounds.length > 0 &&
      losersRounds[0].some(id => matchMap[id].isLBPrelim);
    if (hasPrelim) {
      if (i === 0) return "LB PRELIM";
      return i === 1 ? "LB ROUND 1" : `LB ROUND ${i}`;
    }
    return i === 0 ? "LB ROUND 1" : `LB ROUND ${i+1}`;
  };

  return (
    <div style={{ minHeight:"100vh", background:BG, color:TEXT,
      fontFamily:"'SF Pro Display',-apple-system,system-ui,sans-serif" }}>

      {/* Header */}
      <div style={{ background:CARD, borderBottom:`1px solid ${BORDER}`,
        padding:"14px 16px", position:"sticky", top:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button onClick={onBack} style={{ background:CARD2,
            border:`1px solid ${BORDER}`, borderRadius:8, color:TEXT,
            padding:"6px 12px", cursor:"pointer", fontSize:13,
            fontFamily:"inherit", flexShrink:0 }}>← Back</button>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:9, fontFamily:"monospace", color:GOLD,
              letterSpacing:"0.2em" }}>DOUBLE ELIMINATION</div>
            <div style={{ fontSize:15, fontWeight:700 }}>
              {players.length} Players · {doneCount}/{totalMatches} matches
            </div>
          </div>
          {champion && (
            <div style={{ flexShrink:0, textAlign:"right" }}>
              <div style={{ fontSize:8, fontFamily:"monospace", color:GOLD,
                letterSpacing:"0.1em" }}>CHAMPION</div>
              <div style={{ fontSize:12, fontWeight:700, color:GOLD,
                maxWidth:80, overflow:"hidden", textOverflow:"ellipsis",
                whiteSpace:"nowrap" }}>{champion}</div>
            </div>
          )}
        </div>

        {/* Progress bar */}
        <div style={{ marginTop:10, height:3, background:BORDER, borderRadius:2 }}>
          <div style={{ height:"100%", borderRadius:2, background:GOLD,
            width:`${totalMatches ? (doneCount/totalMatches)*100 : 0}%`,
            transition:"width 0.3s" }} />
        </div>

        {/* Tabs */}
        <div style={{ display:"flex", gap:6, marginTop:12 }}>
          {[
            { key:"wb", label:"Winners", color: PURPLE },
            { key:"lb", label:"Losers",  color: BLUE },
            ...(grandFinalEnabled ? [{ key:"gf", label:"Final", color: GOLD }] : []),
          ].map(({ key, label, color }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              style={{ flex:1, padding:"6px 0",
                background: activeTab===key ? `${color}22` : "transparent",
                border:`1px solid ${activeTab===key ? color : BORDER}`,
                borderRadius:8, color: activeTab===key ? color : MUTED,
                fontSize:12, fontWeight:700, cursor:"pointer",
                fontFamily:"monospace", letterSpacing:"0.05em" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:16, padding:"10px 16px",
        borderBottom:`1px solid ${BORDER}`, background:CARD,
        flexWrap:"wrap" }}>
        {[
          { color:PURPLE, label:"Winners" },
          { color:BLUE,   label:"Losers" },
          { color:GOLD,   label:"Grand Final" },
          { color:GREEN,  label:"Complete" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display:"flex", alignItems:"center",
            gap:5, fontSize:10, color:MUTED }}>
            <div style={{ width:8, height:8, borderRadius:2, background:color }} />
            {label}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ overflowX:"auto", padding:"20px 16px 120px" }}>

        {/* Winners Bracket */}
        {activeTab === "wb" && (
          <div style={{ display:"flex", gap:32, alignItems:"flex-start" }}>
            {allWbRounds.map((round, i) => (
              <RoundCol
                key={i}
                title={wbLabel(i, allWbRounds.length)}
                matchIds={round}
                matchMap={matchMap}
                onPickWinner={handlePick}
                isLosers={false}
                spacing={i === 0 ? 16 : 16 * Math.pow(2, Math.max(0, i - (prelimRound ? 1 : 0)))}
              />
            ))}
          </div>
        )}

        {/* Losers Bracket */}
        {activeTab === "lb" && (
          losersRounds.length === 0
            ? <div style={{ color:MUTED, padding:20, fontStyle:"italic" }}>
                No losers bracket (2 players)
              </div>
            : <div style={{ display:"flex", gap:32, alignItems:"flex-start" }}>
                {losersRounds.map((round, i) => (
                  <RoundCol
                    key={i}
                    title={lbLabel(i, losersRounds.length)}
                    matchIds={round}
                    matchMap={matchMap}
                    onPickWinner={handlePick}
                    isLosers={true}
                    spacing={16}
                  />
                ))}
              </div>
        )}

        {/* Grand Final */}
        {activeTab === "gf" && grandFinalEnabled && (
          <div>
            <div style={{ fontSize:11, fontFamily:"monospace", color:GOLD,
              letterSpacing:"0.15em", marginBottom:20,
              padding:"8px 0 8px", borderBottom:`1px solid ${GOLD}33` }}>
              ◆ GRAND FINAL
            </div>
            <div style={{ marginBottom:16, fontSize:12, color:MUTED }}>
              WB Finalist vs LB Champion — first to lose drops out entirely.
            </div>
            <MatchCard
              matchId={grandFinalId}
              matchMap={matchMap}
              onPickWinner={handlePick}
              isLosers={false}
              isGrandFinal={true}
            />
            {champion && (
              <div style={{ marginTop:28, padding:20, background:`${GOLD}11`,
                border:`1px solid ${GOLD}55`, borderRadius:12,
                textAlign:"center",
                boxShadow:`0 0 32px ${GOLD}22` }}>
                <div style={{ fontSize:10, fontFamily:"monospace",
                  color:GOLD, letterSpacing:"0.2em", marginBottom:8 }}>
                  🏆 TOURNAMENT CHAMPION
                </div>
                <div style={{ fontSize:28, fontWeight:700, color:GOLD }}>
                  {champion}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No Grand Final — WB winner is champion */}
        {!grandFinalEnabled && champion && (
          <div style={{ marginTop:16, padding:20, background:`${GOLD}11`,
            border:`1px solid ${GOLD}55`, borderRadius:12,
            textAlign:"center", boxShadow:`0 0 32px ${GOLD}22` }}>
            <div style={{ fontSize:10, fontFamily:"monospace",
              color:GOLD, letterSpacing:"0.2em", marginBottom:8 }}>
              🏆 TOURNAMENT CHAMPION
            </div>
            <div style={{ fontSize:28, fontWeight:700, color:GOLD }}>
              {champion}
            </div>
          </div>
        )}
      </div>

      {/* Quick next match prompt */}
      {activeTab !== "gf" && (() => {
        const allIds = activeTab === "wb"
          ? winnersRounds.flat()
          : losersRounds.flat();
        const next = allIds.find(id => {
          const m = matchMap[id];
          return m.p1 && m.p2 && !m.winner && !m.isBye;
        });
        if (!next) return null;
        const m = matchMap[next];
        return (
          <div style={{ position:"fixed", bottom:0, left:0, right:0,
            background:`linear-gradient(to top, ${BG} 60%, transparent)`,
            padding:"20px 16px 16px" }}>
            <div style={{ background:CARD2, border:`1px solid ${BORDER}`,
              borderRadius:12, padding:"12px 14px",
              display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontSize:9, fontFamily:"monospace",
                  color:activeTab==="wb"?PURPLE:BLUE,
                  letterSpacing:"0.1em", marginBottom:4 }}>
                  NEXT UP · MATCH {m.matchNum}
                </div>
                <div style={{ fontSize:13, fontWeight:600 }}>
                  {m.p1} <span style={{ color:MUTED, fontWeight:400 }}>vs</span> {m.p2}
                </div>
              </div>
              <div style={{ fontSize:10, color:MUTED, fontFamily:"monospace" }}>
                Tap players above ↑
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]     = useState("setup");
  const [players, setPlayers]   = useState([]);
  const [grandFinal, setGrandFinal] = useState(true);

  if (screen === "setup") {
    return (
      <SetupScreen
        onGenerate={(names, gf) => {
          setPlayers(names);
          setGrandFinal(gf);
          setScreen("bracket");
        }}
      />
    );
  }
  return (
    <BracketScreen
      players={players}
      grandFinalEnabled={grandFinal}
      onBack={() => setScreen("setup")}
    />
  );
}
