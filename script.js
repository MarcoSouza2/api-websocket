import { faker } from '@faker-js/faker';
import { pool } from './db.js';
import dotenv from "dotenv";

dotenv.config();

async function seedDatabase() {
    const client = await pool.connect();

    try {
        // Usuarios
        const userIds = [];
        console.log('Inserindo Usuarios');
        for (let i = 0; i < 10; i++) {
            const username = `${faker.internet.username()}${i + 1}`;
            const email = `${username}@gmail.com`;
            const password = faker.internet.password();
            const displayName = faker.person.fullName();
            const avatarUrl = faker.image.avatar();

            const res = await client.query(
                `INSERT INTO users (username, password, email, display_name, avatar_url) 
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [username, password, email, displayName, avatarUrl]
            );
            userIds.push(res.rows[0].id);
        }

        // Salas
        const roomIds = [];
        console.log('Inserindo Salas');
        for (let i = 0; i < 2; i++) {
            const roomName = `${faker.commerce.department()} ${i + 1}`;
            
            const res = await client.query(
                `INSERT INTO rooms (id) VALUES ($1) RETURNING id`,
                [roomName]
            );
            roomIds.push(res.rows[0].id);
        }

        // Participantes
        const participantsMap = {}; 
        console.log('Inserindo Participantes');
        for (const roomId of roomIds) {
            const selectedUsers = faker.helpers.arrayElements(userIds, { min: 2, max: 10 });
            participantsMap[roomId] = selectedUsers;

            for (const userId of selectedUsers) {
                await client.query(
                    `INSERT INTO room_participants (room_id, user_id, status) VALUES ($1, $2, $3)`,
                    [roomId, userId, 'offline']
                );
            }
        }

        // Mensagens
        console.log('Inserindo Mensagens');
        for (let i = 0; i < 500000; i++) {
            const roomId = faker.helpers.arrayElement(roomIds);
            const possibleSenders = participantsMap[roomId];
            const senderId = faker.helpers.arrayElement(possibleSenders);

            const content = faker.lorem.sentence();
            const fileUrl = faker.helpers.maybe(() => faker.image.url(), { probability: 0.2 }) || null;

            await client.query(
                `INSERT INTO messages (room_id, user_id, content, file_url) VALUES ($1, $2, $3, $4)`,
                [roomId, senderId, content, fileUrl]
            );
        }
        console.log('✅!');

    } catch (err) {
        console.error('❌ Error:', err.stack);
    } finally {
        client.release();
        console.log('--- Connection Closed ---');
        process.exit();
    }
}

seedDatabase();