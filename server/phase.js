const { broadcastToRoom, deleteRoom } = require("./rooms");

/**
 * Handle a PHASE_DRAW_COMPLETE message from one player.
 * Once both players confirm, advance to PLAY.
 */
function handleDrawComplete(room, ws) {
  room.drawReady = (room.drawReady || 0) + 1;
  if (room.drawReady >= 2) {
    room.drawReady = 0;
    room.phase = "PLAY";
    broadcastToRoom(room, { type: "PHASE_BEGIN", data: { phase: "PLAY", round: room.round } });
  }
}

/**
 * Handle a PHASE_PLAY_SUBMIT message from one player.
 * Stores their submitted cards. When both have submitted, resolves the round.
 */
function handlePlaySubmit(room, ws, data) {
  room.submissions[ws.userId] = data.cards || [];

  if (Object.keys(room.submissions).length >= 2) {
    resolveRound(room);
  }
}

/**
 * Resolve the round: compute outcomes and broadcast results.
 * This is intentionally minimal — the actual combat logic will go here.
 */
function resolveRound(room) {
  room.phase = "RESOLVE";

  const [wsA, wsB] = room.players;
  const cardsA = room.submissions[wsA.userId] || [];
  const cardsB = room.submissions[wsB.userId] || [];

  // Placeholder resolution — replace with real combat logic
  const resolveResult = {
    round:       room.round,
    player_hp:   30,  // computed from combat
    opponent_hp: 30,
    board:       cardsA,
    opp_board:   cardsB,
  };

  // Send each player a mirrored view
  if (wsA.readyState === 1) {
    wsA.send(JSON.stringify({ type: "PHASE_RESOLVE_RESULT", data: resolveResult }));
  }
  if (wsB.readyState === 1) {
    wsB.send(JSON.stringify({
      type: "PHASE_RESOLVE_RESULT",
      data: { ...resolveResult, board: cardsB, opp_board: cardsA },
    }));
  }

  room.submissions = {};
  room.cleanupReady = 0;
}

/**
 * Handle a PHASE_CLEANUP_COMPLETE ack from one player.
 * Once both ack, start the next round's DRAW phase.
 */
function handleCleanupComplete(room) {
  room.cleanupReady = (room.cleanupReady || 0) + 1;
  if (room.cleanupReady >= 2) {
    room.cleanupReady = 0;
    room.round++;
    room.phase = "DRAW";
    broadcastToRoom(room, { type: "PHASE_BEGIN", data: { phase: "DRAW", round: room.round } });
  }
}

module.exports = { handleDrawComplete, handlePlaySubmit, handleCleanupComplete };
