// Active match rooms: roomId -> { players: [ws, ws], state: {} }
const rooms = new Map();

// Matchmaking queue: array of waiting ws clients
const queue = [];

/**
 * Add a player to the matchmaking queue.
 * If another player is already waiting, pair them into a new room.
 */
function enqueue(ws) {
  if (queue.includes(ws)) return;

  if (queue.length > 0) {
    const opponent = queue.shift();
    createRoom(ws, opponent);
  } else {
    queue.push(ws);
    ws.send(JSON.stringify({ type: "MATCH_QUEUE", data: { status: "waiting" } }));
  }
}

/**
 * Remove a player from the queue (e.g. on disconnect or cancel).
 */
function dequeue(ws) {
  const i = queue.indexOf(ws);
  if (i !== -1) queue.splice(i, 1);
}

/**
 * Create a match room between two WebSocket clients.
 */
function createRoom(wsA, wsB) {
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const room = {
    id: roomId,
    players: [wsA, wsB],
    phase: "DRAW",
    round: 1,
    submissions: {},   // userId -> submitted card array
  };

  rooms.set(roomId, room);
  wsA.roomId = roomId;
  wsB.roomId = roomId;

  const matchData = { room_id: roomId };
  wsA.send(JSON.stringify({ type: "MATCH_FOUND", data: { ...matchData, player_index: 0 } }));
  wsB.send(JSON.stringify({ type: "MATCH_FOUND", data: { ...matchData, player_index: 1 } }));

  // Delay PHASE_BEGIN so the clients have time to transition into rm_battle
  setTimeout(() => {
    broadcastToRoom(room, { type: "PHASE_BEGIN", data: { phase: "DRAW", battle_round: 1 } });
    room.phase = "DRAW";
  }, 800);

  console.log(`Room created: ${roomId}`);
}

/**
 * Send a message to all players in a room.
 */
function broadcastToRoom(room, msg) {
  const str = JSON.stringify(msg);
  for (const ws of room.players) {
    if (ws.readyState === 1) ws.send(str);
  }
}

/**
 * Get a room by its ID.
 */
function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

/**
 * Remove a room. Called on game over or disconnect.
 */
function deleteRoom(roomId) {
  rooms.delete(roomId);
}

module.exports = { enqueue, dequeue, getRoom, deleteRoom, broadcastToRoom };
