require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");
const { verifyToken } = require("./auth");
const { enqueue, dequeue, getRoom, deleteRoom, broadcastToRoom } = require("./rooms");
const { handleDrawComplete, handlePlaySubmit, handleCleanupComplete } = require("./phase");

const PORT = process.env.PORT || 3000;

// Basic HTTP server — Render needs an HTTP listener to keep the service alive
const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Mech Card Battler relay server running");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  // Expect the client to send an AUTH message first
  ws.authenticated = false;
  ws.userId = null;
  ws.roomId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, data } = msg;

    // ── Auth gate ──────────────────────────────────────────────
    if (!ws.authenticated) {
      if (type !== "AUTH_LOGIN") {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", data: { error: "Not authenticated" } }));
        return;
      }

      const payload = verifyToken(data.token);
      if (!payload) {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", data: { error: "Invalid token" } }));
        ws.close();
        return;
      }

      ws.authenticated = true;
      ws.userId   = payload.sub;
      ws.username = payload.user_metadata?.username || "Unknown";
      ws.send(JSON.stringify({
        type: "AUTH_RESPONSE",
        data: {
          success:       true,
          user_id:       ws.userId,
          username:      ws.username,
          access_token:  data.token,
          refresh_token: data.refresh_token || "",
          rank:          0, // fetch from DB if needed
        },
      }));
      console.log(`Authenticated: ${ws.username} (${ws.userId})`);
      return;
    }

    // ── Matchmaking ────────────────────────────────────────────
    if (type === "MATCH_QUEUE")  { enqueue(ws); return; }
    if (type === "MATCH_CANCEL") { dequeue(ws); return; }

    // ── In-game messages ───────────────────────────────────────
    const room = ws.roomId ? getRoom(ws.roomId) : null;
    if (!room) return;

    switch (type) {
      case "PHASE_DRAW_COMPLETE":    handleDrawComplete(room, ws);          break;
      case "PHASE_PLAY_SUBMIT":      handlePlaySubmit(room, ws, data);      break;
      case "PHASE_CLEANUP_COMPLETE": handleCleanupComplete(room);           break;
    }
  });

  ws.on("close", () => {
    dequeue(ws);
    if (ws.roomId) {
      const room = getRoom(ws.roomId);
      if (room) {
        broadcastToRoom(room, { type: "OPPONENT_DISCONNECT", data: {} });
        deleteRoom(ws.roomId);
      }
    }
    console.log(`Disconnected: ${ws.userId || "unauthenticated"}`);
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});

httpServer.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
