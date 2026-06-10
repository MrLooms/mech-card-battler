const { broadcastToRoom } = require("./rooms");
const { botPickLanes, botApplyResults, botDrawToHand } = require("./bot");

// ── Type chart ────────────────────────────────────────────────────────────────
const BEATS = {
  Brawler:   ["Scout", "Recon"],
  Artillery: ["Shield", "Brawler"],
  Shield:    ["Brawler", "Scout"],
  Scout:     ["Artillery", "Recon"],
  Recon:     ["Artillery", "Shield"],
};

// GML sends role as an integer enum (0-4); strings also accepted for flexibility.
const ROLE_NAMES = {
  0: "Brawler", 1: "Artillery", 2: "Shield", 3: "Scout", 4: "Recon",
};

function typeMultiplier(attackerRole, defenderRole) {
  // Normalise integer or string roles to string keys
  const a = ROLE_NAMES[attackerRole] || attackerRole;
  const d = ROLE_NAMES[defenderRole] || defenderRole;
  const beats = BEATS[a] || [];
  if (beats.includes(d)) return 2;
  for (const [role, beaten] of Object.entries(BEATS)) {
    if (role === a) continue;
    if (beaten.includes(a) && role === d) return 0.5;
  }
  return 1;
}

// ── Ability constants (match GML ABILITY enum order) ─────────────────────────
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

// ── Accumulate triggered ability names (handles dual-ability cards) ───────────
function addTriggered(result, name) {
  if (!result.ability_triggered || result.ability_triggered === null) {
    result.ability_triggered = name;
  } else if (result.ability_triggered !== "Splash" && result.ability_triggered !== name) {
    result.ability_triggered = result.ability_triggered + " + " + name;
  }
}

