import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_IP = process.env.LOCAL_IP;
const PORT = process.env.PORT;
const WSURL = process.env.WS_URL; 

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const disconnectTimers = new Map();
const activeConnections = new Map();

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// =========================
// HELPERS
// =========================

function addConnection(roomId, userId, socket) {
    if (!activeConnections.has(roomId)) {
        activeConnections.set(roomId, new Map());
    }
    const roomConnections = activeConnections.get(roomId);
    if (!roomConnections.has(userId)) {
        roomConnections.set(userId, new Set());
    }
    roomConnections.get(userId).add(socket);
}

function removeConnection(roomId, userId, socket) {
    const roomConnections = activeConnections.get(roomId);
    if (!roomConnections) return false;
    const userSockets = roomConnections.get(userId);
    if (!userSockets) return false;

    userSockets.delete(socket);
    if (userSockets.size === 0) {
        roomConnections.delete(userId);
    }
    if (roomConnections.size === 0) {
        activeConnections.delete(roomId);
        return true;
    }
    return !roomConnections.has(userId);
}

function getConnectedSocketsInRoom(roomId) {
    const roomConnections = activeConnections.get(roomId);
    if (!roomConnections) return [];
    const sockets = [];
    for (const userSockets of roomConnections.values()) {
        for (const socket of userSockets) {
            if (socket.readyState === WebSocket.OPEN) {
                sockets.push(socket);
            }
        }
    }
    return sockets;
}

function broadcast(roomId, payload, excludeSocket = null) {
    const message = JSON.stringify(payload);
    const sockets = getConnectedSocketsInRoom(roomId);
    for (const client of sockets) {
        if (client !== excludeSocket) {
            client.send(message);
        }
    }
}

async function handleDisconnect(socket, reason = 'unknown') {
    const { roomId, userId } = socket;
    if (!roomId || !userId || socket._disconnected) return;

    socket._disconnected = true;
    removeConnection(roomId, userId, socket);

    const key = `${roomId}:${userId}`;

    // Evita definir como offline se ele reconectar rapidamente (ex: F5)
    const timer = setTimeout(async () => {
        try {
            const stillConnected = [...wss.clients].some(
                (client) =>
                    client.roomId === roomId &&
                    client.userId === userId &&
                    client.readyState === WebSocket.OPEN
            );

            if (stillConnected) {
                disconnectTimers.delete(key);
                return;
            }

            // ATUALIZA status para offline ao invés de DELETAR
            await pool.query(
                "UPDATE room_participants SET status = 'offline' WHERE room_id = $1 AND user_id = $2",
                [roomId, userId]
            );

            broadcast(roomId, {
                type: 'participant.status_change',
                participantId: userId,
                status: 'offline'
            });

            console.log(`Usuário ${userId} agora está offline na sala ${roomId}.`);
        } catch (err) {
            console.error('Erro ao atualizar status do participante:', err);
        } finally {
            disconnectTimers.delete(key);
        }
    }, 2000);

    disconnectTimers.set(key, timer);
}

// =========================
// ROTAS HTTP
// =========================

app.post('/uploads/avatar', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({
        avatarUrl: `/uploads/${req.file.filename}`,
        filename: req.file.filename
    });
});

app.post('/uploads/chat', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({
        fileUrl: `/uploads/${req.file.filename}`
    });
});

app.post('/register', async (req, res) => {
    const { username, password, email, avatarUrl, displayName } = req.body;
    try {
        const userExists = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Usuário ou Email já cadastrado' });
        }
        const finalDisplayName = displayName || username;
        const newUserRes = await pool.query(
            `INSERT INTO users (username, password, email, display_name, avatar_url) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING id, username, email, display_name as "displayName", avatar_url as "avatarUrl"`,
            [username, password, email, finalDisplayName, avatarUrl]
        );
        res.status(201).json(newUserRes.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao registrar usuário' });
    }
});

app.post('/sessions', async (req, res) => {
    const { username, password, roomId } = req.body;
    try {
        const userRes = await pool.query(
            'SELECT * FROM users WHERE username = $1 AND password = $2',
            [username, password]
        );
        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }
        const user = userRes.rows[0];

        await pool.query(
            'INSERT INTO rooms (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
            [roomId]
        );

        // Garante que o participante existe e define como online
        await pool.query(
            `INSERT INTO room_participants (room_id, user_id, status) 
             VALUES ($1, $2, 'online') 
             ON CONFLICT (room_id, user_id) 
             DO UPDATE SET status = 'online'`,
            [roomId, user.id]
        );

        res.json({
            userId: user.id,
            roomId,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarUrl: user.avatar_url
            },
            wsUrl: `ws://${WSURL}?roomId=${roomId}&userId=${user.id}`
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao iniciar sessão' });
    }
});

