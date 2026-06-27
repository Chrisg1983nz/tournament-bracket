import { useState, useCallback } from "react";

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

/**
 * Builds the full double-elimination structure.
 * Returns:
 *   matchMap: { [id]: match }
 *   winnersRounds: id[][]
 *   losersRounds:  id[][]
 *   grandFinalId:  id
 *
 * Each match:
 *   { id, matchNum, p1, p2, winner, loser,
 *     isBye, autoWinner,
 *     // who feeds into this match's slots:
 *     p1FromMatchId, p2FromMatchId,
 *     p1IsLoserOf, p2IsLoserOf,   // true = "loser of match X drops in"
 *     // where results flow:
 *     winnerGoesToMatchId, winnerGoesToSlot,   // 'p1'|'p2'
 *     loserGoesToMatchId,  loserGoesToSlot,
 *   }
 */
function buildBracket(players) {
  const size   = nextPow2(players.length);
  const padded = [...players];
  while (padded.length < size) padded.push(null); // null = BYE

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
      isBye: false, autoWinner: null,
      p1FromMatchId: null, p2FromMatchId: null,
      p1IsLoserOf: false, p2IsLoserOf: false,
      winnerGoesToMatchId: null, winnerGoesToSlot: null,
      loserGoesToMatchId: null,  loserGoesToSlot: null,
      ...extra,
    };
    return id;
  };

  // ── Winners Bracket Round 1 ──────────────────────────────────────────────
  // Seeding: 1 vs size, 2 vs size-1, ...
  const wbR1 = [];
  for (let i = 0; i < size / 2; i++) {
    const a = padded[i];
    const b = padded[size - 1 - i];
    const isBye = !a || !b;
    const auto  = isBye ? (a || b) : null;
    const p1display = a || "BYE";
    const p2display = b || "BYE";
    const id = newMatch({ p1: p1display, p2: p2display, isBye, autoWinner: auto, winner: auto });
    wbR1.push(id);
  }

  // ── Winners Bracket subsequent rounds ────────────────────────────────────
  const winnersRounds = [wbR1];
  let prev = wbR1;
  while (prev.length > 1) {
    const round = [];
    for (let i = 0; i < prev.length; i += 2) {
      const id = newMatch();
      matchMap[prev[i]].winnerGoesToMatchId  = id;
      matchMap[prev[i]].winnerGoesToSlot     = 'p1';
      matchMap[prev[i+1]].winnerGoesToMatchId = id;
      matchMap[prev[i+1]].winnerGoesToSlot   = 'p2';
      matchMap[id].p1FromMatchId = prev[i];
      matchMap[id].p2FromMatchId = prev[i+1];
      round.push(id);
    }
    winnersRounds.push(round);
    prev = round;
  }
  // The very last WB match is the WB Final (not grand final yet)

  // ── Losers Bracket ───────────────────────────────────────────────────────
  // Structure:
  //   LBR1: losers of WBR1 play each other
  //   LBR2: LBR1 winners vs losers of WBR2
  //   LBR3: LBR2 survivors play each other
  //   LBR4: LBR3 winners vs losers of WBR3
  //   ... pattern: merge-then-battle repeats

  const losersRounds = [];
  const wbRoundsForLosers = winnersRounds.slice(0, -1); // all WB rounds except the final

  // LBR1: pair up the WBR1 losers
  const lbR1 = [];
  const wbR1Losers = wbR1; // losers come from WBR1 matches
  for (let i = 0; i < wbR1Losers.length; i += 2) {
    const id = newMatch();
    // slot p1 = loser of wbR1[i], slot p2 = loser of wbR1[i+1]
    matchMap[wbR1Losers[i]].loserGoesToMatchId  = id;
    matchMap[wbR1Losers[i]].loserGoesToSlot     = 'p1';
    matchMap[wbR1Losers[i+1]].loserGoesToMatchId = id;
    matchMap[wbR1Losers[i+1]].loserGoesToSlot   = 'p2';
    matchMap[id].p1FromMatchId = wbR1Losers[i];
    matchMap[id].p2FromMatchId = wbR1Losers[i+1];
    matchMap[id].p1IsLoserOf   = true;
    matchMap[id].p2IsLoserOf   = true;
    lbR1.push(id);
  }
  if (lbR1.length) losersRounds.push(lbR1);

  // Subsequent LB rounds
  for (let wIdx = 1; wIdx < wbRoundsForLosers.length; wIdx++) {
    const dropIns = wbRoundsForLosers[wIdx]; // WB losers dropping in

    // Merge round: prev LB winners vs new drop-ins
    const prevLB = losersRounds[losersRounds.length - 1];
    const mergeRound = [];
    for (let i = 0; i < prevLB.length; i++) {
      const id = newMatch();
      // p1 = winner of prev LB match
      matchMap[prevLB[i]].winnerGoesToMatchId = id;
      matchMap[prevLB[i]].winnerGoesToSlot    = 'p1';
      matchMap[id].p1FromMatchId = prevLB[i];
      matchMap[id].p1IsLoserOf   = false;
      // p2 = loser of WB match
      if (dropIns[i]) {
        matchMap[dropIns[i]].loserGoesToMatchId = id;
        matchMap[dropIns[i]].loserGoesToSlot    = 'p2';
        matchMap[id].p2FromMatchId = dropIns[i];
        matchMap[id].p2IsLoserOf   = true;
      }
      mergeRound.push(id);
    }
    losersRounds.push(mergeRound);

    // Battle round (if >1 match): merge survivors play each other
    if (mergeRound.length > 1) {
      const battleRound = [];
      for (let i = 0; i < mergeRound.length; i += 2) {
        const id = newMatch();
        matchMap[mergeRound[i]].winnerGoesToMatchId   = id;
        matchMap[mergeRound[i]].winnerGoesToSlot      = 'p1';
        matchMap[mergeRound[i+1]].winnerGoesToMatchId = id;
        matchMap[mergeRound[i+1]].winnerGoesToSlot    = 'p2';
        matchMap[id].p1FromMatchId = mergeRound[i];
        matchMap[id].p2FromMatchId = mergeRound[i+1];
        battleRound.push(id);
      }
      losersRounds.push(battleRound);
    }
  }

  // ── Grand Final ──────────────────────────────────────────────────────────
  const gfId = newMatch({ isGrandFinal: true });
  // p1 = WB finalist (winner of last WB round)
  const wbFinalId = winnersRounds[winnersRounds.length - 1][0];
  matchMap[wbFinalId].winnerGoesToMatchId = gfId;
  matchMap[wbFinalId].winnerGoesToSlot    = 'p1';
  matchMap[gfId].p1FromMatchId = wbFinalId;
  // p2 = LB champion (winner of last LB round)
  if (losersRounds.length) {
    const lbFinalId = losersRounds[losersRounds.length - 1][0];
    matchMap[lbFinalId].winnerGoesToMatchId = gfId;
    matchMap[lbFinalId].winnerGoesToSlot    = 'p2';
    matchMap[gfId].p2FromMatchId = lbFinalId;
  }

  // Pre-populate BYE auto-winners into next rounds
  for (const id of wbR1) {
    const m = matchMap[id];
    if (m.autoWinner && m.winnerGoesToMatchId) {
      matchMap[m.winnerGoesToMatchId][m.winnerGoesToSlot] = m.autoWinner;
    }
  }

  return { matchMap, winnersRounds, losersRounds, grandFinalId: gfId };
}

