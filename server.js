const express = require('express');
const path = require('path');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DEFAULT_QUESTION_DURATION_SECONDS = 30;
const QUESTION_DURATIONS_SECONDS = [30, 60, 90, 120];

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function roomExists(code) {
  return Boolean(rooms[code]);
}

function getRoom(code) {
  return rooms[code];
}

function resetCurrentQuestionState(room) {
  room.students.forEach((student) => {
    student.answered = false;
    student.lastAnswer = null;
  });
}

function clearQuestionTimer(room) {
  if (room.questionTimer) {
    clearTimeout(room.questionTimer);
    room.questionTimer = null;
  }
}

function closeQuestion(room) {
  if (room.questionClosed) {
    return;
  }

  room.questionClosed = true;
  clearQuestionTimer(room);
  io.to(room.code).emit('question-closed');
}

function startQuestionTimer(room) {
  clearQuestionTimer(room);
  room.questionClosed = false;
  const durationMs = room.questionDurationSeconds * 1000;
  room.questionEndsAt = Date.now() + durationMs;
  room.questionTimer = setTimeout(() => {
    if (rooms[room.code] === room && room.active) {
      closeQuestion(room);
    }
  }, durationMs);
}

function buildQuestionPayload(question, index, total, room) {
  return {
    kind: question.kind,
    prompt: question.prompt,
    equations: question.equations,
    answers: question.answers,
    correct: question.correct,
    explanation: question.explanation,
    index,
    total,
    durationSeconds: room.questionDurationSeconds,
    expiresAt: room.questionEndsAt,
    serverNow: Date.now(),
    closed: room.questionClosed,
  };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

app.get('/student', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/connection-info', (req, res) => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  const addresses = renderUrl
    ? []
    : Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && address.family === 'IPv4' && !address.internal)
      .map((address) => `http://${address.address}:${PORT}/student`);

  res.json({
    studentUrl: renderUrl
      ? `${renderUrl}/student`
      : `${req.protocol}://${req.get('host')}/student`,
    networkUrls: addresses,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

io.on('connection', (socket) => {
  socket.on('create-room', () => {
    Object.keys(rooms).forEach((code) => {
      if (rooms[code].teacherSocketId === socket.id) {
        clearQuestionTimer(rooms[code]);
        delete rooms[code];
        io.to(code).emit('teacher-disconnected', { code });
      }
    });

    let code = generateRoomCode();
    while (roomExists(code)) {
      code = generateRoomCode();
    }

    rooms[code] = {
      code,
      teacherSocketId: socket.id,
      students: [],
      active: false,
      questions: [],
      currentQuestionIndex: 0,
      questionDurationSeconds: DEFAULT_QUESTION_DURATION_SECONDS,
      questionEndsAt: 0,
      questionClosed: false,
      questionTimer: null,
    };

    socket.join(code);
    socket.emit('room-created', { code });
    socket.emit('room-state', { roomCode: code, students: rooms[code].students });
  });

  socket.on('join-room', ({ code, name }) => {
    const room = getRoom(String(code).toUpperCase());
    if (!room) {
      socket.emit('join-error', { message: 'That room code was not found.' });
      return;
    }

    const cleanName = String(name || '').trim();
    if (!cleanName) {
      socket.emit('join-error', { message: 'Please enter your name.' });
      return;
    }

    const existingStudent = room.students.find((student) => student.id === socket.id);
    if (!existingStudent) {
      room.students.push({
        id: socket.id,
        name: cleanName,
        score: 0,
        answered: false,
        lastAnswer: null,
      });
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.studentName = cleanName;

    socket.emit('joined-room', { code, name: cleanName });
    io.to(code).emit('room-state', {
      roomCode: code,
      students: room.students.map((student) => ({
        id: student.id,
        name: student.name,
        score: student.score,
        answered: student.answered,
      })),
    });

    if (room.active && room.questions[room.currentQuestionIndex]) {
      socket.emit('question-update', buildQuestionPayload(
        room.questions[room.currentQuestionIndex],
        room.currentQuestionIndex,
        room.questions.length,
        room,
      ));
    }
  });

  socket.on('share-questions', ({ code, questions, durationSeconds }) => {
    const room = getRoom(String(code).toUpperCase());
    if (!room || room.teacherSocketId !== socket.id) {
      return;
    }

    const selectedDuration = durationSeconds === undefined
      ? DEFAULT_QUESTION_DURATION_SECONDS
      : Number(durationSeconds);
    if (!QUESTION_DURATIONS_SECONDS.includes(selectedDuration)) {
      socket.emit('game-error', { message: 'Choose a 30-, 60-, 90-, or 120-second question timer.' });
      return;
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return;
    }

    room.questions = questions;
    room.currentQuestionIndex = 0;
    room.questionDurationSeconds = selectedDuration;
    room.active = true;
    resetCurrentQuestionState(room);
    startQuestionTimer(room);

    io.to(code).emit('question-update', buildQuestionPayload(room.questions[0], 0, room.questions.length, room));
    io.to(code).emit('room-state', {
      roomCode: code,
      students: room.students.map((student) => ({
        id: student.id,
        name: student.name,
        score: student.score,
        answered: student.answered,
      })),
    });
  });

  socket.on('next-question', ({ code }) => {
    const room = getRoom(String(code).toUpperCase());
    if (!room || room.teacherSocketId !== socket.id) {
      return;
    }

    const nextIndex = room.currentQuestionIndex + 1;
    if (nextIndex >= room.questions.length) {
      clearQuestionTimer(room);
      room.active = false;
      room.questionClosed = true;
      io.to(code).emit('game-finished', {
        roomCode: code,
        students: room.students.map((student) => ({
          id: student.id,
          name: student.name,
          score: student.score,
        })),
      });
      return;
    }

    room.currentQuestionIndex = nextIndex;
    resetCurrentQuestionState(room);
    startQuestionTimer(room);
    io.to(code).emit('question-update', buildQuestionPayload(
      room.questions[room.currentQuestionIndex],
      room.currentQuestionIndex,
      room.questions.length,
      room,
    ));
    io.to(code).emit('room-state', {
      roomCode: code,
      students: room.students.map((student) => ({
        id: student.id,
        name: student.name,
        score: student.score,
        answered: student.answered,
      })),
    });
  });

  socket.on('submit-answer', ({ code, answer }) => {
    const room = getRoom(String(code).toUpperCase());
    if (!room || !room.active) {
      return;
    }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion) {
      return;
    }

    const student = room.students.find((entry) => entry.id === socket.id);
    if (room.questionClosed || Date.now() >= room.questionEndsAt) {
      closeQuestion(room);
      socket.emit('answer-feedback', { locked: true, closed: true, score: student ? student.score : 0 });
      return;
    }

    if (!student || student.answered) {
      socket.emit('answer-feedback', { locked: true, score: student ? student.score : 0 });
      return;
    }

    const isCorrect = currentQuestion.correct === answer;
    if (isCorrect) {
      student.score += 1;
    }

    student.answered = true;
    student.lastAnswer = answer;

    socket.emit('answer-feedback', {
      correct: isCorrect,
      score: student.score,
      answer: answer,
      expected: currentQuestion.correct,
    });

    io.to(code).emit('room-state', {
      roomCode: code,
      students: room.students.map((entry) => ({
        id: entry.id,
        name: entry.name,
        score: entry.score,
        answered: entry.answered,
      })),
    });
  });

  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.teacherSocketId === socket.id) {
        clearQuestionTimer(room);
        delete rooms[code];
        io.to(code).emit('teacher-disconnected', { code });
        return;
      }

      const index = room.students.findIndex((student) => student.id === socket.id);
      if (index >= 0) {
        room.students.splice(index, 1);
        io.to(code).emit('room-state', {
          roomCode: code,
          students: room.students.map((student) => ({
            id: student.id,
            name: student.name,
            score: student.score,
            answered: student.answered,
          })),
        });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Math quiz server running at http://localhost:${PORT}`);
});