app.get('/rooms/:roomId/messages', async (req, res) => {
    const { roomId } = req.params;
    try {
        const result = await pool.query(
            `SELECT 
                m.id, m.user_id as "userId", m.content, m.file_url as "fileUrl", m.created_at,
                u.display_name as "userName", u.avatar_url as "userAvatarUrl"
             FROM messages m
             JOIN users u ON m.user_id = u.id
             WHERE m.room_id = $1
             ORDER BY m.created_at ASC`,
            [roomId]
        );
        res.json({ roomId, messages: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

app.get('/rooms/:roomId/participants', async (req, res) => {
    const { roomId } = req.params;
    try {
        // Agora buscamos TODOS os participantes registrados na sala, com seus status
        const result = await pool.query(
            `SELECT 
                u.id,
                u.username,
                u.display_name as "displayName",
                u.avatar_url as "avatarUrl",
                rp.status
             FROM users u
             JOIN room_participants rp ON u.id = rp.user_id
             WHERE rp.room_id = $1`,
            [roomId]
        );
        res.json({ participants: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar participantes' });
    }
});

// =========================
// WEBSOCKET
// =========================

wss.on('connection', async (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const userId = url.searchParams.get('userId');

    if (!roomId || !userId) {
        socket.close(1008, 'roomId ou userId ausente');
        return;
    }

    const key = `${roomId}:${userId}`;
    if (disconnectTimers.has(key)) {
        clearTimeout(disconnectTimers.get(key));
        disconnectTimers.delete(key);
    }

    socket.roomId = roomId;
    socket.userId = userId;
    socket.isAlive = true;
    socket._disconnected = false;

    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('error', async (err) => {
        console.error(`Erro no socket userId=${userId}:`, err);
        await handleDisconnect(socket, 'error');
    });

    socket.on('close', async (code, reason) => {
        console.log(`Socket fechado. userId=${userId}, roomId=${roomId}`);
        await handleDisconnect(socket, 'close');
    });

    try {
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user) {
            socket.close(1008, 'Usuário inválido');
            return;
        }

        const roomConnections = activeConnections.get(roomId);
        const alreadyOnline = roomConnections?.has(userId) || false;

        addConnection(roomId, userId, socket);

        // Atualiza status para online no banco
        await pool.query(
            `INSERT INTO room_participants (room_id, user_id, status) 
             VALUES ($1, $2, 'online') 
             ON CONFLICT (room_id, user_id) 
             DO UPDATE SET status = 'online'`,
            [roomId, userId]
        );

        // Busca lista completa de participantes (online e offline) para enviar ao novo conectado
        const participantsRes = await pool.query(
            `SELECT 
                u.id, u.username, u.display_name as "displayName", u.avatar_url as "avatarUrl", rp.status
             FROM users u
             JOIN room_participants rp ON u.id = rp.user_id
             WHERE rp.room_id = $1`,
            [roomId]
        );

        socket.send(JSON.stringify({
            type: 'room.joined',
            roomId,
            participant: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarUrl: user.avatar_url,
                status: 'online'
            },
            participants: participantsRes.rows
        }));

        // Notifica os outros apenas se for a primeira conexão (aba) deste usuário
        if (!alreadyOnline) {
            broadcast(roomId, {
                type: 'participant.status_change',
                participantId: userId,
                status: 'online',
                participant: { // Envia dados básicos caso o front precise renderizar um novo card
                    id: user.id,
                    username: user.username,
                    displayName: user.display_name,
                    avatarUrl: user.avatar_url
                }
            }, socket);

            console.log(`✅ Usuário ${userId} online na sala ${roomId}`);
        }

        socket.on('message', async (rawData) => {
            try {
                const data = JSON.parse(rawData.toString());
                if (data.type === 'message.send') {
                    if (!data.content && !data.fileUrl) return;

                    const msgRes = await pool.query(
                        `INSERT INTO messages (room_id, user_id, content, file_url) 
                         VALUES ($1, $2, $3, $4) 
                         RETURNING id, user_id as "userId", content, file_url as "fileUrl", created_at`,
                        [roomId, userId, data.content || null, data.fileUrl || null]
                    );

                    const savedMsg = msgRes.rows[0];
                    broadcast(roomId, {
                        type: 'message.new',
                        message: {
                            ...savedMsg,
                            userName: user.display_name,
                            userAvatarUrl: user.avatar_url
                        }
                    });
                }
            } catch (e) {
                console.error('Erro ao processar mensagem:', e);
            }
        });
    } catch (err) {
        console.error(err);
        socket.close();
    }
});

// HEARTBEAT PING/PONG
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
        if (socket.isAlive === false) {
            socket.terminate();
            return;
        }
        socket.isAlive = false;
        socket.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, LOCAL_IP, () => {
    console.log(`✅ Servidor rodando em http://${LOCAL_IP}:${PORT}`);
});