const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── État du jeu ───────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'imperien2024';

let gameState = {
  phase: 'lobby',       // lobby | manche_intro | playing | round_end | final | finished
  players: {},          // { id: { pseudo, score, eliminated, answered, answer, answerTime } }
  currentRound: 0,
  currentQuestion: 0,
  questions: [],
  roundName: '',
  timerValue: 30,
  paused: false,
  showResults: false,
};

let timerInterval = null;
let timerStart = null;

// ─── Noms de manches Saint Seiya ───────────────────────────────────────────────
const ROUND_NAMES = [
  'Épreuve du Bronze',
  'Sanctuaire d\'Argent',
  'Jugement des Gold Saints',
  'Nuit de Shura',
  'Réveil d\'Athéna',
  'Tempête du Cosmos',
  'Ultime Chrysaor',
  'LE CHAMP ÉLYSÉE',
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.playerId !== excludeId) {
      client.send(msg);
    }
  });
}

function broadcastGameState() {
  const activePlayers = Object.values(gameState.players).filter(p => !p.eliminated);
  const eliminatedPlayers = Object.values(gameState.players).filter(p => p.eliminated);
  broadcast({
    type: 'game_state',
    phase: gameState.phase,
    players: gameState.players,
    activePlayers: activePlayers.length,
    eliminatedPlayers: eliminatedPlayers.length,
    currentRound: gameState.currentRound,
    roundName: gameState.roundName,
    timerValue: gameState.timerValue,
    paused: gameState.paused,
  });
}

function getQuestion() {
  const round = gameState.questions[gameState.currentRound];
  if (!round) return null;
  return round[gameState.currentQuestion] || null;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerStart = Date.now();
  timerInterval = setInterval(() => {
    if (gameState.paused) return;
    gameState.timerValue--;
    broadcast({ type: 'timer', value: gameState.timerValue });
    if (gameState.timerValue <= 0) {
      clearInterval(timerInterval);
      revealAnswer();
    }
  }, 1000);
}

function revealAnswer() {
  const q = getQuestion();
  if (!q) return;
  // Marquer les non-répondants
  Object.values(gameState.players).forEach(p => {
    if (!p.eliminated && !p.answered) {
      p.answer = null;
      p.score += 0;
    }
  });
  broadcast({ type: 'reveal_answer', correctIndex: q.correct, players: gameState.players });
}

function nextQuestion() {
  gameState.currentQuestion++;
  const round = gameState.questions[gameState.currentRound];
  if (!round || gameState.currentQuestion >= round.length) {
    endRound();
    return;
  }
  sendQuestion();
}

function sendQuestion() {
  const q = getQuestion();
  if (!q) return;
  // Reset answered
  Object.values(gameState.players).forEach(p => {
    p.answered = false;
    p.answer = null;
    p.answerTime = null;
  });
  gameState.timerValue = 30;
  gameState.phase = 'playing';
  broadcast({
    type: 'question',
    questionIndex: gameState.currentQuestion,
    totalQuestions: gameState.questions[gameState.currentRound]?.length || 0,
    question: q.question,
    choices: q.choices,
    roundName: gameState.roundName,
    round: gameState.currentRound + 1,
  });
  startTimer();
}

