const { broadcastToRoom } = require("./rooms");

// ── Type chart ────────────────────────────────────────────────────────────────
const BEATS = {
  Brawler:   ["Scout", "Recon"],
  Artillery: ["Shield", "Brawler"],
  Shield:    ["Brawler", "Scout"],
  Scout:     ["Artillery", "Recon"],
  Recon:     ["Artillery", "Shield"],
};

function typeMultiplier(attackerRole, defenderRole) {
  const beats = BEATS[attackerRole] || [];
  if (beats.includes(defenderRole)) return 2;
  for (const [role, beaten] of Object.entries(BEATS)) {
    if (role === attackerRole) continue;
    if (beaten.includes(attackerRole) && role === defenderRole) return 0.5;
  }
  return 1;
}

// ── Ability constants (match GML ABILITY enum order) ─────────────────────────
const ABILITY = {
  NONE: 0, ARMOR: 1, OVERCHARGE: 2, RETALIATE: 3, REGENERATE: 4,
  JAM: 5, REDEPLOY: 6, SALVAGE: 7, OVERCLOCK: 8, BROADCAST: 9,
  EJECT: 10, DEAD_WEIGHT: 11, BLACKOUT: 12, AFTERBURNER: 13,
  DURABLE: 14, VOLATILE: 15, COORDINATED: 16, INITIATIVE: 17,
};

const ARMOR_REDUCTION    = 2;
const REGEN_AMOUNT       = 2;
const RETALIATE_FRAC     = 0.5;
const OVERCHARGE_BONUS   = 3;
const AFTERBURNER_SPLASH = 3;
const DEAD_WEIGHT_DAMAGE = 3;

// ── Phase: Draw complete ──────────────────────────────────────────────────────
function handleDrawComplete(room, ws) {
  room.drawReady = (room.drawReady || 0) + 1;
  if (room.drawReady >= 2) {
    room.drawReady = 0;
    room.phase = "PLACEMENT";
    broadcastToRoom(room, {
      type: "PHASE_BEGIN",
      data: { phase: "PLACEMENT", battle_round: room.round },
    });
  }
}

// ── Phase: Placement submitted ────────────────────────────────────────────────
function handlePlacementSubmit(room, ws, data) {
  room.submissions[ws.userId] = data.lanes || [null, null, null];
  if (Object.keys(room.submissions).length >= 2) {
    resolveRound(room);
  }
}

