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
// Only active abilities listed; removed ones kept as numeric refs for compat.
const ABILITY = {
  NONE: 0, ARMOR: 1, JAM: 5, EJECT: 10, BLACKOUT: 12,
  DURABLE: 14, VOLATILE: 15, COORDINATED: 16, INITIATIVE: 17,
  MOMENTUM: 18, FIELD_REPAIR: 22, REFLECT: 24,
};

const ARMOR_REDUCTION     = 2;
const FIELD_REPAIR_AMOUNT = 3;
const REFLECT_FRAC        = 0.25;

// ── Returns true if card has the ability on slot 1 or slot 2 ─────────────────
function cardHasAbility(card, ability) {
  return card.ability === ability
      || (card.ability_2 != null && card.ability_2 === ability);
}

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
function resolveRound(room) {
  room.phase = "BATTLE";

  const [wsA, wsB] = room.players;
  const lanesA = room.submissions[wsA.userId] || [null, null, null];
  const lanesB = room.submissions[wsB.userId] || [null, null, null];

  // Blackout disables ALL opponent abilities this round
  const blackoutA = lanesA.some(c => c && cardHasAbility(c, ABILITY.BLACKOUT));
  const blackoutB = lanesB.some(c => c && cardHasAbility(c, ABILITY.BLACKOUT));

  // Mutable HP — updated by sequential splash
  const hpA = lanesA.map(c => (c ? c.current_hp : null));
  const hpB = lanesB.map(c => (c ? c.current_hp : null));
  const prekilledA = [false, false, false];
  const prekilledB = [false, false, false];

  // Splash damage to future lanes only
  function splashFutureLanes(hp, prekilled, lanes, fromLane, damage) {
    for (let j = fromLane + 1; j < 3; j++) {
      if (lanes[j] && !prekilled[j]) {
        hp[j] -= damage;
        if (hp[j] <= 0) { hp[j] = 0; prekilled[j] = true; }
      }
    }
  }

  // VOLATILE: splash to ALL enemy lanes — past, present, and future.
  // pastSide: which slot in laneResults holds the enemy card ('player' or 'opponent').
  function splashVolatile(hp, prekilled, lanes, fromLane, damage, winnerResult, pastSide) {
    // Past lanes (already resolved) — hit surviving enemy cards retroactively
    for (let j = 0; j < fromLane; j++) {
      if (!laneResults[j]) continue;
      const pastCard = pastSide === 'player'
        ? laneResults[j].player_card
        : laneResults[j].opponent_card;
      if (pastCard && !pastCard.destroyed) {
        pastCard.current_hp = Math.max(0, pastCard.current_hp - damage);
        if (pastCard.current_hp <= 0) {
          pastCard.current_hp = 0;
          pastCard.destroyed  = true;
        }
      }
    }
    // Current lane winner
    if (winnerResult && !winnerResult.destroyed) {
      winnerResult.current_hp = Math.max(0, winnerResult.current_hp - damage);
      if (winnerResult.current_hp <= 0) {
        winnerResult.current_hp = 0;
        winnerResult.destroyed  = true;
      }
    }
    // Future lanes
    splashFutureLanes(hp, prekilled, lanes, fromLane, damage);
  }

  // Coordinated: +2 offense per ally in same role
  function coordinatedBonus(card, allLanes) {
    let count = 0;
    for (const c of allLanes) {
      if (c && c !== card && c.role === card.role) count++;
    }
    return count * 2;
  }

  // Apply damage with DURABLE check
  function applyDamage(result, card, damage, jammed) {
    result.current_hp -= damage;
    if (!jammed && cardHasAbility(card, ABILITY.DURABLE) && result.current_hp <= 0) {
      result.current_hp = 1;
    }
    result.destroyed = result.current_hp <= 0;
  }

  const laneResults = [];

  for (let i = 0; i < 3; i++) {
    const origA = lanesA[i];
    const origB = lanesB[i];

    if (!origA && !origB) { laneResults.push(null); continue; }

    const resultA = origA ? {
      id:                origA.id,
      name:              origA.display_name || origA.name || "",
      display_name:      origA.display_name || origA.name || "",
      model_code:        origA.model_code || "",
      role:              origA.role,
      role_id:           origA.role_id !== undefined ? origA.role_id : 0,
      rarity:            origA.rarity   !== undefined ? origA.rarity : 0,
      offense:           origA.offense,
      defense:           origA.defense,
      ability:           origA.ability,
      ability_2:         origA.ability_2 !== undefined ? origA.ability_2 : 0,
      pre_battle_hp:     hpA[i] !== null ? hpA[i] : origA.current_hp,
      current_hp:        hpA[i] !== null ? hpA[i] : origA.current_hp,
      destroyed:         prekilledA[i],
      ability_triggered: prekilledA[i] ? "Splash" : null,
    } : null;

    const resultB = origB ? {
      id:                origB.id,
      name:              origB.display_name || origB.name || "",
      display_name:      origB.display_name || origB.name || "",
      model_code:        origB.model_code || "",
      role:              origB.role,
      role_id:           origB.role_id !== undefined ? origB.role_id : 0,
      rarity:            origB.rarity   !== undefined ? origB.rarity : 0,
      offense:           origB.offense,
      defense:           origB.defense,
      ability:           origB.ability,
      ability_2:         origB.ability_2 !== undefined ? origB.ability_2 : 0,
      pre_battle_hp:     hpB[i] !== null ? hpB[i] : origB.current_hp,
      current_hp:        hpB[i] !== null ? hpB[i] : origB.current_hp,
      destroyed:         prekilledB[i],
      ability_triggered: prekilledB[i] ? "Splash" : null,
    } : null;

    const cardA = origA && !prekilledA[i] ? origA : null;
    const cardB = origB && !prekilledB[i] ? origB : null;

    if (cardA && cardB) {
      // ── Full combat ──────────────────────────────────────────────────────────
      const abilityJammedA = blackoutB || (cardHasAbility(origB, ABILITY.JAM) && !blackoutA);
      const abilityJammedB = blackoutA || (cardHasAbility(origA, ABILITY.JAM) && !blackoutB);

      if (!abilityJammedA && cardHasAbility(origA, ABILITY.JAM))      resultA.ability_triggered = "Jam";
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.JAM))      resultB.ability_triggered = "Jam";
      if (!abilityJammedA && cardHasAbility(origA, ABILITY.BLACKOUT)) resultA.ability_triggered = "Blackout";
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.BLACKOUT)) resultB.ability_triggered = "Blackout";

      let offA = origA.offense;
      let offB = origB.offense;

      if (!abilityJammedA && cardHasAbility(origA, ABILITY.COORDINATED)) offA += coordinatedBonus(origA, lanesA);
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.COORDINATED)) offB += coordinatedBonus(origB, lanesB);

      const multA = typeMultiplier(origA.role, origB.role);
      const multB = typeMultiplier(origB.role, origA.role);

      let dmgToB = Math.floor(offA * multA);
      let dmgToA = Math.floor(offB * multB);

      if (!abilityJammedB && cardHasAbility(origB, ABILITY.ARMOR)) dmgToB = Math.max(0, dmgToB - ARMOR_REDUCTION);
      if (!abilityJammedA && cardHasAbility(origA, ABILITY.ARMOR)) dmgToA = Math.max(0, dmgToA - ARMOR_REDUCTION);

      // INITIATIVE: first strike — opponent can't retaliate if destroyed
      const hasInitiativeA = !abilityJammedA && cardHasAbility(origA, ABILITY.INITIATIVE);
      const hasInitiativeB = !abilityJammedB && cardHasAbility(origB, ABILITY.INITIATIVE);

      const hpAbeforeCombat = resultA.current_hp;
      const hpBbeforeCombat = resultB.current_hp;

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

      // REFLECT: reflect a fraction of damage taken back to attacker
      const actualDmgToA = Math.max(0, hpAbeforeCombat - resultA.current_hp);
      const actualDmgToB = Math.max(0, hpBbeforeCombat - resultB.current_hp);
      if (!abilityJammedA && cardHasAbility(origA, ABILITY.REFLECT) && actualDmgToA > 0) {
        const reflectDmg = Math.floor(actualDmgToA * REFLECT_FRAC);
        if (reflectDmg > 0) {
          applyDamage(resultB, origB, reflectDmg, abilityJammedB);
          resultA.ability_triggered = "Reflect";
        }
      }
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.REFLECT) && actualDmgToB > 0) {
        const reflectDmg = Math.floor(actualDmgToB * REFLECT_FRAC);
        if (reflectDmg > 0) {
          applyDamage(resultA, origA, reflectDmg, abilityJammedA);
          resultB.ability_triggered = "Reflect";
        }
      }

      // EJECT: destroyed card returns to hand at 1 HP
      if (resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.EJECT)) {
        resultA.current_hp = 1; resultA.destroyed = false; resultA.ejected = true;
        resultA.ability_triggered = "Eject";
      }
      if (resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.EJECT)) {
        resultB.current_hp = 1; resultB.destroyed = false; resultB.ejected = true;
        resultB.ability_triggered = "Eject";
      }

      const aWinsFinal = !resultA.destroyed && resultB.destroyed;
      const bWinsFinal = !resultB.destroyed && resultA.destroyed;

      // VOLATILE: destroyed card explodes against ALL enemy lanes (winner + future)
      if (resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.VOLATILE)) {
        // A explodes — hits all of B's lanes; B's past cards are 'opponent_card' in laneResults
        splashVolatile(hpB, prekilledB, lanesB, i, Math.floor(offA * 0.5), bWinsFinal ? resultB : null, 'opponent');
        resultA.ability_triggered = "Volatile";
      }
      if (resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.VOLATILE)) {
        // B explodes — hits all of A's lanes; A's past cards are 'player_card' in laneResults
        splashVolatile(hpA, prekilledA, lanesA, i, Math.floor(offB * 0.5), aWinsFinal ? resultA : null, 'player');
        resultB.ability_triggered = "Volatile";
      }

      // FIELD_REPAIR: survivor heals at end of round
      if (!resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.FIELD_REPAIR)) {
        resultA.current_hp = Math.min(origA.defense, resultA.current_hp + FIELD_REPAIR_AMOUNT);
        resultA.ability_triggered = "Field Repair";
      }
      if (!resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.FIELD_REPAIR)) {
        resultB.current_hp = Math.min(origB.defense, resultB.current_hp + FIELD_REPAIR_AMOUNT);
        resultB.ability_triggered = "Field Repair";
      }

    } else {
      // ── Unopposed lane ───────────────────────────────────────────────────────
      const result = cardA ? resultA : resultB;
      const oCard  = cardA ? origA   : origB;
      const jammed = cardA ? blackoutB : blackoutA;

      if (oCard) {
        if (!jammed && cardHasAbility(oCard, ABILITY.BLACKOUT)) {
          result.ability_triggered = "Blackout";
        }
        if (!result.destroyed && !jammed && cardHasAbility(oCard, ABILITY.FIELD_REPAIR)) {
          result.current_hp = Math.min(oCard.defense, result.current_hp + FIELD_REPAIR_AMOUNT);
          result.ability_triggered = "Field Repair";
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
    battle_round:         room.round,
    lanes:                laneResults,
    player_scrap_count:   scrapA,
    opponent_scrap_count: scrapB,
    game_over:            gameOverA || gameOverB,
    result:               gameOverA ? "loss" : gameOverB ? "win" : null,
  };
  const resultForB = {
    battle_round:         room.round,
    lanes:                laneResults.map(r => r
      ? { player_card: r.opponent_card, opponent_card: r.player_card }
      : null),
    player_scrap_count:   scrapB,
    opponent_scrap_count: scrapA,
    game_over:            gameOverA || gameOverB,
    result:               gameOverB ? "loss" : gameOverA ? "win" : null,
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
