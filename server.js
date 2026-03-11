import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// --- CONFIGURAÇÕES DE CAMINHO (Necessário em ES Modules) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- SETUP DO SERVIDOR ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors()); // Permite que o React (em outra porta) acesse a API
app.use(express.json()); // Permite ler JSON no corpo das requisições

// --- CONFIGURAÇÃO DO MULTER (PARA IMAGENS) ---
// Criar a pasta 'uploads' se ela não existir
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configura como o arquivo será salvo
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Servir a pasta 'uploads' como estática (para o React conseguir ver as fotos)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- BANCO DE DADOS EM MEMÓRIA ---
const users = new Map(); // userId -> { id, name, roomId, avatarUrl }
const messageHistory = []; // Array de { id, roomId, userId, content, ... }

// --- 1. ENDPOINT: UPLOAD DE AVATAR (Página 1 do PDF) ---
app.post('/uploads/avatar', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    // Retorna o caminho relativo como o PDF pede
    res.json({
        avatarUrl: `/uploads/${req.file.filename}`,
        filename: req.file.filename
    });
});

// --- 2. ENDPOINT: CRIAR SESSÃO (Página 2 do PDF) ---
app.post('/sessions', (req, res) => {
    const { name, roomId, avatarUrl } = req.body;

    // Busca se o usuário já existe nesta sala (para evitar duplicados no F5)
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
        wsUrl: `ws://localhost:3333?roomId=${roomId}&userId=${user.id}`
    });
});

// --- 3. ENDPOINT: CARREGAR HISTÓRICO (Página 3 do PDF) ---
app.get('/rooms/:roomId/messages', (req, res) => {
    const { roomId } = req.params;
    const history = messageHistory.filter(m => m.roomId === roomId);
    res.json({ roomId, messages: history });
});

// --- 4. ENDPOINT: LISTAR PARTICIPANTES (Página 3 do PDF) ---
app.get('/rooms/:roomId/participants', (req, res) => {
    const { roomId } = req.params;
    const participants = Array.from(users.values()).filter(u => u.roomId === roomId);
    res.json({ participants });
});

// --- 5. LÓGICA DO WEBSOCKET (Páginas 4 e 5 do PDF) ---
wss.on('connection', (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const userId = url.searchParams.get('userId');

    // "Etiqueta" o socket para sabermos de quem é e em qual sala está
    socket.roomId = roomId;
    socket.userId = userId;

    const user = users.get(userId);
    if (!user) return socket.close();

    // EVENTO: room.joined (Envia para quem acabou de conectar)
    socket.send(JSON.stringify({
        type: 'room.joined',
        roomId,
        participant: user,
        participants: Array.from(users.values()).filter(u => u.roomId === roomId)
    }));

    // EVENTO: participant.joined (Avisa os outros na sala)
    broadcast(roomId, { type: 'participant.joined', participant: user }, socket);

    // ESCUTANDO MENSAGENS (O que o cliente envia)
    socket.on('message', (rawData) => {
        try {
            const data = JSON.parse(rawData);

            // Se o cliente enviar uma mensagem (message.send)
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

                messageHistory.push(newMessage); // Salva no "banco"

                // EVENTO: message.new (Envia para TODO MUNDO na sala)
                broadcast(roomId, {
                    type: 'message.new',
                    message: newMessage
                });
            }
        } catch (e) {
            console.error("Erro ao processar mensagem JSON");
        }
    });

    // EVENTO: participant.left (Quando o socket fecha/F5)
    socket.on('close', () => {
        broadcast(roomId, {
            type: 'participant.left',
            participantId: userId
        });
        // Opcional: users.delete(userId); // Se quiser que o usuário suma da lista permanentemente
    });
});

// FUNÇÃO AUXILIAR: Enviar para todos na sala
function broadcast(roomId, payload, excludeSocket = null) {
    const message = JSON.stringify(payload);
    wss.clients.forEach(client => {
        if (client.roomId === roomId && client !== excludeSocket) {
            client.send(message);
        }
    });
}

// --- INICIAR SERVIDOR ---
const PORT = 3333;
server.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});