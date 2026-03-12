import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- DATABASE ROUTES ---

app.post('/uploads/avatar', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({
        avatarUrl: `/uploads/${req.file.filename}`,
        filename: req.file.filename
    });
});

app.post('/register', async (req, res) => {
    const { username, password, email, avatarUrl, displayName } = req.body;

    try {
        // Check if user or email already exists
        const userExists = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Usuário ou Email já cadastrado' });
        }

        const finalDisplayName = displayName || username;
        // Insert new user
        // We set display_name = username as requested
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
    // We removed avatarUrl from here because it's usually set during register or profile edit
    const { username, password, roomId } = req.body;

    try {
        // 1. Verify User Credentials
        const userRes = await pool.query(
            'SELECT * FROM users WHERE username = $1 AND password = $2',
            [username, password]
        );
        
        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const user = userRes.rows[0];

        // 2. Ensure Room exists
        await pool.query(
            'INSERT INTO rooms (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
            [roomId]
        );

        // 3. Add Participant to Room
        await pool.query(
            'INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [roomId, user.id]
        );

        res.json({
            userId: user.id,
            roomId: roomId,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarUrl: user.avatar_url
            },
            wsUrl: `ws://192.168.100.25:3333?roomId=${roomId}&userId=${user.id}`
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
            `SELECT m.id, m.user_id as "userId", m.content, m.created_at, u.display_name as "userName", u.avatar_url as "userAvatarUrl"
             FROM messages m
             JOIN users u ON m.user_id = u.id
             WHERE m.room_id = $1
             ORDER BY m.created_at ASC`,
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
            `SELECT u.id, u.username, u.display_name as "displayName", u.avatar_url as "avatarUrl" FROM users u
             JOIN room_participants rp ON u.id = rp.user_id
             WHERE rp.room_id = $1`,
            [roomId]
        );
        res.json({ participants: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar participantes' });
    }
});

// --- WEBSOCKET LOGIC ---

wss.on('connection', async (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const userId = url.searchParams.get('userId');

    socket.roomId = roomId;
    socket.userId = userId;

    try {
        // User <- DB
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return socket.close();

        // Participants in room
        const participantsRes = await pool.query(
            `SELECT u.id, u.username, display_name as "displayName", u.avatar_url as "avatarUrl" 
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
                avatarUrl: user.avatar_url  },
            participants: participantsRes.rows
        }));

        broadcast(roomId, { 
            type: 'participant.joined', 
            participant: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatarUrl: user.avatar_url
            } 
        }, socket);

        socket.on('message', async (rawData) => {
            try {
                const data = JSON.parse(rawData);

                if (data.type === 'message.send') {
                    // Save message to Database
                    const msgRes = await pool.query(
                        `INSERT INTO messages (room_id, user_id, content) 
                         VALUES ($1, $2, $3) 
                         RETURNING id, user_id as "userId", content, created_at`,
                        [roomId, userId, data.content]
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
                console.error("Erro ao processar mensagem");
            }
        });

        socket.on('close', () => {
            
        });

    } catch (err) {
        console.error(err);
        socket.close();
    }
});

function broadcast(roomId, payload, excludeSocket = null) {
    const message = JSON.stringify(payload);
    wss.clients.forEach(client => {
        if (client.roomId === roomId && client !== excludeSocket) {
            client.send(message);
        }
    });
}

const LOCAL_IP = "192.168.100.25";
const PORT = 3333;
server.listen(PORT, LOCAL_IP, () => {
    console.log(`✅ Servidor rodando em http://${LOCAL_IP}:${PORT}`);
});