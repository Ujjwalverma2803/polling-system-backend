const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const session = createEmptySession();

function createEmptySession() {
  return {
    code: null,
    teacher: null,
    participants: new Map(),
    currentPoll: null,
    responses: new Map(),
    history: [],
    messages: [],
  };
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function buildLeaderboard() {
  return Array.from(session.participants.values())
    .map((participant) => {
      const averageResponseTime = participant.answersCount
        ? (participant.totalResponseTime / participant.answersCount).toFixed(1)
        : "0.0";

      return {
        id: participant.id,
        name: participant.name,
        score: participant.score,
        answersCount: participant.answersCount,
        averageResponseTime,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return Number(left.averageResponseTime) - Number(right.averageResponseTime);
    });
}

function calculateResults() {
  if (!session.currentPoll) return {};

  return session.currentPoll.options.reduce((accumulator, option) => {
    accumulator[option.id] = 0;
    return accumulator;
  }, {});
}

function getResultSnapshot() {
  const counts = calculateResults();

  for (const response of session.responses.values()) {
    if (counts[response.optionId] !== undefined) {
      counts[response.optionId] += 1;
    }
  }

  return counts;
}

function getAnalytics() {
  const responsesReceived = session.responses.size;
  const participantsCount = session.participants.size;
  const responseRate = participantsCount
    ? Math.round((responsesReceived / participantsCount) * 100)
    : 0;
  const responseTimes = Array.from(session.responses.values()).map(
    (entry) => entry.responseTime
  );
  const averageResponseTime = responseTimes.length
    ? (
        responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
      ).toFixed(1)
    : "0.0";

  return {
    responsesReceived,
    participantsCount,
    responseRate,
    averageResponseTime,
  };
}

function serializeSession() {
  const currentPoll = session.currentPoll
    ? {
        id: session.currentPoll.id,
        question: session.currentPoll.question,
        options: session.currentPoll.options,
        duration: session.currentPoll.duration,
        timeLeft: session.currentPoll.timeLeft,
        mode: session.currentPoll.mode,
        status: session.currentPoll.status,
        startedAt: session.currentPoll.startedAt,
      }
    : null;

  return {
    code: session.code,
    teacher: session.teacher,
    participants: Array.from(session.participants.values()).map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: participant.score,
      answersCount: participant.answersCount,
    })),
    currentPoll,
    results: getResultSnapshot(),
    analytics: getAnalytics(),
    leaderboard: buildLeaderboard(),
    history: session.history,
    messages: session.messages.slice(-30),
  };
}

function broadcastSession() {
  io.emit("session-update", serializeSession());
}

function completePoll(reason = "completed") {
  if (!session.currentPoll) return;

  const results = getResultSnapshot();
  session.currentPoll = {
    ...session.currentPoll,
    status: reason,
    timeLeft: 0,
  };

  session.history.push({
    id: session.currentPoll.id,
    question: session.currentPoll.question,
    mode: session.currentPoll.mode,
    totalResponses: session.responses.size,
    completedAt: new Date().toISOString(),
    results,
  });

  broadcastSession();
}

function completeIfEveryoneAnswered() {
  if (!session.currentPoll || session.currentPoll.status !== "active") return;
  if (!session.participants.size) return;
  if (session.responses.size < session.participants.size) return;

  if (session.currentPoll.intervalId) {
    clearInterval(session.currentPoll.intervalId);
  }
  completePoll("completed");
}

function startTimer() {
  if (!session.currentPoll) return;

  clearInterval(session.currentPoll.intervalId);

  session.currentPoll.intervalId = setInterval(() => {
    if (!session.currentPoll) return;

    const timeLeft = Math.max(
      0,
      session.currentPoll.duration -
        Math.floor((Date.now() - session.currentPoll.startedAt) / 1000)
    );

    session.currentPoll.timeLeft = timeLeft;
    if (timeLeft === 0) {
      clearInterval(session.currentPoll.intervalId);
      completePoll("completed");
      return;
    }

    broadcastSession();
  }, 1000);
}

