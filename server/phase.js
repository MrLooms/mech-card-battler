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

// ── Resolve a full round — lanes resolve LEFT TO RIGHT ────────────────────────
// Splash from lane N immediately pre-damages cards in lanes N+1, N+2.
// A card killed by pre-fight splash is destroyed without dealing damage.
function resolveRound(room) {
  room.phase = "BATTLE";

  const [wsA, wsB] = room.players;
  const lanesA = room.submissions[wsA.userId] || [null, null, null];
  const lanesB = room.submissions[wsB.userId] || [null, null, null];

  // Blackout disables ALL opponent abilities this round
  const blackoutA = lanesA.some(c => c && c.ability === ABILITY.BLACKOUT);
  const blackoutB = lanesB.some(c => c && c.ability === ABILITY.BLACKOUT);

  // Mutable HP and pre-kill state — updated by sequential splash
  const hpA = lanesA.map(c => (c ? c.current_hp : null));
  const hpB = lanesB.map(c => (c ? c.current_hp : null));
  const prekilledA = [false, false, false]; // killed by splash before their lane fights
  const prekilledB = [false, false, false];

  // Apply splash damage to all future lanes for one team
  function splashFutureLanes(hp, prekilled, lanes, fromLane, damage) {
    for (let j = fromLane + 1; j < 3; j++) {
      if (lanes[j] && !prekilled[j]) {
        hp[j] -= damage;
        if (hp[j] <= 0) { hp[j] = 0; prekilled[j] = true; }
      }
    }
  }

  // Apply splash damage to a specific future lane
  function splashLane(hp, prekilled, lanes, targetLane, fromLane, damage) {
    if (targetLane <= fromLane) return; // only future lanes
    if (!lanes[targetLane] || prekilled[targetLane]) return;
    hp[targetLane] -= damage;
    if (hp[targetLane] <= 0) { hp[targetLane] = 0; prekilled[targetLane] = true; }
  }

  // Coordinated: +2 offense per ally in same role
  function coordinatedBonus(card, allLanes) {
    let count = 0;
    for (const c of allLanes) {
      if (c && c !== card && c.role === card.role) count++;
    }
    return count * 2;
  }

  // Apply damage with Durable check
  function applyDamage(result, card, damage, jammed) {
    result.current_hp -= damage;
    if (!jammed && card.ability === ABILITY.DURABLE && result.current_hp <= 0) {
      result.current_hp = 1;
    }
    result.destroyed = result.current_hp <= 0;
  }

  const laneResults = [];

  for (let i = 0; i < 3; i++) {
    const origA = lanesA[i];
    const origB = lanesB[i];

    if (!origA && !origB) { laneResults.push(null); continue; }

    // Build result stubs (pre-killed cards are already destroyed)
    const resultA = origA ? {
      // Template fields — passed through so opponent can display the card
      id:           origA.id,
      name:         origA.display_name || origA.name || "",
      display_name: origA.display_name || origA.name || "",
      model_code:   origA.model_code || "",
      role:         origA.role,
      role_id:      origA.role_id !== undefined ? origA.role_id : 0,
      rarity:       origA.rarity !== undefined ? origA.rarity : 0,
      offense:      origA.offense,
      defense:      origA.defense,
      ability:      origA.ability,
      // Combat result fields
      pre_battle_hp:     hpA[i] !== null ? hpA[i] : origA.current_hp,
      current_hp:        hpA[i] !== null ? hpA[i] : origA.current_hp,
      destroyed:         prekilledA[i],
      ability_triggered: prekilledA[i] ? "Splash" : null,
      salvage_draw: prekilledA[i] && origA.ability === ABILITY.SALVAGE && !blackoutB,
    } : null;
    const resultB = origB ? {
      id:           origB.id,
      name:         origB.display_name || origB.name || "",
      display_name: origB.display_name || origB.name || "",
      model_code:   origB.model_code || "",
      role:         origB.role,
      role_id:      origB.role_id !== undefined ? origB.role_id : 0,
      rarity:       origB.rarity !== undefined ? origB.rarity : 0,
      offense:      origB.offense,
      defense:      origB.defense,
      ability:      origB.ability,
      pre_battle_hp:     hpB[i] !== null ? hpB[i] : origB.current_hp,
      current_hp:        hpB[i] !== null ? hpB[i] : origB.current_hp,
      destroyed:         prekilledB[i],
      ability_triggered: prekilledB[i] ? "Splash" : null,
      salvage_draw: prekilledB[i] && origB.ability === ABILITY.SALVAGE && !blackoutA,
    } : null;

    // Effective combatants (null if pre-killed by earlier splash)
    const cardA = origA && !prekilledA[i] ? origA : null;
    const cardB = origB && !prekilledB[i] ? origB : null;

    if (cardA && cardB) {
      // ── Full combat ──────────────────────────────────────────────────────
      // Priority: Blackout is resolved globally before lane combat, so it always
      // beats JAM when they face each other in the same lane.
      const abilityJammedA = blackoutB || (origB.ability === ABILITY.JAM && !blackoutA);
      const abilityJammedB = blackoutA || (origA.ability === ABILITY.JAM && !blackoutB);

      // JAM: mark as triggered on the jamming card (only if JAM itself wasn't jammed)
      if (!abilityJammedA && origA.ability === ABILITY.JAM) resultA.ability_triggered = "Jam";
      if (!abilityJammedB && origB.ability === ABILITY.JAM) resultB.ability_triggered = "Jam";

      // BLACKOUT: mark as triggered on the Blackout card
      if (!abilityJammedA && origA.ability === ABILITY.BLACKOUT) resultA.ability_triggered = "Blackout";
      if (!abilityJammedB && origB.ability === ABILITY.BLACKOUT) resultB.ability_triggered = "Blackout";

      let offA = origA.offense;
      let offB = origB.offense;

      if (!abilityJammedA && origA.ability === ABILITY.OVERCLOCK)   offA *= 2;
      if (!abilityJammedB && origB.ability === ABILITY.OVERCLOCK)   offB *= 2;
      if (!abilityJammedA && origA.ability === ABILITY.COORDINATED) offA += coordinatedBonus(origA, lanesA);
      if (!abilityJammedB && origB.ability === ABILITY.COORDINATED) offB += coordinatedBonus(origB, lanesB);

      // BROADCAST: a Broadcast card gets +2 offense for each OTHER ally Broadcast card deployed.
      // Only the Broadcast card itself is boosted — non-Broadcast cards are unaffected.
      if (!blackoutB && origA.ability === ABILITY.BROADCAST) {
        let bcastA = 0;
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesA[j] && lanesA[j].ability === ABILITY.BROADCAST) bcastA++;
        }
        if (bcastA > 0) { offA += bcastA * 2; resultA.ability_triggered = "Broadcast"; }
      }
      if (!blackoutA && origB.ability === ABILITY.BROADCAST) {
        let bcastB = 0;
        for (let j = 0; j < 3; j++) {
          if (j !== i && lanesB[j] && lanesB[j].ability === ABILITY.BROADCAST) bcastB++;
        }
        if (bcastB > 0) { offB += bcastB * 2; resultB.ability_triggered = "Broadcast"; }
      }

      const multA = typeMultiplier(origA.role, origB.role);
      const multB = typeMultiplier(origB.role, origA.role);

      let dmgToB = Math.floor(offA * multA);
      let dmgToA = Math.floor(offB * multB);

      if (!abilityJammedB && origB.ability === ABILITY.ARMOR) dmgToB = Math.max(0, dmgToB - ARMOR_REDUCTION);
      if (!abilityJammedA && origA.ability === ABILITY.ARMOR) dmgToA = Math.max(0, dmgToA - ARMOR_REDUCTION);

      // INITIATIVE (First Strike): strike before opponent; if opponent dies they don't hit back
      const hasInitiativeA = !abilityJammedA && origA.ability === ABILITY.INITIATIVE;
      const hasInitiativeB = !abilityJammedB && origB.ability === ABILITY.INITIATIVE;

      if (hasInitiativeA && !hasInitiativeB) {
        applyDamage(resultB, origB, dmgToB, abilityJammedB);
        if (!resultB.destroyed) applyDamage(resultA, origA, dmgToA, abilityJammedA);
        resultA.ability_triggered = "Initiative";
      } else if (hasInitiativeB && !hasInitiativeA) {
        applyDamage(resultA, origA, dmgToA, abilityJammedA);
        if (!resultA.destroyed) applyDamage(resultB, origB, dmgToB, abilityJammedB);
        resultB.ability_triggered = "Initiative";
      } else {
        applyDamage(resultB, origB, dmgToB, abilityJammedB);
        applyDamage(resultA, origA, dmgToA, abilityJammedA);
      }

      // RETALIATE: loser deals fraction of offense back to winner
      const aWins = !resultA.destroyed && resultB.destroyed;
      const bWins = !resultB.destroyed && resultA.destroyed;

      if (bWins && !abilityJammedA && origA.ability === ABILITY.RETALIATE) {
        resultB.current_hp -= Math.floor(offA * RETALIATE_FRAC);
        if (resultB.current_hp <= 0) { resultB.current_hp = 0; resultB.destroyed = true; }
        resultA.ability_triggered = "Retaliate";
      }
      if (aWins && !abilityJammedB && origB.ability === ABILITY.RETALIATE) {
        resultA.current_hp -= Math.floor(offB * RETALIATE_FRAC);
        if (resultA.current_hp <= 0) { resultA.current_hp = 0; resultA.destroyed = true; }
        resultB.ability_triggered = "Retaliate";
      }

      // DEAD_WEIGHT: loser also deals flat damage to winner
      if (bWins && !abilityJammedA && origA.ability === ABILITY.DEAD_WEIGHT) {
        resultB.current_hp -= DEAD_WEIGHT_DAMAGE;
        if (resultB.current_hp <= 0) { resultB.current_hp = 0; resultB.destroyed = true; }
        resultA.ability_triggered = "Dead Weight";
      }
      if (aWins && !abilityJammedB && origB.ability === ABILITY.DEAD_WEIGHT) {
        resultA.current_hp -= DEAD_WEIGHT_DAMAGE;
        if (resultA.current_hp <= 0) { resultA.current_hp = 0; resultA.destroyed = true; }
        resultB.ability_triggered = "Dead Weight";
      }

      // OVERCLOCK: self-destruct at end of round
      if (!abilityJammedA && origA.ability === ABILITY.OVERCLOCK && !resultA.destroyed) {
        resultA.destroyed = true; resultA.current_hp = 0;
        resultA.ability_triggered = "Overclock";
      }
      if (!abilityJammedB && origB.ability === ABILITY.OVERCLOCK && !resultB.destroyed) {
        resultB.destroyed = true; resultB.current_hp = 0;
        resultB.ability_triggered = "Overclock";
      }

      // EJECT: destroyed card returns to hand at 1 HP (Overclock cannot be ejected)
      if (resultA.destroyed && !abilityJammedA && origA.ability === ABILITY.EJECT
          && resultA.ability_triggered !== "Overclock") {
        resultA.current_hp = 1; resultA.destroyed = false; resultA.ejected = true;
        resultA.ability_triggered = "Eject";
      }
      if (resultB.destroyed && !abilityJammedB && origB.ability === ABILITY.EJECT
          && resultB.ability_triggered !== "Overclock") {
        resultB.current_hp = 1; resultB.destroyed = false; resultB.ejected = true;
        resultB.ability_triggered = "Eject";
      }

      // Final win state after all adjustments
      const aWinsFinal = !resultA.destroyed && resultB.destroyed;
      const bWinsFinal = !resultB.destroyed && resultA.destroyed;

      // OVERCHARGE: winner splashes bonus to lowest-HP future enemy lane
      if (aWinsFinal && !abilityJammedA && origA.ability === ABILITY.OVERCHARGE) {
        let bestJ = -1, bestHp = Infinity;
        for (let j = i + 1; j < 3; j++) {
          if (lanesB[j] && !prekilledB[j] && hpB[j] < bestHp) { bestHp = hpB[j]; bestJ = j; }
        }
        if (bestJ >= 0) splashLane(hpB, prekilledB, lanesB, bestJ, i, OVERCHARGE_BONUS);
        resultA.ability_triggered = "Overcharge";
      }
      if (bWinsFinal && !abilityJammedB && origB.ability === ABILITY.OVERCHARGE) {
        let bestJ = -1, bestHp = Infinity;
        for (let j = i + 1; j < 3; j++) {
          if (lanesA[j] && !prekilledA[j] && hpA[j] < bestHp) { bestHp = hpA[j]; bestJ = j; }
        }
        if (bestJ >= 0) splashLane(hpA, prekilledA, lanesA, bestJ, i, OVERCHARGE_BONUS);
        resultB.ability_triggered = "Overcharge";
      }

      // AFTERBURNER: winner splashes flat damage to all future enemy lanes
      if (aWinsFinal && !abilityJammedA && origA.ability === ABILITY.AFTERBURNER) {
        splashFutureLanes(hpB, prekilledB, lanesB, i, AFTERBURNER_SPLASH);
        resultA.ability_triggered = "Afterburner";
      }
      if (bWinsFinal && !abilityJammedB && origB.ability === ABILITY.AFTERBURNER) {
        splashFutureLanes(hpA, prekilledA, lanesA, i, AFTERBURNER_SPLASH);
        resultB.ability_triggered = "Afterburner";
      }

      // VOLATILE: destroyed card splashes half offense to all future enemy lanes
      if (resultA.destroyed && !abilityJammedA && origA.ability === ABILITY.VOLATILE) {
        splashFutureLanes(hpB, prekilledB, lanesB, i, Math.floor(offA * 0.5));
        resultA.ability_triggered = "Volatile";
      }
      if (resultB.destroyed && !abilityJammedB && origB.ability === ABILITY.VOLATILE) {
        splashFutureLanes(hpA, prekilledA, lanesA, i, Math.floor(offB * 0.5));
        resultB.ability_triggered = "Volatile";
      }

      // REGENERATE: survivor heals
      if (!resultA.destroyed && !abilityJammedA && origA.ability === ABILITY.REGENERATE) {
        resultA.current_hp = Math.min(origA.defense, resultA.current_hp + REGEN_AMOUNT);
        resultA.ability_triggered = "Regenerate";
      }
      if (!resultB.destroyed && !abilityJammedB && origB.ability === ABILITY.REGENERATE) {
        resultB.current_hp = Math.min(origB.defense, resultB.current_hp + REGEN_AMOUNT);
        resultB.ability_triggered = "Regenerate";
      }

      // SALVAGE: destroyed card grants owner an extra draw
      if (resultA.destroyed && !abilityJammedA && origA.ability === ABILITY.SALVAGE) {
        resultA.salvage_draw = true; resultA.ability_triggered = "Salvage";
      }
      if (resultB.destroyed && !abilityJammedB && origB.ability === ABILITY.SALVAGE) {
        resultB.salvage_draw = true; resultB.ability_triggered = "Salvage";
      }

      // REDEPLOY: surviving card returns to hand instead of staying in lane
      if (!resultA.destroyed && !resultA.ejected && !abilityJammedA && origA.ability === ABILITY.REDEPLOY) {
        resultA.redeploy = true; resultA.ability_triggered = "Redeploy";
      }
      if (!resultB.destroyed && !resultB.ejected && !abilityJammedB && origB.ability === ABILITY.REDEPLOY) {
        resultB.redeploy = true; resultB.ability_triggered = "Redeploy";
      }

    } else {
      // ── Unopposed lane (one side absent or pre-killed by splash) ─────────
      const card   = cardA || cardB;
      const result = cardA ? resultA : resultB;
      const oCard  = cardA ? origA   : origB;
      const jammed = cardA ? blackoutB : blackoutA;

      if (card) {
        // Overclock self-destructs even when unopposed
        if (!jammed && oCard.ability === ABILITY.OVERCLOCK) {
          result.destroyed = true; result.current_hp = 0;
          result.ability_triggered = "Overclock";
        }
        // Eject on Overclock self-destruct
        if (result.destroyed && !jammed && oCard.ability === ABILITY.EJECT
            && result.ability_triggered !== "Overclock") {
          result.current_hp = 1; result.destroyed = false; result.ejected = true;
          result.ability_triggered = "Eject";
        }
        // Redeploy: unopposed survivor returns to hand
        if (!result.destroyed && !result.ejected && !jammed && oCard.ability === ABILITY.REDEPLOY) {
          result.redeploy = true; result.ability_triggered = "Redeploy";
        }
        // Blackout: mark as triggered even when unopposed (it still disables all opponent abilities)
        if (!jammed && oCard.ability === ABILITY.BLACKOUT) {
          result.ability_triggered = "Blackout";
        }
      }
    }

    laneResults.push({ player_card: resultA, opponent_card: resultB });
  }

  // ── Tally scrap ───────────────────────────────────────────────────────────
  const scrapA = room.scrapA = (room.scrapA || 0)
    + laneResults.filter(r => r && r.player_card   && r.player_card.destroyed).length;
  const scrapB = room.scrapB = (room.scrapB || 0)
    + laneResults.filter(r => r && r.opponent_card && r.opponent_card.destroyed).length;

  const gameOverA = scrapA >= 20;
  const gameOverB = scrapB >= 20;

  const resultForA = {
    battle_round:        room.round,
    lanes:               laneResults,
    player_scrap_count:  scrapA,
    opponent_scrap_count: scrapB,
    game_over: gameOverA || gameOverB,
    result: gameOverA ? "loss" : gameOverB ? "win" : null,
  };
  const resultForB = {
    battle_round:        room.round,
    lanes:               laneResults.map(r => r
      ? { player_card: r.opponent_card, opponent_card: r.player_card }
      : null),
    player_scrap_count:  scrapB,
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
