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
  // Loses = the roles that beat the attacker
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
  DURABLE: 14, VOLATILE: 15, COORDINATED: 16,
};

const ARMOR_REDUCTION  = 2;
const REGEN_AMOUNT     = 2;
const RETALIATE_FRAC   = 0.5;  // fraction of offense dealt back on loss
const OVERCHARGE_BONUS = 3;
const DEAD_WEIGHT_REDUCTION = 3;

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
  // lanes = array[3] of { id, role, offense, current_hp, ability } or null
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

  // Check for Blackout (disables all opponent abilities this round)
  const blackoutA = lanesA.some(c => c && c.ability === ABILITY.BLACKOUT);
  const blackoutB = lanesB.some(c => c && c.ability === ABILITY.BLACKOUT);

  // Coordinated bonus: +2 offense per ally in arena sharing same role
  function coordinatedBonus(card, allLanes) {
    if (!card || card.ability !== ABILITY.COORDINATED) return 0;
    let count = 0;
    for (const c of allLanes) {
      if (c && c !== card && c.role === card.role) count++;
    }
    return count * 2;
  }

  const laneResults = [];
  const extraDamageA = []; // [{ target_lane, damage }] from Overcharge
  const extraDamageB = [];

  for (let i = 0; i < 3; i++) {
    const cardA = lanesA[i] ? { ...lanesA[i] } : null;
    const cardB = lanesB[i] ? { ...lanesB[i] } : null;

    if (!cardA && !cardB) {
      laneResults.push(null);
      continue;
    }

    const resultA = cardA ? {
      id: cardA.id, pre_battle_hp: cardA.current_hp, current_hp: cardA.current_hp,
      destroyed: false, ability_triggered: null,
    } : null;
    const resultB = cardB ? {
      id: cardB.id, pre_battle_hp: cardB.current_hp, current_hp: cardB.current_hp,
      destroyed: false, ability_triggered: null,
    } : null;

    if (cardA && cardB) {
      // Both cards present — fight
      const abilityJammedA = blackoutB || (cardB.ability === ABILITY.JAM && !blackoutA);
      const abilityJammedB = blackoutA || (cardA.ability === ABILITY.JAM && !blackoutB);

      // Effective offense (Overclock doubles, Coordinated adds per ally)
      let offA = cardA.offense;
      let offB = cardB.offense;

      if (!abilityJammedA && cardA.ability === ABILITY.OVERCLOCK) offA *= 2;
      if (!abilityJammedB && cardB.ability === ABILITY.OVERCLOCK) offB *= 2;
      if (!abilityJammedA && cardA.ability === ABILITY.COORDINATED) offA += coordinatedBonus(cardA, lanesA);
      if (!abilityJammedB && cardB.ability === ABILITY.COORDINATED) offB += coordinatedBonus(cardB, lanesB);

      // Type multipliers
      const multA = typeMultiplier(cardA.role, cardB.role);
      const multB = typeMultiplier(cardB.role, cardA.role);

      let dmgToB = Math.floor(offA * multA);
      let dmgToA = Math.floor(offB * multB);

      // Armor reduces incoming damage
      if (!abilityJammedB && cardB.ability === ABILITY.ARMOR) dmgToB = Math.max(0, dmgToB - ARMOR_REDUCTION);
      if (!abilityJammedA && cardA.ability === ABILITY.ARMOR) dmgToA = Math.max(0, dmgToA - ARMOR_REDUCTION);

      // Apply damage
      resultB.current_hp -= dmgToB;
      resultA.current_hp -= dmgToA;

      // Durable: survive at 1 HP instead of dying
      if (!abilityJammedB && cardB.ability === ABILITY.DURABLE && resultB.current_hp <= 0) resultB.current_hp = 1;
      if (!abilityJammedA && cardA.ability === ABILITY.DURABLE && resultA.current_hp <= 0) resultA.current_hp = 1;

      const aWins = resultB.current_hp <= 0 && resultA.current_hp > 0;
      const bWins = resultA.current_hp <= 0 && resultB.current_hp > 0;

      // Retaliate: loser deals fraction of offense back to winner
      if (bWins && !abilityJammedA && cardA.ability === ABILITY.RETALIATE) {
        resultB.current_hp -= Math.floor(offA * RETALIATE_FRAC);
        resultA.ability_triggered = "Retaliate";
      }
      if (aWins && !abilityJammedB && cardB.ability === ABILITY.RETALIATE) {
        resultA.current_hp -= Math.floor(offB * RETALIATE_FRAC);
        resultB.ability_triggered = "Retaliate";
      }

      // Dead Weight: loser reduces winner's offense permanently this round
      if (bWins && !abilityJammedA && cardA.ability === ABILITY.DEAD_WEIGHT) {
        // Broadcast to client that winning card is debuffed
        resultA.ability_triggered = "Dead Weight";
        // We can't modify future rounds here easily; flag it in result for client
        resultB.dead_weight_hit = true;
      }
      if (aWins && !abilityJammedB && cardB.ability === ABILITY.DEAD_WEIGHT) {
        resultB.ability_triggered = "Dead Weight";
        resultA.dead_weight_hit = true;
      }

      // Mark destroyed
      resultA.destroyed = resultA.current_hp <= 0;
      resultB.destroyed = resultB.current_hp <= 0;

      // Overcharge: winner picks an enemy card to deal bonus damage to
      // We queue this; client will pick target, or server auto-targets lowest HP
      if (aWins && !abilityJammedA && cardA.ability === ABILITY.OVERCHARGE) {
        extraDamageA.push({ source_lane: i, damage: OVERCHARGE_BONUS });
        resultA.ability_triggered = "Overcharge";
      }
      if (bWins && !abilityJammedB && cardB.ability === ABILITY.OVERCHARGE) {
        extraDamageB.push({ source_lane: i, damage: OVERCHARGE_BONUS });
        resultB.ability_triggered = "Overcharge";
      }

      // Volatile: destroyed card deals damage to all enemy lanes
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

      // Regenerate: survivor gains HP
      if (!resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.REGENERATE) {
        resultA.current_hp = Math.min(cardA.defense, resultA.current_hp + REGEN_AMOUNT);
        resultA.ability_triggered = "Regenerate";
      }
      if (!resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.REGENERATE) {
        resultB.current_hp = Math.min(cardB.defense, resultB.current_hp + REGEN_AMOUNT);
        resultB.ability_triggered = "Regenerate";
      }

      // Salvage: destroyed card draws a card (flagged for client)
      if (resultA.destroyed && !abilityJammedA && cardA.ability === ABILITY.SALVAGE) {
        resultA.ability_triggered = "Salvage";
        resultA.salvage_draw = true;
      }
      if (resultB.destroyed && !abilityJammedB && cardB.ability === ABILITY.SALVAGE) {
        resultB.ability_triggered = "Salvage";
        resultB.salvage_draw = true;
      }

      // Overclock: card is destroyed at end of round regardless
      if (!abilityJammedA && cardA.ability === ABILITY.OVERCLOCK && !resultA.destroyed) {
        resultA.destroyed = true;
        resultA.current_hp = 0;
        resultA.ability_triggered = "Overclock";
      }
      if (!abilityJammedB && cardB.ability === ABILITY.OVERCLOCK && !resultB.destroyed) {
        resultB.destroyed = true;
        resultB.current_hp = 0;
        resultB.ability_triggered = "Overclock";
      }

    } else if (cardA) {
      // Only A has a card — unopposed
      if (!resultA) laneResults.push(null);
    } else {
      // Only B has a card — unopposed
      if (!resultB) laneResults.push(null);
    }

    laneResults.push({ player_card: resultA, opponent_card: resultB });
  }

  // Apply Volatile / Overcharge splash damage (auto-target lowest HP enemy)
  function applyExtra(extraList, victimResults) {
    for (const ex of extraList) {
      const tgt = ex.target_lane !== undefined
        ? victimResults[ex.target_lane]
        : victimResults.reduce((best, r, idx) => {
            if (!r || r.destroyed) return best;
            if (best === null || r.current_hp < victimResults[best].current_hp) return idx;
            return best;
          }, null);
      if (tgt !== null && victimResults[tgt] && !victimResults[tgt].destroyed) {
        victimResults[tgt].current_hp -= ex.damage;
        if (victimResults[tgt].current_hp <= 0) victimResults[tgt].destroyed = true;
      }
    }
  }

  const playerCards    = laneResults.map(r => r ? r.player_card   : null);
  const opponentCards  = laneResults.map(r => r ? r.opponent_card : null);
  applyExtra(extraDamageA, opponentCards);
  applyExtra(extraDamageB, playerCards);

  // Rebuild results with updated values
  for (let i = 0; i < 3; i++) {
    if (laneResults[i]) {
      laneResults[i].player_card   = playerCards[i];
      laneResults[i].opponent_card = opponentCards[i];
    }
  }

  // Tally scrap
  const scrapA = room.scrapA = (room.scrapA || 0)
    + laneResults.filter(r => r && r.player_card && r.player_card.destroyed).length;
  const scrapB = room.scrapB = (room.scrapB || 0)
    + laneResults.filter(r => r && r.opponent_card && r.opponent_card.destroyed).length;

  const gameOverA = scrapA >= 20;
  const gameOverB = scrapB >= 20;

  // Send mirrored results to each player
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
    lanes: laneResults.map(r => r ? { player_card: r.opponent_card, opponent_card: r.player_card } : null),
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

  room.submissions = {};
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
