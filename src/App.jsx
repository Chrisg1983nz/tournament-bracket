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
  const n = shuffledPlayers.length;
  const targetSize = nextPow2(n); // e.g., 5 players -> 8, 6 players -> 8
  const numPrelimMatches = n - (targetSize / 2); // How many prelim matches needed
  // e.g., 5 players: 5 - 4 = 1 prelim match
  // e.g., 6 players: 6 - 4 = 2 prelim matches
  // e.g., 7 players: 7 - 4 = 3 prelim matches
  
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

  const prelimRounds = [];
  const wbR1Size = targetSize / 2; // Number of matches in WB Round 1
  
  // Players who play in prelims (2 players per prelim match)
  const numPrelimPlayers = numPrelimMatches * 2;
  // Players who go directly to Round 1
  const numDirectPlayers = n - numPrelimPlayers;
  
  // Split players: first ones go direct, rest play prelims
  const directPlayers = shuffledPlayers.slice(0, numDirectPlayers);
  const prelimPlayers = shuffledPlayers.slice(numDirectPlayers);
  
  // ── Create Prelim Matches ────────────────────────────────────────────────
  const prelimMatchIds = [];
  if (numPrelimMatches > 0) {
    for (let i = 0; i < numPrelimMatches; i++) {
      const p1 = prelimPlayers[i * 2];
      const p2 = prelimPlayers[i * 2 + 1];
      const id = newMatch({ p1, p2, isPrelim: true });
      prelimMatchIds.push(id);
    }
    prelimRounds.push(prelimMatchIds);
  }
  
  // ── Create Winners Bracket Round 1 ───────────────────────────────────────
  // Round 1 has wbR1Size matches
  // Some matches have 2 direct players, some have 1 direct + 1 prelim winner
  // 
  // With X direct players: X/2 matches are "full" (both players known)
  // Remaining matches wait for prelim winners
  
  const wbR1 = [];
  let directIdx = 0;
  let prelimIdx = 0;
  
  for (let i = 0; i < wbR1Size; i++) {
    const id = newMatch();
    const m = matchMap[id];
    
    // Determine p1
    if (directIdx < directPlayers.length) {
      m.p1 = directPlayers[directIdx++];
    } else if (prelimIdx < prelimMatchIds.length) {
      m.p1FromMatchId = prelimMatchIds[prelimIdx];
      matchMap[prelimMatchIds[prelimIdx]].winnerGoesToMatchId = id;
      matchMap[prelimMatchIds[prelimIdx]].winnerGoesToSlot = 'p1';
      prelimIdx++;
    }
    
    // Determine p2
    if (directIdx < directPlayers.length) {
      m.p2 = directPlayers[directIdx++];
    } else if (prelimIdx < prelimMatchIds.length) {
      m.p2FromMatchId = prelimMatchIds[prelimIdx];
      matchMap[prelimMatchIds[prelimIdx]].winnerGoesToMatchId = id;
      matchMap[prelimMatchIds[prelimIdx]].winnerGoesToSlot = 'p2';
      prelimIdx++;
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

  // ── Losers Bracket ───────────────────────────────────────────────────────
  const losersRounds = [];
  
  // Step 1: Prelim losers bracket round (if prelims exist)
  let lbPrelimRound = [];
  if (prelimMatchIds.length >= 2) {
    // Prelim losers play each other
    for (let i = 0; i < prelimMatchIds.length; i += 2) {
      if (i + 1 < prelimMatchIds.length) {
        const id = newMatch();
        matchMap[prelimMatchIds[i]].loserGoesToMatchId = id;
        matchMap[prelimMatchIds[i]].loserGoesToSlot = 'p1';
        matchMap[prelimMatchIds[i + 1]].loserGoesToMatchId = id;
        matchMap[prelimMatchIds[i + 1]].loserGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = prelimMatchIds[i];
        matchMap[id].p2FromMatchId = prelimMatchIds[i + 1];
        matchMap[id].p1IsLoserOf = true;
        matchMap[id].p2IsLoserOf = true;
        lbPrelimRound.push(id);
      } else {
        // Odd prelim loser - will merge later
        lbPrelimRound.push({ singleLoserFrom: prelimMatchIds[i] });
      }
    }
  } else if (prelimMatchIds.length === 1) {
    // Single prelim loser needs to wait for WB R1 losers
    lbPrelimRound.push({ singleLoserFrom: prelimMatchIds[0] });
  }
  
  if (lbPrelimRound.length > 0 && typeof lbPrelimRound[0] === 'string') {
    losersRounds.push(lbPrelimRound.filter(x => typeof x === 'string'));
  }

  // Step 2: WB Round 1 losers
  // These need to either:
  // - Play each other (if no prelim losers to merge with)
  // - Merge with prelim LB survivors
  
  const wbR1LoserSources = wbR1; // All WB R1 matches produce losers
  
  if (losersRounds.length > 0) {
    // Merge WB R1 losers with prelim LB winners
    const prevLB = losersRounds[losersRounds.length - 1];
    const mergeRound = [];
    
    for (let i = 0; i < wbR1LoserSources.length; i++) {
      const id = newMatch();
      
      // p1 = loser of WB R1 match
      matchMap[wbR1LoserSources[i]].loserGoesToMatchId = id;
      matchMap[wbR1LoserSources[i]].loserGoesToSlot = 'p1';
      matchMap[id].p1FromMatchId = wbR1LoserSources[i];
      matchMap[id].p1IsLoserOf = true;
      
      // p2 = winner of prelim LB match (if available)
      if (i < prevLB.length) {
        matchMap[prevLB[i]].winnerGoesToMatchId = id;
        matchMap[prevLB[i]].winnerGoesToSlot = 'p2';
        matchMap[id].p2FromMatchId = prevLB[i];
        matchMap[id].p2IsLoserOf = false;
      }
      
      mergeRound.push(id);
    }
    losersRounds.push(mergeRound);
  } else if (prelimMatchIds.length === 1) {
    // Special case: 1 prelim match, its loser joins WB R1 losers
    const lbR1 = [];
    
    // First match: prelim loser vs first WB R1 loser
    const firstId = newMatch();
    matchMap[prelimMatchIds[0]].loserGoesToMatchId = firstId;
    matchMap[prelimMatchIds[0]].loserGoesToSlot = 'p1';
    matchMap[firstId].p1FromMatchId = prelimMatchIds[0];
    matchMap[firstId].p1IsLoserOf = true;
    
    matchMap[wbR1LoserSources[0]].loserGoesToMatchId = firstId;
    matchMap[wbR1LoserSources[0]].loserGoesToSlot = 'p2';
    matchMap[firstId].p2FromMatchId = wbR1LoserSources[0];
    matchMap[firstId].p2IsLoserOf = true;
    lbR1.push(firstId);
    
    // Remaining WB R1 losers pair up
    for (let i = 1; i < wbR1LoserSources.length; i += 2) {
      if (i + 1 < wbR1LoserSources.length) {
        const id = newMatch();
        matchMap[wbR1LoserSources[i]].loserGoesToMatchId = id;
        matchMap[wbR1LoserSources[i]].loserGoesToSlot = 'p1';
        matchMap[wbR1LoserSources[i + 1]].loserGoesToMatchId = id;
        matchMap[wbR1LoserSources[i + 1]].loserGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = wbR1LoserSources[i];
        matchMap[id].p2FromMatchId = wbR1LoserSources[i + 1];
        matchMap[id].p1IsLoserOf = true;
        matchMap[id].p2IsLoserOf = true;
        lbR1.push(id);
      }
    }
    losersRounds.push(lbR1);
  } else {
    // No prelims, standard: WB R1 losers play each other
    const lbR1 = [];
    for (let i = 0; i < wbR1LoserSources.length; i += 2) {
      if (i + 1 < wbR1LoserSources.length) {
        const id = newMatch();
        matchMap[wbR1LoserSources[i]].loserGoesToMatchId = id;
        matchMap[wbR1LoserSources[i]].loserGoesToSlot = 'p1';
        matchMap[wbR1LoserSources[i + 1]].loserGoesToMatchId = id;
        matchMap[wbR1LoserSources[i + 1]].loserGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = wbR1LoserSources[i];
        matchMap[id].p2FromMatchId = wbR1LoserSources[i + 1];
        matchMap[id].p1IsLoserOf = true;
        matchMap[id].p2IsLoserOf = true;
        lbR1.push(id);
      }
    }
    if (lbR1.length > 0) losersRounds.push(lbR1);
  }

  // Step 3: Reduce LB to single match if needed, then merge with subsequent WB losers
  // Battle round after merge (LB survivors play each other)
  
  let currentLB = losersRounds.length > 0 ? losersRounds[losersRounds.length - 1] : [];
  
  // If we have more than 1 LB match, they need to battle down
  if (currentLB.length > 1) {
    const battleRound = [];
    for (let i = 0; i < currentLB.length; i += 2) {
      if (i + 1 < currentLB.length) {
        const id = newMatch();
        matchMap[currentLB[i]].winnerGoesToMatchId = id;
        matchMap[currentLB[i]].winnerGoesToSlot = 'p1';
        matchMap[currentLB[i + 1]].winnerGoesToMatchId = id;
        matchMap[currentLB[i + 1]].winnerGoesToSlot = 'p2';
        matchMap[id].p1FromMatchId = currentLB[i];
        matchMap[id].p2FromMatchId = currentLB[i + 1];
        battleRound.push(id);
      } else {
        // Odd
