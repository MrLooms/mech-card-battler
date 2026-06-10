// ── Bot AI — single-player opponent ──────────────────────────────────────────
// Mirrors the 20 static cards from scr_card_database.gml.
// Ability / role / rarity values match GML enum integers exactly.

const HAND_SIZE = 5;
const MOMENTUM_ABILITY = 18;  // ABILITY.MOMENTUM

// All 20 static cards (integer role/rarity/ability to match player submissions)
const MASTER_DECK = [
  // Brawlers (role 0)
  { id:1,  name:"Slag Hammer",   display_name:"Slag Hammer",   model_code:"KRX-001", role:0, role_id:0, rarity:1, offense:8,  defense:6,  ability:14, ability_2:0 },
  { id:2,  name:"Crusher",       display_name:"Crusher",       model_code:"BR-055",  role:0, role_id:0, rarity:2, offense:10, defense:5,  ability:18, ability_2:0 },
  { id:3,  name:"Ironclad",      display_name:"Ironclad",      model_code:"IRN-112", role:0, role_id:0, rarity:2, offense:6,  defense:9,  ability:14, ability_2:0 },
  { id:4,  name:"Berserker",     display_name:"Berserker",     model_code:"MAL-248", role:0, role_id:0, rarity:3, offense:12, defense:3,  ability:24, ability_2:0 },
  // Artillery (role 1)
  { id:5,  name:"Longshot",      display_name:"Longshot",      model_code:"LNG-003", role:1, role_id:1, rarity:1, offense:7,  defense:4,  ability:17, ability_2:0 },
  { id:6,  name:"Siege Cannon",  display_name:"Siege Cannon",  model_code:"SIE-062", role:1, role_id:1, rarity:2, offense:9,  defense:3,  ability:15, ability_2:0 },
  { id:7,  name:"Mortar",        display_name:"Mortar",        model_code:"MRT-108", role:1, role_id:1, rarity:2, offense:8,  defense:5,  ability:1,  ability_2:0 },
  { id:8,  name:"Railgun",       display_name:"Railgun",       model_code:"RNG-301", role:1, role_id:1, rarity:3, offense:13, defense:2,  ability:17, ability_2:0 },
  // Shields (role 2)
  { id:9,  name:"Riot Guard",    display_name:"Riot Guard",    model_code:"GRD-007", role:2, role_id:2, rarity:1, offense:3,  defense:11, ability:1,  ability_2:0 },
  { id:10, name:"Fortress",      display_name:"Fortress",      model_code:"FRT-088", role:2, role_id:2, rarity:2, offense:4,  defense:13, ability:22, ability_2:0 },
  { id:11, name:"Aegis",         display_name:"Aegis",         model_code:"ARM-145", role:2, role_id:2, rarity:2, offense:5,  defense:10, ability:5,  ability_2:0 },
  { id:12, name:"Monolith",      display_name:"Monolith",      model_code:"BLK-290", role:2, role_id:2, rarity:3, offense:2,  defense:15, ability:24, ability_2:0 },
  // Scouts (role 3)
  { id:13, name:"Pathfinder",    display_name:"Pathfinder",    model_code:"SCT-011", role:3, role_id:3, rarity:1, offense:6,  defense:4,  ability:10, ability_2:0 },
  { id:14, name:"Blitz",         display_name:"Blitz",         model_code:"BLT-058", role:3, role_id:3, rarity:2, offense:7,  defense:4,  ability:18, ability_2:0 },
  { id:15, name:"Ghost",         display_name:"Ghost",         model_code:"GHT-133", role:3, role_id:3, rarity:2, offense:5,  defense:6,  ability:10, ability_2:0 },
  { id:16, name:"Phantom",       display_name:"Phantom",       model_code:"FLS-288", role:3, role_id:3, rarity:3, offense:8,  defense:3,  ability:17, ability_2:0 },
  // Recons (role 4)
  { id:17, name:"Signal Jammer", display_name:"Signal Jammer", model_code:"SIG-019", role:4, role_id:4, rarity:1, offense:4,  defense:6,  ability:5,  ability_2:0 },
  { id:18, name:"Interceptor",   display_name:"Interceptor",   model_code:"INT-066", role:4, role_id:4, rarity:1, offense:5,  defense:5,  ability:5,  ability_2:0 },
  { id:19, name:"Disruptor",     display_name:"Disruptor",     model_code:"DST-151", role:4, role_id:4, rarity:2, offense:6,  defense:5,  ability:16, ability_2:0 },
  { id:20, name:"ECLIPSE",       display_name:"ECLIPSE",       model_code:"SPY-420", role:4, role_id:4, rarity:3, offense:3,  defense:8,  ability:12, ability_2:0 },
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Attach bot state to a room object.
function initBot(room) {
  room.isAiRoom     = true;
  room.botDeck      = shuffle(MASTER_DECK).map(c => ({
    ...c,
    current_hp: c.defense,
    destroyed:  false,
  }));
  room.botHand      = [];
  room.botSurvivors = [null, null, null];  // cards locked in lanes between rounds
  room.botScrap     = 0;
}

// Draw cards until hand is full (or deck exhausted).
function botDrawToHand(room) {
  while (room.botHand.length < HAND_SIZE && room.botDeck.length > 0) {
    room.botHand.push(room.botDeck.shift());
  }
}

// Build a 3-lane submission for the bot (easy difficulty — random).
// Survivors stay in their lanes; remaining slots filled randomly from hand.
function botPickLanes(room) {
  const lanes = [null, null, null];

  // Locked survivors keep their lane
  for (let i = 0; i < 3; i++) {
    if (room.botSurvivors[i]) {
      lanes[i] = { ...room.botSurvivors[i] };
    }
  }

  // Find empty lane indices, shuffle them for random assignment
  const emptyLanes = shuffle([0, 1, 2].filter(i => lanes[i] === null));
  const playCards  = shuffle(room.botHand.slice());

  for (let i = 0; i < Math.min(emptyLanes.length, playCards.length); i++) {
    const card = playCards[i];
    lanes[emptyLanes[i]] = { ...card };
    // Remove from hand (match by id + current_hp to handle duplicates)
    const hi = room.botHand.findIndex(c => c.id === card.id && c.current_hp === card.current_hp);
    if (hi !== -1) room.botHand.splice(hi, 1);
  }

  return lanes;
}

// Update bot hand/survivors after a round resolves.
// laneResults is from the A-perspective: laneResults[i].opponent_card = bot result.
function botApplyResults(room, laneResults) {
  for (let i = 0; i < 3; i++) {
    const lr = laneResults[i];
    if (!lr || !lr.opponent_card) {
      room.botSurvivors[i] = null;
      continue;
    }

    const res = lr.opponent_card;

    if (res.destroyed) {
      room.botScrap++;
      room.botSurvivors[i] = null;
    } else if (res.ejected) {
      // EJECT: return to hand at 1 HP, ability burned
      const ejected = { ...res, current_hp: 1, ability: 0, ability_2: 0 };
      room.botHand.push(ejected);
      room.botSurvivors[i] = null;
    } else {
      // Survivor: stays in lane with updated HP
      const updated = { ...res };
      if (res.ability === MOMENTUM_ABILITY || res.ability_2 === MOMENTUM_ABILITY) {
        updated.offense = (updated.offense || 0) + 1;
      }
      room.botSurvivors[i] = updated;
    }
  }
}

module.exports = { initBot, botDrawToHand, botPickLanes, botApplyResults };
