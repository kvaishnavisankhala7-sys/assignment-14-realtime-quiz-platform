const rooms = new Map();

function generatePin() {
  let pin;

  do {
    pin = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(pin));

  return pin;
}

function setupLobbyHandlers(io, socket) {
  socket.on("quiz:create", (data) => {
    const { hostName, category } = data;

    if (!hostName) {
      socket.emit("error", {
        message: "Host name is required"
      });
      return;
    }

    const pin = generatePin();

    const room = {
      pin,
      roomId: `quiz_${pin}`,
      hostId: socket.id,
      hostName,
      category: category || "General",
      players: [],
      gameStarted: false,
      currentQuestionIndex: -1
    };

    rooms.set(pin, room);

    socket.join(pin);

    socket.emit("quiz:created", {
      pin,
      roomId: room.roomId
    });

    updateLobby(io, room);
  });

  socket.on("quiz:join", (data) => {
    const { pin, playerName } = data;

    if (!pin || !playerName) {
      socket.emit("error", {
        message: "PIN and player name are required"
      });
      return;
    }

    const room = rooms.get(pin);

    if (!room) {
      socket.emit("error", {
        message: "Quiz room not found"
      });
      return;
    }

    if (room.gameStarted) {
      socket.emit("error", {
        message: "Quiz has already started"
      });
      return;
    }

    const existingPlayer = room.players.find(
      (player) => player.name === playerName
    );

    if (existingPlayer) {
      socket.emit("error", {
        message: "Player name already exists"
      });
      return;
    }

    const player = {
      id: socket.id,
      name: playerName,
      score: 0,
      answered: false
    };

    room.players.push(player);

    socket.join(pin);

    socket.emit("quiz:joined", {
      pin,
      playerId: socket.id
    });

    updateLobby(io, room);
  });

  socket.on("disconnect", () => {
    for (const [pin, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(
        (player) => player.id === socket.id
      );

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        updateLobby(io, room);
      }

      if (room.hostId === socket.id) {
        io.to(pin).emit("quiz:ended", {
          winner: null,
          finalRanks: [],
          message: "Host disconnected"
        });

        rooms.delete(pin);
      }
    }
  });
}

function updateLobby(io, room) {
  io.to(room.pin).emit("lobby:update", {
    players: room.players.map((player) => ({
      name: player.name,
      score: player.score
    }))
  });
}

module.exports = {
  rooms,
  setupLobbyHandlers
};