io.on("connection", (socket) => {
  socket.on("teacher-sync", () => {
    socket.emit("session-update", serializeSession());
  });

  socket.on("teacher-create-session", ({ teacherName }) => {
    if (session.currentPoll?.intervalId) {
      clearInterval(session.currentPoll.intervalId);
    }

    session.code = generateCode();
    session.teacher = {
      id: socket.id,
      name: teacherName?.trim() || "Host",
    };
    session.currentPoll = null;
    session.responses.clear();
    session.history = [];
    session.messages = [];
    session.participants.clear();

    broadcastSession();
  });

  socket.on("student-join", ({ name, sessionCode }) => {
    if (!session.code || sessionCode !== session.code) {
      socket.emit("join-error", { message: "That session code is not active." });
      return;
    }

    const participant = {
      id: socket.id,
      name: name?.trim() || "Anonymous",
      score: 0,
      answersCount: 0,
      totalResponseTime: 0,
    };

    session.participants.set(socket.id, participant);
    socket.data.role = "student";
    broadcastSession();
  });

  socket.on("teacher-start-poll", ({ question, options, duration, mode }) => {
    if (!session.code) return;

    if (session.currentPoll?.intervalId) {
      clearInterval(session.currentPoll.intervalId);
    }

    session.responses.clear();
    session.currentPoll = {
      id: Date.now().toString(),
      question,
      options: options.map((option, index) => ({
        id: option.id || `option-${index + 1}`,
        text: option.text,
        isCorrect: Boolean(option.isCorrect),
      })),
      duration: Number(duration) || 60,
      timeLeft: Number(duration) || 60,
      mode: mode === "poll" ? "poll" : "quiz",
      status: "active",
      startedAt: Date.now(),
      intervalId: null,
    };

    startTimer();
    broadcastSession();
  });

  socket.on("submit-answer", ({ optionId, responseTime = 0 }) => {
    if (!session.currentPoll || session.currentPoll.status !== "active") return;
    if (!session.participants.has(socket.id) || session.responses.has(socket.id)) return;

    const selectedOption = session.currentPoll.options.find(
      (option) => option.id === optionId
    );

    if (!selectedOption) return;

    session.responses.set(socket.id, {
      optionId,
      responseTime: Number(responseTime) || 0,
      submittedAt: new Date().toISOString(),
    });

    const participant = session.participants.get(socket.id);
    participant.answersCount += 1;
    participant.totalResponseTime += Number(responseTime) || 0;

    if (session.currentPoll.mode === "quiz" && selectedOption.isCorrect) {
      participant.score += Math.max(50, 100 - Math.floor(responseTime * 4));
    } else if (session.currentPoll.mode === "poll") {
      participant.score += 10;
    }

    completeIfEveryoneAnswered();
    if (session.currentPoll?.status === "completed") return;
    broadcastSession();
  });

  socket.on("send-message", ({ sender, role, text }) => {
    if (!text?.trim()) return;

    const message = {
      sender: sender || (role === "teacher" ? "Host" : "Participant"),
      role: role || "student",
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };

    session.messages.push(message);
    if (session.messages.length > 60) {
      session.messages = session.messages.slice(-60);
    }

    io.emit("receive-message", message);
    broadcastSession();
  });

  socket.on("kick-out", (participantId) => {
    if (!session.participants.has(participantId)) return;
    io.to(participantId).emit("kicked");
    session.participants.delete(participantId);
    session.responses.delete(participantId);
    completeIfEveryoneAnswered();
    if (session.currentPoll?.status === "completed") return;
    broadcastSession();
  });

  socket.on("disconnect", () => {
    if (session.teacher?.id === socket.id) {
      session.teacher = null;
    }

    if (session.participants.has(socket.id)) {
      session.participants.delete(socket.id);
      session.responses.delete(socket.id);
    }

    completeIfEveryoneAnswered();
    if (session.currentPoll?.status === "completed") return;
    broadcastSession();
  });
});

app.get("/session", (req, res) => {
  res.json(serializeSession());
});

app.get("/poll-history", (req, res) => {
  res.json(session.history);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
