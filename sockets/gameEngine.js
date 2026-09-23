const { rooms } = require("./lobbyHandler");
const questions = require("../data/questions.json");

const timers = new Map();

const TIME_LIMIT_MS = 15000;
const NEXT_QUESTION_DELAY_MS = 3000;

// Score = Base 500 + Speed Bonus up to 500
function calculateScore(
  isCorrect,
  timeTakenMs,
  totalTimeLimitMs = TIME_LIMIT_MS
) {
  if (!isCorrect) return 0;

  const timeRemaining = Math.max(
    0,
    totalTimeLimitMs - timeTakenMs
  );

  const speedBonus = Math.round(
    (timeRemaining / totalTimeLimitMs) * 500
  );

  const baseScore = 500;

  return baseScore + speedBonus;
}

function clearRoomTimer(pin) {
  const timer = timers.get(pin);

  if (timer) {
    clearTimeout(timer);
    timers.delete(pin);
  }
}

function getLeaderboard(room) {
  return [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((player, index) => ({
      rank: index + 1,
      name: player.name,
      score: player.score
    }));
}

function startNextQuestion(io, room) {
  // Room may have been deleted if host disconnected
  if (rooms.get(room.pin) !== room) {
    clearRoomTimer(room.pin);
    return;
  }

  room.currentQuestionIndex++;

  // All questions completed
  if (room.currentQuestionIndex >= questions.length) {
    endQuiz(io, room);
    return;
  }

  clearRoomTimer(room.pin);

  room.players.forEach((player) => {
    player.answered = false;
  });

  const question = questions[room.currentQuestionIndex];

  room.questionActive = true;
  room.questionStartedAt = Date.now();

  // Send question WITHOUT correct answer
  io.to(room.pin).emit("question:start", {
    questionIndex: room.currentQuestionIndex + 1,
    totalQuestions: questions.length,
    question: question.question,
    options: question.options,
    timeLimitSeconds: 15
  });

  // Server-controlled timer
  const timer = setTimeout(() => {
    endQuestion(io, room);
  }, TIME_LIMIT_MS);

  timers.set(room.pin, timer);
}

function endQuestion(io, room) {
  if (rooms.get(room.pin) !== room) {
    clearRoomTimer(room.pin);
    return;
  }

  // Prevent the function from running twice
  if (!room.questionActive) {
    return;
  }

  room.questionActive = false;

  clearRoomTimer(room.pin);

  const question = questions[room.currentQuestionIndex];

  // Reveal correct answer
  io.to(room.pin).emit("question:time_up", {
    correctOption: question.correctOption,
    explanation: question.explanation
  });

  // Send updated leaderboard
  io.to(room.pin).emit("leaderboard:update", {
    leaderboard: getLeaderboard(room)
  });

  // Give players a short break before next question
  setTimeout(() => {
    startNextQuestion(io, room);
  }, NEXT_QUESTION_DELAY_MS);
}

function endQuiz(io, room) {
  clearRoomTimer(room.pin);

  room.questionActive = false;
  room.gameStarted = false;

  const finalRanks = getLeaderboard(room);

  const winner =
    finalRanks.length > 0
      ? {
          name: finalRanks[0].name,
          score: finalRanks[0].score
        }
      : null;

  io.to(room.pin).emit("quiz:ended", {
    winner,
    finalRanks
  });
}

function setupGameHandlers(io, socket) {
  // HOST STARTS QUIZ
  socket.on("quiz:start", (data) => {
    const { pin } = data;

    const room = rooms.get(pin);

    if (!room) {
      socket.emit("error", {
        message: "Quiz room not found"
      });
      return;
    }

    // Only host can start
    if (room.hostId !== socket.id) {
      socket.emit("error", {
        message: "Only the host can start the quiz"
      });
      return;
    }

    if (room.gameStarted) {
      socket.emit("error", {
        message: "Quiz has already started"
      });
      return;
    }

    if (room.players.length === 0) {
      socket.emit("error", {
        message: "At least one player is required"
      });
      return;
    }

    room.gameStarted = true;
    room.currentQuestionIndex = -1;

    startNextQuestion(io, room);
  });

  // PLAYER SUBMITS ANSWER
  socket.on("answer:submit", (data) => {
    const { pin, selectedOption } = data;

    const room = rooms.get(pin);

    if (!room) {
      socket.emit("error", {
        message: "Quiz room not found"
      });
      return;
    }

    if (!room.gameStarted || !room.questionActive) {
      socket.emit("error", {
        message: "There is no active question"
      });
      return;
    }

    const player = room.players.find(
      (player) => player.id === socket.id
    );

    if (!player) {
      socket.emit("error", {
        message: "You are not part of this quiz"
      });
      return;
    }

    // Prevent multiple answers
    if (player.answered) {
      socket.emit("error", {
        message: "You have already answered this question"
      });
      return;
    }

    // SERVER decides the actual time
    // We don't trust the client's timeTakenMs.
    const serverTimeTaken =
      Date.now() - room.questionStartedAt;

    // Reject late answers
    if (serverTimeTaken >= TIME_LIMIT_MS) {
      endQuestion(io, room);

      socket.emit("error", {
        message: "Time is up. Your answer was not accepted."
      });

      return;
    }

    const question =
      questions[room.currentQuestionIndex];

    const isCorrect =
      Number(selectedOption) === question.correctOption;

    const score = calculateScore(
      isCorrect,
      serverTimeTaken,
      TIME_LIMIT_MS
    );

    player.score += score;
    player.answered = true;

    // Send updated leaderboard
    io.to(room.pin).emit("leaderboard:update", {
      leaderboard: getLeaderboard(room)
    });

    // If everyone answered early, end the question
    const everyoneAnswered = room.players.every(
      (player) => player.answered
    );

    if (everyoneAnswered) {
      endQuestion(io, room);
    }
  });
}

module.exports = {
  setupGameHandlers,
  calculateScore
};