function endRound() {
  clearInterval(timerInterval);
  gameState.phase = 'round_end';
  // Tous les joueurs triés par score, actifs d'abord
  const sorted = Object.values(gameState.players)
    .sort((a, b) => {
      if (a.eliminated && !b.eliminated) return 1;
      if (!a.eliminated && b.eliminated) return -1;
      return b.score - a.score;
    });
  const round = gameState.questions[gameState.currentRound];
  const questionsRecap = round ? round.map(q => ({
    question: q.question,
    correctAnswer: q.choices[q.correct]
  })) : [];
  broadcast({ type: 'round_end', scores: sorted, roundName: gameState.roundName, questionsRecap });
  broadcastGameState();
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.isAdmin = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Joueur rejoint ──────────────────────────────────────────────────────
      case 'join': {
        const pseudo = (msg.pseudo || '').trim().slice(0, 20);
        if (!pseudo) return ws.send(JSON.stringify({ type: 'error', message: 'Pseudo invalide' }));
        // Vérif doublon
        const exists = Object.values(gameState.players).find(p => p.pseudo.toLowerCase() === pseudo.toLowerCase());
        if (exists) return ws.send(JSON.stringify({ type: 'error', message: 'Ce pseudo est déjà pris !' }));

        const id = `player_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        ws.playerId = id;
        gameState.players[id] = { id, pseudo, score: 0, eliminated: false, answered: false, answer: null, answerTime: null };
        ws.send(JSON.stringify({ type: 'joined', id, pseudo, gamePhase: gameState.phase }));
        broadcast({ type: 'player_joined', pseudo, totalPlayers: Object.keys(gameState.players).length }, id);
        // Envoyer game_state complet aux admins
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.isAdmin) {
            client.send(JSON.stringify({ type: 'game_state', ...gameState }));
          }
        });
        broadcastGameState();
        break;
      }

      // ── Admin login ─────────────────────────────────────────────────────────
      case 'admin_login': {
        if (msg.password === ADMIN_PASSWORD) {
          ws.isAdmin = true;
          ws.send(JSON.stringify({ type: 'admin_ok', roundNames: ROUND_NAMES }));
          ws.send(JSON.stringify({ type: 'game_state', ...gameState }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Mot de passe incorrect' }));
        }
        break;
      }

      // ── Admin : charger les questions ───────────────────────────────────────
      case 'load_questions': {
        if (!ws.isAdmin) return;
        gameState.questions = msg.questions; // array de manches, chaque manche = array de questions
        ws.send(JSON.stringify({ type: 'questions_loaded', rounds: gameState.questions.length }));
        break;
      }

      // ── Admin : démarrer une manche ─────────────────────────────────────────
      case 'start_round': {
        if (!ws.isAdmin) return;
        gameState.currentRound = msg.roundIndex ?? gameState.currentRound;
        gameState.currentQuestion = 0;
        gameState.roundName = ROUND_NAMES[gameState.currentRound] || `Manche ${gameState.currentRound + 1}`;
        gameState.phase = 'manche_intro';
        broadcast({ type: 'manche_intro', roundName: gameState.roundName, roundNumber: gameState.currentRound + 1 });
        break;
      }

      // ── Admin : lancer les questions après l'intro ──────────────────────────
      case 'launch_questions': {
        if (!ws.isAdmin) return;
        let count = 3;
        broadcast({ type: 'countdown', value: count });
        const cdInterval = setInterval(() => {
          count--;
          if (count <= 0) { clearInterval(cdInterval); setTimeout(sendQuestion, 800); }
          else broadcast({ type: 'countdown', value: count });
        }, 1000);
        break;
      }

      // ── Admin : afficher les règles ─────────────────────────────────────────
      case 'show_rules': {
        if (!ws.isAdmin) return;
        broadcast({ type: 'show_rules' });
        break;
      }

      // ── Admin : question suivante ───────────────────────────────────────────
      case 'next_question': {
        if (!ws.isAdmin) return;
        nextQuestion();
        break;
      }

      // ── Admin : révéler la réponse manuellement ─────────────────────────────
      case 'reveal': {
        if (!ws.isAdmin) return;
        clearInterval(timerInterval);
        revealAnswer();
        break;
      }

      // ── Admin : pause ───────────────────────────────────────────────────────
      case 'pause': {
        if (!ws.isAdmin) return;
        gameState.paused = !gameState.paused;
        broadcast({ type: 'pause', paused: gameState.paused });
        break;
      }

      // ── Admin : éliminer un joueur ──────────────────────────────────────────
      case 'eliminate': {
        if (!ws.isAdmin) return;
        const p = gameState.players[msg.playerId];
        if (p) {
          p.eliminated = true;
          // Envoyer score au joueur éliminé
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.playerId === msg.playerId) {
              client.send(JSON.stringify({ type: 'eliminated', playerId: msg.playerId, pseudo: p.pseudo, score: p.score }));
            }
          });
          // Autres joueurs voient l'écran verdict
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.playerId && client.playerId !== msg.playerId) {
              client.send(JSON.stringify({ type: 'eliminated', playerId: msg.playerId, pseudo: p.pseudo, score: p.score }));
            }
          });
          broadcastGameState();
        }
        break;
      }

      // ── Joueur : dernier mot ────────────────────────────────────────────────
      case 'last_word': {
        const p = gameState.players[ws.playerId];
        if (!p) return;
        const message = (msg.message || '...').slice(0, 150);
        broadcast({ type: 'farewell_message', pseudo: p.pseudo, message });
        break;
      }

      // ── Admin : remettre en jeu un joueur ───────────────────────────────────
      case 'restore': {
        if (!ws.isAdmin) return;
        const p = gameState.players[msg.playerId];
        if (p) {
          p.eliminated = false;
          broadcastGameState();
        }
        break;
      }

      // ── Admin : lancer la finale ────────────────────────────────────────────
      case 'start_final': {
        if (!ws.isAdmin) return;
        gameState.phase = 'final';
        gameState.roundName = 'FINALE — GRANDE GUERRE SAINTE';
        broadcast({ type: 'manche_intro', roundName: gameState.roundName, roundNumber: '⚔️ FINALE ⚔️', isFinal: true });
        break;
      }

      // ── Admin : terminer la partie ──────────────────────────────────────────
      case 'end_game': {
        if (!ws.isAdmin) return;
        gameState.phase = 'finished';
        const winner = Object.values(gameState.players)
          .filter(p => !p.eliminated)
          .sort((a, b) => b.score - a.score)[0];
        broadcast({ type: 'game_over', winner: winner?.pseudo || '???', scores: Object.values(gameState.players).sort((a,b) => b.score - a.score) });
        break;
      }

      // ── Admin : reset ───────────────────────────────────────────────────────
      case 'reset': {
        if (!ws.isAdmin) return;
        clearInterval(timerInterval);
        gameState = {
          phase: 'lobby', players: {}, currentRound: 0, currentQuestion: 0,
          questions: [], roundName: '', timerValue: 30, paused: false, showResults: false,
        };
        broadcast({ type: 'reset' });
        break;
      }

      // ── Joueur : répondre ───────────────────────────────────────────────────
      case 'answer': {
        const p = gameState.players[ws.playerId];
        if (!p || p.eliminated || p.answered || gameState.phase !== 'playing' || gameState.paused) return;
        const q = getQuestion();
        if (!q) return;
        const timeUsed = (Date.now() - timerStart) / 1000;
        p.answered = true;
        p.answer = msg.answerIndex;
        p.answerTime = timeUsed;
        if (msg.answerIndex === q.correct) {
          // Compter combien ont déjà répondu correctement
          const correctBefore = Object.values(gameState.players).filter(p2 =>
            !p2.eliminated && p2.answered && p2.answer === q.correct && p2.id !== p.id
          ).length;
          const bonus = correctBefore < 3 ? 2 : 0;
          p.score += 1 + bonus;
          p.lastBonus = bonus;
        } else {
          p.lastBonus = 0;
        }
        ws.send(JSON.stringify({ type: 'answer_received', answerIndex: msg.answerIndex }));
        // Stats pour l'admin
        const answered = Object.values(gameState.players).filter(p2 => !p2.eliminated && p2.answered).length;
        const active = Object.values(gameState.players).filter(p2 => !p2.eliminated).length;
        const choiceVotes = new Array(q.choices.length).fill(0);
        Object.values(gameState.players).filter(p2 => !p2.eliminated && p2.answered && p2.answer !== null)
          .forEach(p2 => { if (choiceVotes[p2.answer] !== undefined) choiceVotes[p2.answer]++; });
        broadcast({ type: 'answer_count', answered, total: active, choiceVotes });
        // Auto-reveal si tout le monde a répondu
        if (answered >= active) { clearInterval(timerInterval); revealAnswer(); }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.playerId && gameState.players[ws.playerId]) {
      // On garde le joueur mais on le marque déconnecté
      gameState.players[ws.playerId].connected = false;
      broadcastGameState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✨ Serveur lancé sur le port ${PORT}`));
