import { useState, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const GOLD   = "#F0B429";
const PURPLE = "#A78BFA";
const BLUE   = "#4A90D9";
const GREEN  = "#34D399";
const ORANGE = "#F97316";
const BG     = "#0D0F14";
const CARD   = "#1A1D24";
const CARD2  = "#22262F";
const BORDER = "#2E3340";
const TEXT   = "#E8EAF0";
const MUTED  = "#6B7280";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function isPow2(n)   { return n > 0 && (n & (n - 1)) === 0; }

// Fisher-Yates shuffle
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Bracket Builder ──────────────────────────────────────────────────────────
function buildBracket(players) {
  const shuffledPlayers = shuffleArray(players);
  const size = nextPow2(shuffledPlayers.length);
  const wbR1Size = size / 2;
  
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
      isPrelim: false,
      p1FromMatchId: null, p2FromMatchId: null,
      p1IsLoserOf: false, p2IsLoserOf: false,
      winnerGoesToMatchId: null, winnerGoesToSlot: null,
      loserGoesToMatchId: null,  loserGoesToSlot: null,
      ...extra,
    };
    return id;
  };

  // ── Calculate prelim structure ───────────────────────────────────────────
  let prelimRounds = [];
  let wbR1Seeds = [];
  
  if (shuffledPlayers.length <= wbR1Size) {
    // No prelims needed - all players go directly to WB R1
    for (let i = 0; i < shuffledPlayers.length; i++) {
      wbR1Seeds.push({ player: shuffledPlayers[i], fromMatchId: null });
    }
    // Pad remaining spots with null (will create uneven bracket)
    while (wbR1Seeds.length < wbR1Size) {
      wbR1Seeds.push({ player: null, fromMatchId: null });
    }
  } else {
    // We need prelim matches
    const numPrelimMatches = shuffledPlayers.length - wbR1Size;
    const numPrelimPlayers = numPrelimMatches * 2;
    
    const directPlayers = shuffledPlayers.slice(0, shuffledPlayers.length - numPrelimPlayers);
    const prelimPlayers = shuffledPlayers.slice(shuffledPlayers.length - numPrelimPlayers);
    
    // Create prelim matches
    const prelimR1 = [];
    for (let i = 0; i < numPrelimMatches; i++) {
      const p1 = prelimPlayers[i * 2];
      const p2 = prelimPlayers[i * 2 + 1];
      const id = newMatch({ p1, p2, isPrelim: true });
      prelimR1.push(id);
    }
    prelimRounds.push(prelimR1);
    
    // Build wbR1Seeds: interleave direct players and prelim winners
    let directIdx = 0;
    let prelimIdx = 0;
    for (let i = 0; i < wbR1Size; i++) {
      if (directIdx < directPlayers.length && (prelimIdx >= prelimR1.length || i % 2 === 0)) {
        wbR1Seeds.push({ player: directPlayers[directIdx++], fromMatchId: null });
      } else if (prelimIdx < prelimR1.length) {
        wbR1Seeds.push({ player: null, fromMatchId: prelimR1[prelimIdx++] });
      } else if (directIdx < directPlayers.length) {
        wbR1Seeds.push({ player: directPlayers[directIdx++], fromMatchId: null });
      } else {
        wbR1Seeds.push({ player: null, fromMatchId: null });
      }
    }
  }

  // ── Winners Bracket Round 1 ──────────────────────────────────────────────
  const wbR1 = [];
  for (let i = 0; i < wbR1Size / 2; i++) {
    const seedA = wbR1Seeds[i];
    const seedB = wbR1Seeds[wbR1Size - 1 - i];
    
    const id = newMatch();
    const m = matchMap[id];
    
    if (seedA.fromMatchId) {
      m.p1FromMatchId = seedA.fromMatchId;
      matchMap[seedA.fromMatchId].winnerGoesToMatchId = id;
      matchMap[seedA.fromMatchId].winnerGoesToSlot = 'p1';
    } else {
      m.p1 = seedA.player;
    }
    
    if (seedB.fromMatchId) {
      m.p2FromMatchId = seedB.fromMatchId;
      matchMap[seedB.fromMatchId].winnerGoesToMatchId = id;
      matchMap[seedB.fromMatchId].winnerGoesToSlot = 'p2';
    } else {
      m.p2 = seedB.player;
    }
    
    // Handle case where one player is null (shouldn't happen with prelims, but safety)
    if (m.p1 && !m.p2 && !m.p2FromMatchId) {
      m.isBye = true;
      m.autoWinner = m.p1;
      m.winner = m.p1;
    } else if (m.p2 && !m.p1 && !m.p1FromMatchId) {
      m.isBye = true;
      m.autoWinner = m.p2;
      m.winner = m.p2;
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
      matchMap[prev[i]].winnerGoesToMatchId = id;
      matchMap[prev[i]].winnerGoesToSlot = 'p1';
      matchMap[prev[i+1]].winnerGoesToMatchId = id;
      matchMap[prev[i+1]].winnerGoesToSlot = 'p2';
      matchMap[id].p1FromMatchId = prev[i];
      matchMap[id].p2FromMatchId = prev[i+1];
      round.push(id);
    }
    winnersRounds.push(round);
    prev = round;
  }

  // Pre-populate BYE auto-winners into next rounds
  for (const id of wbR1) {
    const m = matchMap[id];
    if (m.autoWinner && m.winnerGoesToMatchId) {
      matchMap[m.winnerGoesToMatchId][m.winnerGoesToSlot] = m.autoWinner;
    }
  }

  // ── Losers Bracket ───────────────────────────────────────────────────────
  const losersRounds = [];
  
  // Handle prelim losers first
  if (prelimRounds.length > 0 && prelimRounds[0].length >= 2) {
    const prelimR1 = prelimRounds[0];
    const lbPrelim = [];
    
    for (let i = 0; i < prelimR1.length; i += 2) {
      if (i + 1 < prelimR1.length) {
        const id = newMatch();
        matchMap[prelimR1[i]].loserGoesToMatchId = id;
        matchMap[prelimR1[i]].loserGoesToSlot = 'p1';
        matchMap[prelimR1[i + 1]].loserGoesToMatchId = id;
        matchMap[prelimR1[i + 1]].loserGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = prelimR1[i];
        matchMap[id].p2FromMatchId = prelimR1[i + 1];
        matchMap[id].p1IsLoserOf = true;
        matchMap[id].p2IsLoserOf = true;
        lbPrelim.push(id);
      }
    }
    if (lbPrelim.length > 0) {
      losersRounds.push(lbPrelim);
    }
  }

  // LB Round 1: WB R1 losers
  const wbR1Losers = wbR1.filter(id => !matchMap[id].isBye);
  
  if (losersRounds.length > 0 && wbR1Losers.length > 0) {
    // Merge WB R1 losers with prelim LB winners
    const prevLB = losersRounds[losersRounds.length - 1];
    const mergeRound = [];
    
    const maxLen = Math.max(wbR1Losers.length, prevLB.length);
    for (let i = 0; i < maxLen; i++) {
      const id = newMatch();
      
      if (i < wbR1Losers.length) {
        matchMap[wbR1Losers[i]].loserGoesToMatchId = id;
        matchMap[wbR1Losers[i]].loserGoesToSlot = 'p1';
        matchMap[id].p1FromMatchId = wbR1Losers[i];
        matchMap[id].p1IsLoserOf = true;
      }
      
      if (i < prevLB.length) {
        matchMap[prevLB[i]].winnerGoesToMatchId = id;
        matchMap[prevLB[i]].winnerGoesToSlot = 'p2';
        matchMap[id].p2FromMatchId = prevLB[i];
        matchMap[id].p2IsLoserOf = false;
      }
      
      mergeRound.push(id);
    }
    losersRounds.push(mergeRound);
    
    // Battle round if needed
    if (mergeRound.length > 1) {
      const battleRound = [];
      for (let i = 0; i < mergeRound.length; i += 2) {
        if (i + 1 < mergeRound.length) {
          const id = newMatch();
          matchMap[mergeRound[i]].winnerGoesToMatchId = id;
          matchMap[mergeRound[i]].winnerGoesToSlot = 'p1';
          matchMap[mergeRound[i + 1]].winnerGoesToMatchId = id;
          matchMap[mergeRound[i + 1]].winnerGoesToSlot = 'p2';
          matchMap[id].p1FromMatchId = mergeRound[i];
          matchMap[id].p2FromMatchId = mergeRound[i + 1];
          battleRound.push(id);
        }
      }
      if (battleRound.length > 0) {
        losersRounds.push(battleRound);
      }
    }
  } else if (wbR1Losers.length >= 2) {
    // No prelim rounds, standard LB R1
    const lbR1 = [];
    for (let i = 0; i < wbR1Losers.length; i += 2) {
      if (i + 1 < wbR1Losers.length) {
        const id = newMatch();
        matchMap[wbR1Losers[i]].loserGoesToMatchId = id;
        matchMap[wbR1Losers[i]].loserGoesToSlot = 'p1';
        matchMap[wbR1Losers[i + 1]].loserGoesToMatchId = id;
        matchMap[wbR1Losers[i + 1]].loserGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = wbR1Losers[i];
        matchMap[id].p2FromMatchId = wbR1Losers[i + 1];
        matchMap[id].p1IsLoserOf = true;
        matchMap[id].p2IsLoserOf = true;
        lbR1.push(id);
      }
    }
    if (lbR1.length) losersRounds.push(lbR1);
  }

  // Subsequent LB rounds from WB R2 onwards
  const wbRoundsForLosers = winnersRounds.slice(1, -1);

  for (let wIdx = 0; wIdx < wbRoundsForLosers.length; wIdx++) {
    const dropIns = wbRoundsForLosers[wIdx];
    const prevLB = losersRounds[losersRounds.length - 1];
    
    if (!prevLB || prevLB.length === 0) continue;

    // Merge round
    const mergeRound = [];
    for (let i = 0; i < prevLB.length; i++) {
      const id = newMatch();
      matchMap[prevLB[i]].winnerGoesToMatchId = id;
      matchMap[prevLB[i]].winnerGoesToSlot = 'p1';
      matchMap[id].p1FromMatchId = prevLB[i];
      matchMap[id].p1IsLoserOf = false;
      
      if (i < dropIns.length) {
        matchMap[dropIns[i]].loserGoesToMatchId = id;
        matchMap[dropIns[i]].loserGoesToSlot = 'p2';
        matchMap[id].p2FromMatchId = dropIns[i];
        matchMap[id].p2IsLoserOf = true;
      }
      mergeRound.push(id);
    }
    losersRounds.push(mergeRound);

    // Battle round
    if (mergeRound.length > 1) {
      const battleRound = [];
      for (let i = 0; i < mergeRound.length; i += 2) {
        if (i + 1 < mergeRound.length) {
          const id = newMatch();
          matchMap[mergeRound[i]].winnerGoesToMatchId = id;
          matchMap[mergeRound[i]].winnerGoesTo
