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

const LOCAL_IP = process.env.LOCAL_IP || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const WSURL = process.env.WS_URL; 

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const corsOptions = {
    origin: 'https://chat-codefique.vercel.app',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    credentials: true,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

const disconnectTimers = new Map();
const activeConnections = new Map(); // Map<roomId, Map<userId, Set<socket>>>

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
    const uId = String(userId);
    if (!activeConnections.has(roomId)) {
        activeConnections.set(roomId, new Map());
    }
    const roomConnections = activeConnections.get(roomId);
    if (!roomConnections.has(uId)) {
        roomConnections.set(uId, new Set());
    }
    roomConnections.get(uId).add(socket);
}

function removeConnection(roomId, userId, socket) {
    const uId = String(userId);
    const roomConnections = activeConnections.get(roomId);
    if (!roomConnections) return false;
    const userSockets = roomConnections.get(uId);
    if (!userSockets) return false;

    userSockets.delete(socket);
    if (userSockets.size === 0) {
        roomConnections.delete(uId);
    }
    if (roomConnections.size === 0) {
        activeConnections.delete(roomId);
    }
    return true;
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

async function handleDisconnect(socket) {
    const { roomId, userId } = socket;
    if (!roomId || !userId || socket._disconnected) return;

    socket._disconnected = true;
    removeConnection(roomId, userId, socket);

    const key = `${roomId}:${userId}`;

    const timer = setTimeout(async () => {
        try {
            const uId = String(userId);
            const stillConnected = activeConnections.get(roomId)?.has(uId);

            if (stillConnected) {
                disconnectTimers.delete(key);
                return;
            }

            await pool.query(
                "UPDATE room_participants SET status = 'offline' WHERE room_id = $1 AND user_id = $2",
                [roomId, userId]
            );

            broadcast(roomId, {
                type: 'participant.status_change',
                participantId: userId,
                status: 'offline'
            });
        } catch (err) {
            console.error('Erro ao atualizar status do participante:', err);
        } finally {
            disconnectTimers.delete(key);
        }
    }, 2500);

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

        await pool.query('INSERT INTO rooms (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [roomId]);

        await pool.query(
            `INSERT INTO room_participants (room_id, user_id, status) 
             VALUES ($1, $2, 'online') 
             ON CONFLICT (room_id, user_id) 
             DO UPDATE SET status = 'online'`,
            [roomId, user.id]
        );

        const protocol = WSURL?.includes('ngrok') ? 'wss' : 'ws';

        res.json({
            userId: user.id,
            roomId,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarUrl: user.avatar_url
            },
            wsUrl: WSURL ? `${protocol}://${WSURL}?roomId=${roomId}&userId=${user.id}` : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao iniciar sessão' });
    }
});

app.patch('/users/update', async (req, res) => {
    // 1. Adicionamos o 'oldPassword' na desestruturação
    const { userId, password, oldPassword, displayName, avatarUrl } = req.body;

    if (!userId) return res.status(400).json({ error: 'User ID é obrigatório' });

    try {
        // 2. Buscar o usuário no banco para verificar a senha atual
        const userCheck = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const currentUser = userCheck.rows[0];

        // 3. Lógica de validação de senha
        if (password) {
            // Se o usuário quer mudar a senha, ele DEVE fornecer a antiga
            if (!oldPassword) {
                return res.status(400).json({ error: 'Você deve fornecer a senha antiga para definir uma nova' });
            }

            // Comparação (Nota: se você usar bcrypt no futuro, use bcrypt.compare aqui)
            if (currentUser.password !== oldPassword) {
                return res.status(401).json({ error: 'A senha antiga está incorreta' });
            }
        }

        const updates = [];
        const values = [];
        let counter = 1;

        if (password) {
            updates.push(`password = $${counter++}`);
            values.push(password);
        }
        if (displayName) {
            updates.push(`display_name = $${counter++}`);
            values.push(displayName);
        }
        if (avatarUrl) {
            updates.push(`avatar_url = $${counter++}`);
            values.push(avatarUrl);
        }

        if (updates.length === 0) return res.status(400).json({ error: "Nada para atualizar" });

        values.push(userId);
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${counter} RETURNING id, username, display_name as "displayName", avatar_url as "avatarUrl"`;
        
        const result = await pool.query(query, values);
        const updatedUser = result.rows[0];

        // Broadcast para os outros participantes (mantendo sua lógica original)
        const uIdStr = String(userId);
        activeConnections.forEach((userMaps, roomId) => {
            if (userMaps.has(uIdStr)) {
                broadcast(roomId, {
                    type: 'participant.status_change',
                    participantId: userId,
                    status: 'online',
                    participant: updatedUser
                });
            }
        });

        res.json(updatedUser);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar perfil' });
    }
});

app.get('/rooms/:roomId/messages', async (req, res) => {
    const { roomId } = req.params;
    try {
        const result = await pool.query(
            `SELECT m.id, m.user_id as "userId", m.content, m.file_url as "fileUrl", m.file_name as "fileName", 
                    m.created_at, u.display_name as "userName", u.avatar_url as "userAvatarUrl"
             FROM messages m JOIN users u ON m.user_id = u.id
             WHERE m.room_id = $1 ORDER BY m.created_at ASC`,
            [roomId]
        );
        res.json({ roomId, messages: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

app.get('/rooms/:roomId/participants', async (req, res) => {
    const { roomId } = req.params;
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name as "displayName", u.avatar_url as "avatarUrl", rp.status
             FROM users u JOIN room_participants rp ON u.id = rp.user_id
             WHERE rp.room_id = $1
             ORDER BY CASE WHEN rp.status = 'online' THEN 0 ELSE 1 END, u.display_name ASC`,
            [roomId]
        );
        res.json({ participants: result.rows });
    } catch (err) {
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

    socket.on('close', async () => {
        await handleDisconnect(socket);
    });

    try {
        const userRes = await pool.query('SELECT id, display_name, avatar_url FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return socket.close(1008, 'Usuário inválido');

        const uIdStr = String(userId);
        const roomConnections = activeConnections.get(roomId);
        const alreadyOnline = roomConnections?.has(uIdStr) || false;

        addConnection(roomId, userId, socket);

        await pool.query(
            `INSERT INTO room_participants (room_id, user_id, status) 
             VALUES ($1, $2, 'online') ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'online'`,
            [roomId, userId]
        );

        const participantsRes = await pool.query(
            `SELECT u.id, u.username, u.display_name as "displayName", u.avatar_url as "avatarUrl", rp.status
             FROM users u JOIN room_participants rp ON u.id = rp.user_id WHERE rp.room_id = $1
             ORDER BY CASE WHEN rp.status = 'online' THEN 0 ELSE 1 END, u.display_name ASC`,
            [roomId]
        );

        socket.send(JSON.stringify({
            type: 'room.joined',
            roomId,
            participants: participantsRes.rows
        }));

        if (!alreadyOnline) {
            broadcast(roomId, {
                type: 'participant.status_change',
                participantId: userId,
                status: 'online',
                participant: {
                    id: user.id,
                    displayName: user.display_name,
                    avatarUrl: user.avatar_url
                }
            }, socket);
        }

        socket.on('message', async (rawData) => {
            try {
                const data = JSON.parse(rawData.toString());
                if (data.type === 'message.send') {
                    if (!data.content && !data.fileUrl) return;

                    // Get current user data to ensure the broadcast uses latest name/avatar
                    const currentUserRes = await pool.query('SELECT display_name, avatar_url FROM users WHERE id = $1', [userId]);
                    const currUser = currentUserRes.rows[0];

                    const msgRes = await pool.query(
                        `INSERT INTO messages (room_id, user_id, content, file_url, file_name) 
                         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                        [roomId, userId, data.content || null, data.fileUrl || null, data.fileName || null]
                    );
                    const savedMsg = msgRes.rows[0];
                    broadcast(roomId, {
                        type: 'message.new',
                        message: {
                            ...savedMsg,
                            userId: savedMsg.user_id,
                            fileUrl: savedMsg.file_url,
                            fileName: savedMsg.file_name,
                            userName: currUser.display_name,
                            userAvatarUrl: currUser.avatar_url
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

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
        if (socket.isAlive === false) return socket.terminate();
        socket.isAlive = false;
        socket.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando em http://${LOCAL_IP}:${PORT}`);
});