// ── Resolve a full round ──────────────────────────────────────────────────────
function resolveRound(room) {
  room.phase = "BATTLE";

  const [wsA, wsB] = room.players;
  const lanesA = room.submissions[wsA.userId] || [null, null, null];
  const lanesB = room.submissions[wsB.userId] || [null, null, null];

  // Blackout: disables ALL opponent abilities
  const blackoutA = lanesA.some(c => c && c.ability === ABILITY.BLACKOUT);
  const blackoutB = lanesB.some(c => c && c.ability === ABILITY.BLACKOUT);

  // Coordinated: +2 offense per ally sharing same role
  function coordinatedBonus(card, allLanes) {
    let count = 0;
    for (const c of allLanes) {
      if (c && c !== card && c.role === card.role) count++;
    }
    return count * 2;
  }

  // Apply damage with Durable check; sets result.destroyed
  function applyDamage(result, card, damage, jammed) {
    result.current_hp -= damage;
    if (!jammed && card.ability === ABILITY.DURABLE && result.current_hp <= 0) {
      result.current_hp = 1;
    }
    result.destroyed = result.current_hp <= 0;
  }

  const laneResults = [];
  const extraDamageA = [];
  const extraDamageB = [];

  for (let i = 0; i < 3; i++) {
    const cardA = lanesA[i] ? { ...lanesA[i] } : null;
    const cardB = lanesB[i] ? { ...lanesB[i] } : null;

    if (!cardA && !cardB) { laneResults.push(null); continue; }

    const resultA = cardA ? {
      id: cardA.id, pre_battle_hp: cardA.current_hp, current_hp: cardA.current_hp,
      destroyed: false, ability_triggered: null,
    } : null;
    const resultB = cardB ? {
      id: cardB.id, pre_battle_hp: cardB.current_hp, current_hp: cardB.current_hp,
      destroyed: false, ability_triggered: null,
    } : null;

    if (cardA && cardB) {
      // ── Ability jam checks ─────────────────────────────────────────────────
      const abilityJammedA = blackoutB || (cardB.ability === ABILITY.JAM && !blackoutA);
      const abilityJammedB = blackoutA || (cardA.ability === ABILITY.JAM && !blackoutB);

      // ── Effective offense ──────────────────────────────────────────────────
      let offA = cardA.offense;
      let offB = cardB.offense;

      if (!abilityJammedA && cardA.ability === ABILITY.OVERCLOCK)    offA *= 2;
      if (!abilityJammedB && cardB.ability === ABILITY.OVERCLOCK)    offB *= 2;
      if (!abilityJammedA && cardA.ability === ABILITY.COORDINATED)  offA += coordinatedBonus(cardA, lanesA);
      if (!abilityJammedB && cardB.ability === ABILITY.COORDINATED)  offB += coordinatedBonus(cardB, lanesB);

      // BROADCAST: other allied cards boost this card's offense by +2 each
      for (let j = 0; j < 3; j++) {
        if (j === i) continue;
        if (lanesA[j] && lanesA[j].ability === ABILITY.BROADCAST && !blackoutB) offA += 2;
        if (lanesB[j] && lanesB[j].ability === ABILITY.BROADCAST && !blackoutA) offB += 2;
      }

      // ── Type multipliers & armor ───────────────────────────────────────────
      const multA = typeMultiplier(cardA.role, cardB.role);
      const multB = typeMultiplier(cardB.role, cardA.role);

      let dmgToB = Math.floor(offA * multA);
      let dmgToA = Math.floor(offB * multB);

      if (!abilityJammedB && cardB.ability === ABILITY.ARMOR) dmgToB = Math.max(0, dmgToB - ARMOR_REDUCTION);
      if (!abilityJammedA && cardA.ability === ABILITY.ARMOR) dmgToA = Math.max(0, dmgToA - ARMOR_REDUCTION);

      // ── INITIATIVE (First Strike) ──────────────────────────────────────────
      const hasInitiativeA = !abilityJammedA && cardA.ability === ABILITY.INITIATIVE;
      const hasInitiativeB = !abilityJammedB && cardB.ability === ABILITY.INITIATIVE;

      if (hasInitiativeA && !hasInitiativeB) {
        // A strikes first; if B dies it never deals damage
        applyDamage(resultB, cardB, dmgToB, abilityJammedB);
        if (!resultB.destroyed) applyDamage(resultA, cardA, dmgToA, abilityJammedA);
        resultA.ability_triggered = "Initiative";
      } else if (hasInitiativeB && !hasInitiativeA) {
        applyDamage(resultA, cardA, dmgToA, abilityJammedA);
        if (!resultA.destroyed) applyDamage(resultB, cardB, dmgToB, abilityJammedB);
        resultB.ability_triggered = "Initiative";
      } else {
        // Simultaneous (both or neither have Initiative)
        applyDamage(resultB, cardB, dmgToB, abilityJammedB);
        applyDamage(resultA, cardA, dmgToA, abilityJammedA);
      }

      // ── Post-damage abilities ──────────────────────────────────────────────
      const aWins = !resultA.destroyed && resultB.destroyed;
      const bWins = !resultB.destroyed && resultA.destroyed;

      // RETALIATE: loser deals fraction of offense back to winner
      if (bWins && !abilityJammedA && cardA.ability === ABILITY.RETALIATE) {
        resultB.current_hp -= Math.floor(offA * RETALIATE_FRAC);
        if (resultB.current_hp <= 0) { resultB.current_hp = 0; resultB.destroyed = true; }
        resultA.ability_triggered = "Retaliate";
      }
      if (aWins && !abilityJammedB && cardB.ability === ABILITY.RETALIATE) {
        resultA.current_hp -= Math.floor(offB * RETALIATE_FRAC);
        if (resultA.current_hp <= 0) { resultA.current_hp = 0; resultA.destroyed = true; }
        resultB.ability_triggered = "Retaliate";
      }

      // DEAD_WEIGHT: loser deals flat damage to the winner even in defeat
      if (bWins && !abilityJammedA && cardA.ability === ABILITY.DEAD_WEIGHT) {
        resultB.current_hp -= DEAD_WEIGHT_DAMAGE;
        if (resultB.current_hp <= 0) { resultB.current_hp = 0; resultB.destroyed = true; }
        resultA.ability_triggered = "Dead Weight";
      }
      if (aWins && !abilityJammedB && cardB.ability === ABILITY.DEAD_WEIGHT) {
        resultA.current_hp -= DEAD_WEIGHT_DAMAGE;
        if (resultA.current_hp <= 0) { resultA.current_hp = 0; resultA.destroyed = true; }
        resultB.ability_triggered = "Dead Weight";
      }

      // OVERCLOCK: self-destruct at end of round regardless of outcome
      if (!abilityJammedA && cardA.ability === ABILITY.OVERCLOCK && !resultA.destroyed) {
        resultA.destroyed = true; resultA.current_hp = 0;
        resultA.ability_triggered = "Overclock";
      }
      if (!abilityJammedB && cardB.ability === ABILITY.OVERCLOCK && !resultB.destroyed) {
        resultB.destroyed = true; resultB.current_hp = 0;
        resultB.ability_triggered = "Overclock";
      }

      // EJECT: if destroyed, return to hand with 1 HP instead (runs after Overclock so Overclock beats Eject)
      if (resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.EJECT) {
        resultA.current_hp = 1; resultA.destroyed = false; resultA.ejected = true;
        resultA.ability_triggered = "Eject";
      }
      if (resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.EJECT) {
        resultB.current_hp = 1; resultB.destroyed = false; resultB.ejected = true;
        resultB.ability_triggered = "Eject";
      }

      // Recompute winner flags after all damage adjustments
      const aWinsFinal = !resultA.destroyed && resultB.destroyed;
      const bWinsFinal = !resultB.destroyed && resultA.destroyed;

      // OVERCHARGE: winner deals bonus damage to lowest-HP enemy
      if (aWinsFinal && !abilityJammedA && cardA.ability === ABILITY.OVERCHARGE) {
        extraDamageA.push({ source_lane: i, damage: OVERCHARGE_BONUS });
        resultA.ability_triggered = "Overcharge";
      }
      if (bWinsFinal && !abilityJammedB && cardB.ability === ABILITY.OVERCHARGE) {
        extraDamageB.push({ source_lane: i, damage: OVERCHARGE_BONUS });
        resultB.ability_triggered = "Overcharge";
      }

      // AFTERBURNER: winner splashes flat damage to all other opponent cards
      if (aWinsFinal && !abilityJammedA && cardA.ability === ABILITY.AFTERBURNER) {
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesB[j]) extraDamageA.push({ source_lane: i, target_lane: j, damage: AFTERBURNER_SPLASH });
        }
        resultA.ability_triggered = "Afterburner";
      }
      if (bWinsFinal && !abilityJammedB && cardB.ability === ABILITY.AFTERBURNER) {
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesA[j]) extraDamageB.push({ source_lane: i, target_lane: j, damage: AFTERBURNER_SPLASH });
        }
        resultB.ability_triggered = "Afterburner";
      }

      // VOLATILE: destroyed card splashes half offense to all other enemy lanes
      if (resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.VOLATILE) {
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesB[j]) extraDamageA.push({ source_lane: i, target_lane: j, damage: Math.floor(offA * 0.5) });
        }
        resultA.ability_triggered = "Volatile";
      }
      if (resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.VOLATILE) {
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesA[j]) extraDamageB.push({ source_lane: i, target_lane: j, damage: Math.floor(offB * 0.5) });
        }
        resultB.ability_triggered = "Volatile";
      }

      // REGENERATE: survivor heals
      if (!resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.REGENERATE) {
        resultA.current_hp = Math.min(cardA.defense, resultA.current_hp + REGEN_AMOUNT);
        resultA.ability_triggered = "Regenerate";
      }
      if (!resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.REGENERATE) {
        resultB.current_hp = Math.min(cardB.defense, resultB.current_hp + REGEN_AMOUNT);
        resultB.ability_triggered = "Regenerate";
      }

      // SALVAGE: destroyed card grants owner an extra draw next round
      if (resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.SALVAGE) {
        resultA.salvage_draw = true;
        resultA.ability_triggered = "Salvage";
      }
      if (resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.SALVAGE) {
        resultB.salvage_draw = true;
        resultB.ability_triggered = "Salvage";
      }

      // REDEPLOY: surviving (non-ejected) card returns to hand instead of deck bottom
      if (!resultA.destroyed && !resultA.ejected && !abilityJammedA && cardA.ability === ABILITY.REDEPLOY) {
        resultA.redeploy = true;
        resultA.ability_triggered = "Redeploy";
      }
      if (!resultB.destroyed && !resultB.ejected && !abilityJammedB && cardB.ability === ABILITY.REDEPLOY) {
        resultB.redeploy = true;
        resultB.ability_triggered = "Redeploy";
      }

    } else {
      // ── Unopposed lane ─────────────────────────────────────────────────────
      const card   = cardA || cardB;
      const result = cardA ? resultA : resultB;
      const jammed = cardA ? blackoutB : blackoutA;

      // Overclock self-destructs even unopposed
      if (!jammed && card.ability === ABILITY.OVERCLOCK) {
        result.destroyed = true; result.current_hp = 0;
        result.ability_triggered = "Overclock";
      }
      // Eject on self-destruct (Overclock case)
      if (result.destroyed && !jammed && card.ability === ABILITY.EJECT) {
        result.current_hp = 1; result.destroyed = false; result.ejected = true;
        result.ability_triggered = "Eject";
      }
      // Redeploy: unopposed survivor returns to hand
      if (!result.destroyed && !result.ejected && !jammed && card.ability === ABILITY.REDEPLOY) {
        result.redeploy = true;
        result.ability_triggered = "Redeploy";
      }
    }

    laneResults.push({ player_card: resultA, opponent_card: resultB });
  }

  // ── Apply splash damage (Overcharge / Afterburner / Volatile) ────────────
  function applyExtra(extraList, victimResults) {
    for (const ex of extraList) {
      const tgt = ex.target_lane !== undefined
        ? ex.target_lane
        : victimResults.reduce((best, r, idx) => {
            if (!r || r.destroyed) return best;
            if (best === -1 || r.current_hp < victimResults[best].current_hp) return idx;
            return best;
          }, -1);
      if (tgt !== -1 && victimResults[tgt] && !victimResults[tgt].destroyed) {
        victimResults[tgt].current_hp -= ex.damage;
        if (victimResults[tgt].current_hp <= 0) {
          victimResults[tgt].current_hp = 0;
          victimResults[tgt].destroyed = true;
        }
      }
    }
  }

  const playerCards   = laneResults.map(r => r ? r.player_card   : null);
  const opponentCards = laneResults.map(r => r ? r.opponent_card : null);
  applyExtra(extraDamageA, opponentCards);
  applyExtra(extraDamageB, playerCards);

  for (let i = 0; i < 3; i++) {
    if (laneResults[i]) {
      laneResults[i].player_card   = playerCards[i];
      laneResults[i].opponent_card = opponentCards[i];
    }
  }

  // ── Tally scrap ───────────────────────────────────────────────────────────
  const scrapA = room.scrapA = (room.scrapA || 0)
    + laneResults.filter(r => r && r.player_card   && r.player_card.destroyed).length;
  const scrapB = room.scrapB = (room.scrapB || 0)
    + laneResults.filter(r => r && r.opponent_card && r.opponent_card.destroyed).length;

  const gameOverA = scrapA >= 20;
  const gameOverB = scrapB >= 20;

  // ── Send mirrored results to each player ──────────────────────────────────
  const resultForA = {
    battle_round: room.round,
    lanes: laneResults,
    player_scrap_count:   scrapA,
    opponent_scrap_count: scrapB,
    game_over: gameOverA || gameOverB,
    result: gameOverA ? "loss" : gameOverB ? "win" : null,
  };
  const resultForB = {
    battle_round: room.round,
    lanes: laneResults.map(r => r
      ? { player_card: r.opponent_card, opponent_card: r.player_card }
      : null),
    player_scrap_count:   scrapB,
    opponent_scrap_count: scrapA,
    game_over: gameOverA || gameOverB,
    result: gameOverB ? "loss" : gameOverA ? "win" : null,
  };

  if (wsA.readyState === 1) wsA.send(JSON.stringify({ type: "PHASE_RESOLVE_RESULT", data: resultForA }));
  if (wsB.readyState === 1) wsB.send(JSON.stringify({ type: "PHASE_RESOLVE_RESULT", data: resultForB }));

  if (gameOverA || gameOverB) {
    if (wsA.readyState === 1) wsA.send(JSON.stringify({ type: "GAME_OVER", data: { result: resultForA.result } }));
    if (wsB.readyState === 1) wsB.send(JSON.stringify({ type: "GAME_OVER", data: { result: resultForB.result } }));
    return;
  }

  room.submissions  = {};
  room.cleanupReady = 0;
}

// ── Phase: Cleanup ack ────────────────────────────────────────────────────────
function handleCleanupComplete(room) {
  room.cleanupReady = (room.cleanupReady || 0) + 1;
  if (room.cleanupReady >= 2) {
    room.cleanupReady = 0;
    room.round++;
    room.phase = "DRAW";
    broadcastToRoom(room, {
      type: "PHASE_BEGIN",
      data: { phase: "DRAW", battle_round: room.round },
    });
  }
}

module.exports = { handleDrawComplete, handlePlacementSubmit, handleCleanupComplete };