// ─── State engine: record a result ───────────────────────────────────────────
function recordWinner(matchMap, matchId, winner) {
  const m = matchMap[matchId];
  if (!m || m.isBye) return matchMap;
  if (m.p1 === null || m.p2 === null) return matchMap; // not ready

  const loser = winner === m.p1 ? m.p2 : m.p1;
  const updated = {
    ...matchMap,
    [matchId]: { ...m, winner, loser },
  };

  // Propagate winner forward
  if (m.winnerGoesToMatchId) {
    const dest = updated[m.winnerGoesToMatchId];
    updated[m.winnerGoesToMatchId] = { ...dest, [m.winnerGoesToSlot]: winner };
  }

  // Propagate loser to losers bracket
  if (m.loserGoesToMatchId) {
    const dest = updated[m.loserGoesToMatchId];
    updated[m.loserGoesToMatchId] = { ...dest, [m.loserGoesToSlot]: loser };
  }

  return updated;
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

  const byes = nextPow2(count) - count;
  const perfect = isPow2(count);

  return (
    <div style={{ minHeight:"100vh", background:BG, color:TEXT,
      fontFamily:"'SF Pro Display',-apple-system,system-ui,sans-serif",
      paddingBottom: 100 }}>

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
              ? "✓ Perfect bracket — no BYEs needed"
              : `Bracket size: ${nextPow2(count)}  ·  ${byes} BYE${byes>1?"s":""} added`}
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

      {/* Generate */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0,
        padding:"16px 20px",
        background:`linear-gradient(to top, ${BG} 70%, transparent)` }}>
        <button
          onClick={() => onGenerate(names.map(n => n.trim() || null).filter(Boolean))}
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
function BracketScreen({ players, onBack }) {
  const initial = buildBracket(players);
  const [matchMap, setMatchMap] = useState(initial.matchMap);
  const { winnersRounds, losersRounds, grandFinalId } = initial;

  const handlePick = useCallback((matchId, winner) => {
    setMatchMap(prev => recordWinner(prev, matchId, winner));
  }, []);

  const totalMatches = Object.keys(matchMap).length;
  const doneCount    = Object.values(matchMap).filter(m => m.winner).length;
  const champion     = matchMap[grandFinalId]?.winner;

  const [activeTab, setActiveTab] = useState("wb");

  const wbLabel = (i, total) =>
    i === total - 1 ? "WB FINAL" : i === 0 ? "WB ROUND 1" : `WB ROUND ${i+1}`;

  const lbLabel = (i, total) =>
    i === total - 1 ? "LB FINAL" : `LB ROUND ${i+1}`;

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
            { key:"gf", label:"Final",   color: GOLD },
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
            {winnersRounds.map((round, i) => (
              <RoundCol
                key={i}
                title={wbLabel(i, winnersRounds.length)}
                matchIds={round}
                matchMap={matchMap}
                onPickWinner={handlePick}
                isLosers={false}
                spacing={i === 0 ? 16 : 16 * Math.pow(2, i)}
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
        {activeTab === "gf" && (
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
  const [screen, setScreen]   = useState("setup");
  const [players, setPlayers] = useState([]);

  if (screen === "setup") {
    return (
      <SetupScreen
        onGenerate={names => {
          setPlayers(names);
          setScreen("bracket");
        }}
      />
    );
  }
  return (
    <BracketScreen
      players={players}
      onBack={() => setScreen("setup")}
    />
  );
}
