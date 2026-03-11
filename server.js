import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';




const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors()); 
app.use(express.json()); 


const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const users = new Map(); 
const messageHistory = []; 

app.post('/uploads/avatar', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    res.json({
        avatarUrl: `/uploads/${req.file.filename}`,
        filename: req.file.filename
    });
});

app.post('/sessions', (req, res) => {
    const { name, roomId, avatarUrl } = req.body;

    let user = Array.from(users.values()).find(u => u.name === name && u.roomId === roomId);

    if (!user) {
        user = {
            id: 'user_' + Math.random().toString(36).substr(2, 9),
            name,
            roomId,
            avatarUrl
        };
        users.set(user.id, user);
    }

    res.json({
        userId: user.id,
        roomId: user.roomId,
        user: user,
        wsUrl: `ws:192.168.100.28:3333?roomId=${roomId}&userId=${user.id}`
    });
});

app.get('/rooms/:roomId/messages', (req, res) => {
    const { roomId } = req.params;
    const history = messageHistory.filter(m => m.roomId === roomId);
    res.json({ roomId, messages: history });
});

app.get('/rooms/:roomId/participants', (req, res) => {
    const { roomId } = req.params;
    const participants = Array.from(users.values()).filter(u => u.roomId === roomId);
    res.json({ participants });
});

wss.on('connection', (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const userId = url.searchParams.get('userId');

    socket.roomId = roomId;
    socket.userId = userId;

    const user = users.get(userId);
    if (!user) return socket.close();

    socket.send(JSON.stringify({
        type: 'room.joined',
        roomId,
        participant: user,
        participants: Array.from(users.values()).filter(u => u.roomId === roomId)
    }));

    broadcast(roomId, { type: 'participant.joined', participant: user }, socket);

    socket.on('message', (rawData) => {
        try {
            const data = JSON.parse(rawData);

            if (data.type === 'message.send') {
                const newMessage = {
                    id: 'msg_' + Math.random().toString(36).substr(2, 9),
                    roomId: roomId,
                    userId: userId,
                    userName: user.name,
                    userAvatarUrl: user.avatarUrl,
                    content: data.content,
                    createdAt: new Date().toISOString()
                };

                messageHistory.push(newMessage); 

                broadcast(roomId, {
                    type: 'message.new',
                    message: newMessage
                });
            }
        } catch (e) {
            console.error("Erro ao processar mensagem JSON");
        }
    });

    socket.on('close', () => {
        broadcast(roomId, {
            type: 'participant.left',
            participantId: userId
        });
        users.delete(userId); 
    });
});

function broadcast(roomId, payload, excludeSocket = null) {
    const message = JSON.stringify(payload);
    wss.clients.forEach(client => {
        if (client.roomId === roomId && client !== excludeSocket) {
            client.send(message);
        }
    });
}

// --- INICIAR SERVIDOR ---
const LOCAL_IP = "192.168.100.28";
const PORT = 3333;
server.listen(PORT, LOCAL_IP, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT} e ${LOCAL_IP}`);
});