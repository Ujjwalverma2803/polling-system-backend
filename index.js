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
    origin: "*", // Adjust in production
    methods: ["GET", "POST"],
  },
});

let currentPoll = null;
let responses = {};
let students = new Map(); // socket.id -> name
let pollHistory = [];

// Send updated student list to all
function broadcastParticipants() {
  const participantNames = Array.from(students.values());
  io.emit("participant-list", participantNames);
}


// Helper: Count responses
function calculateResults() {
  if (!currentPoll) return {};
  const counts = {};
  for (const option of currentPoll.options) {
    counts[option] = 0;
  }
  Object.values(responses).forEach((answer) => {
    if (counts.hasOwnProperty(answer)) {
      counts[answer]++;
    }
  });
  return counts;
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);
  socket.on("send-message", (message) => {
    io.emit("receive-message", message);
  });
  // Sync current poll
  if (currentPoll) {
    socket.emit("new-question", currentPoll);
    socket.emit("live-results", calculateResults());
  }

  // Register student
  socket.on("join-student", (name) => {
    console.log("join-student event received with name:", name);
    const studentName = name || "Anonymous";
    students.set(socket.id, studentName);

    // ✅ Save the name on the socket object too
    socket.studentName = studentName;

    console.log("Student registered:", socket.id, "->", studentName);

    socket.emit("new-question", currentPoll);
    socket.emit("live-results", calculateResults());

    broadcastParticipants();
  });

  // Teacher sends a new poll
  socket.on("new-question", ({ question, options, duration }) => {
    currentPoll = { question, options, duration };
    responses = {};
    io.emit("new-question", currentPoll);
    console.log("New poll:", currentPoll);
  });

  // Student submits an answer
  socket.on("submit-answer", ({ answerIndex }) => {
    if (!students.has(socket.id)) return;
    if (responses[socket.id]) return;

    if (
      typeof answerIndex !== "number" ||
      !currentPoll ||
      answerIndex < 0 ||
      answerIndex >= currentPoll.options.length
    ) {
      return; // Invalid answerIndex
    }

    const selectedAnswer = currentPoll.options[answerIndex];
    responses[socket.id] = selectedAnswer;

    const currentResults = calculateResults();
    io.emit("live-results", currentResults);

    if (Object.keys(responses).length >= students.size) {
      const finalResults = calculateResults();
      io.emit("poll-complete", finalResults);

      pollHistory.push({
        poll: currentPoll,
        results: finalResults,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // When teacher kicks out a student
  socket.on("kick-out", (studentName) => {
    for (const [id, name] of students.entries()) {
      if (name === studentName) {
        io.to(id).emit("kicked"); // Notify student
        students.delete(id); // Remove from student map
        delete responses[id]; // Remove any answer they gave
        break;
      }
    }

    broadcastParticipants(); // Refresh participant list for everyone
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    students.delete(socket.id);
    delete responses[socket.id];
    broadcastParticipants();
  });
});

// HTTP routes
app.get("/live-results", (req, res) => {
  if (!currentPoll) {
    return res.status(404).json({ message: "No active poll" });
  }
  res.json({
    poll: currentPoll,
    results: calculateResults(),
    totalStudents: students.size,
    responsesReceived: Object.keys(responses).length,
  });
});

app.get("/poll-history", (req, res) => {
  res.json(pollHistory);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