// ── Phase: Draw complete ──────────────────────────────────────────────────────
function handleDrawComplete(room, ws) {
  // AI room: human ready counts as both ready
  const needed = room.isAiRoom ? 1 : 2;
  room.drawReady = (room.drawReady || 0) + 1;
  if (room.drawReady >= needed) {
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

  // AI room: generate bot lanes immediately when human submits
  if (room.isAiRoom && !room.submissions["bot"]) {
    room.submissions["bot"] = botPickLanes(room);
  }

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
  function splashVolatile(hp, prekilled, lanes, fromLane, damage, winnerResult, pastSide) {
    for (let j = 0; j < fromLane; j++) {
      if (!laneResults[j]) continue;
      const pastCard = pastSide === 'player'
        ? laneResults[j].player_card
        : laneResults[j].opponent_card;
      if (pastCard && !pastCard.destroyed) {
        pastCard.current_hp = Math.max(0, pastCard.current_hp - damage);
        if (pastCard.current_hp <= 0) { pastCard.current_hp = 0; pastCard.destroyed = true; }
      }
    }
    if (winnerResult && !winnerResult.destroyed) {
      winnerResult.current_hp = Math.max(0, winnerResult.current_hp - damage);
      if (winnerResult.current_hp <= 0) { winnerResult.current_hp = 0; winnerResult.destroyed = true; }
    }
    splashFutureLanes(hp, prekilled, lanes, fromLane, damage);
  }

  function coordinatedBonus(card, allLanes) {
    let count = 0;
    for (const c of allLanes) {
      if (c && c !== card && c.role === card.role) count++;
    }
    return count * 2;
  }

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

      if (!abilityJammedA && cardHasAbility(origA, ABILITY.JAM))      addTriggered(resultA, "Jam");
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.JAM))      addTriggered(resultB, "Jam");
      if (!abilityJammedA && cardHasAbility(origA, ABILITY.BLACKOUT)) addTriggered(resultA, "Blackout");
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.BLACKOUT)) addTriggered(resultB, "Blackout");

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

      const hasInitiativeA = !abilityJammedA && cardHasAbility(origA, ABILITY.INITIATIVE);
      const hasInitiativeB = !abilityJammedB && cardHasAbility(origB, ABILITY.INITIATIVE);

      const hpAbeforeCombat = resultA.current_hp;
      const hpBbeforeCombat = resultB.current_hp;

      if (hasInitiativeA && !hasInitiativeB) {
        applyDamage(resultB, origB, dmgToB, abilityJammedB);
        if (!resultB.destroyed) applyDamage(resultA, origA, dmgToA, abilityJammedA);
        addTriggered(resultA, "Initiative");
      } else if (hasInitiativeB && !hasInitiativeA) {
        applyDamage(resultA, origA, dmgToA, abilityJammedA);
        if (!resultA.destroyed) applyDamage(resultB, origB, dmgToB, abilityJammedB);
        addTriggered(resultB, "Initiative");
      } else {
        applyDamage(resultB, origB, dmgToB, abilityJammedB);
        applyDamage(resultA, origA, dmgToA, abilityJammedA);
      }

      const actualDmgToA = Math.max(0, hpAbeforeCombat - resultA.current_hp);
      const actualDmgToB = Math.max(0, hpBbeforeCombat - resultB.current_hp);
      if (!abilityJammedA && cardHasAbility(origA, ABILITY.REFLECT) && actualDmgToA > 0) {
        const reflectDmg = Math.floor(actualDmgToA * REFLECT_FRAC);
        if (reflectDmg > 0) {
          applyDamage(resultB, origB, reflectDmg, abilityJammedB);
          addTriggered(resultA, "Reflect");
        }
      }
      if (!abilityJammedB && cardHasAbility(origB, ABILITY.REFLECT) && actualDmgToB > 0) {
        const reflectDmg = Math.floor(actualDmgToB * REFLECT_FRAC);
        if (reflectDmg > 0) {
          applyDamage(resultA, origA, reflectDmg, abilityJammedA);
          addTriggered(resultB, "Reflect");
        }
      }

      if (resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.EJECT)) {
        resultA.current_hp = 1; resultA.destroyed = false; resultA.ejected = true;
        addTriggered(resultA, "Eject");
      }
      if (resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.EJECT)) {
        resultB.current_hp = 1; resultB.destroyed = false; resultB.ejected = true;
        addTriggered(resultB, "Eject");
      }

      const aWinsFinal = !resultA.destroyed && resultB.destroyed;
      const bWinsFinal = !resultB.destroyed && resultA.destroyed;

      if (resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.VOLATILE)) {
        splashVolatile(hpB, prekilledB, lanesB, i, Math.floor(offA * 0.5), bWinsFinal ? resultB : null, 'opponent');
        addTriggered(resultA, "Volatile");
      }
      if (resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.VOLATILE)) {
        splashVolatile(hpA, prekilledA, lanesA, i, Math.floor(offB * 0.5), aWinsFinal ? resultA : null, 'player');
        addTriggered(resultB, "Volatile");
      }

      if (!resultA.destroyed && !abilityJammedA && cardHasAbility(origA, ABILITY.FIELD_REPAIR)) {
        resultA.current_hp = Math.min(origA.defense, resultA.current_hp + FIELD_REPAIR_AMOUNT);
        addTriggered(resultA, "Field Repair");
      }
      if (!resultB.destroyed && !abilityJammedB && cardHasAbility(origB, ABILITY.FIELD_REPAIR)) {
        resultB.current_hp = Math.min(origB.defense, resultB.current_hp + FIELD_REPAIR_AMOUNT);
        addTriggered(resultB, "Field Repair");
      }

    } else {
      // ── Unopposed lane ───────────────────────────────────────────────────────
      const result = cardA ? resultA : resultB;
      const oCard  = cardA ? origA   : origB;
      const jammed = cardA ? blackoutB : blackoutA;

      if (oCard) {
        if (!jammed && cardHasAbility(oCard, ABILITY.BLACKOUT)) {
          addTriggered(result, "Blackout");
        }
        if (!result.destroyed && !jammed && cardHasAbility(oCard, ABILITY.FIELD_REPAIR)) {
          result.current_hp = Math.min(oCard.defense, result.current_hp + FIELD_REPAIR_AMOUNT);
          addTriggered(result, "Field Repair");
        }
      }
    }

    laneResults.push({ player_card: resultA, opponent_card: resultB });
  }

  // ── Update bot state from results ─────────────────────────────────────────
  if (room.isAiRoom) {
    botApplyResults(room, laneResults);
  }

  // ── Tally scrap ───────────────────────────────────────────────────────────
  const scrapA = room.scrapA = (room.scrapA || 0)
    + laneResults.filter(r => r && r.player_card   && r.player_card.destroyed).length;
  const scrapB = room.scrapB = (room.scrapB || 0)
    + laneResults.filter(r => r && r.opponent_card && r.opponent_card.destroyed).length;

  // For AI rooms, bot scrap count overrides the automatic tally
  const effectiveScrapB = room.isAiRoom ? room.botScrap : scrapB;

  const gameOverA = scrapA >= 20;
  const gameOverB = effectiveScrapB >= 20;

  const resultForA = {
    battle_round:         room.round,
    lanes:                laneResults,
    player_scrap_count:   scrapA,
    opponent_scrap_count: effectiveScrapB,
    game_over:            gameOverA || gameOverB,
    result:               gameOverA ? "loss" : gameOverB ? "win" : null,
  };
  const resultForB = {
    battle_round:         room.round,
    lanes:                laneResults.map(r => r
      ? { player_card: r.opponent_card, opponent_card: r.player_card }
      : null),
    player_scrap_count:   effectiveScrapB,
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
  const needed = room.isAiRoom ? 1 : 2;
  room.cleanupReady = (room.cleanupReady || 0) + 1;
  if (room.cleanupReady >= needed) {
    room.cleanupReady = 0;
    room.round++;
    room.phase = "DRAW";
    // Bot draws for the new round before PHASE_BEGIN goes out
    if (room.isAiRoom) botDrawToHand(room);
    broadcastToRoom(room, {
      type: "PHASE_BEGIN",
      data: { phase: "DRAW", battle_round: room.round },
    });
  }
}

module.exports = { handleDrawComplete, handlePlacementSubmit, handleCleanupComplete };
