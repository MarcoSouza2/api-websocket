import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "8796",
  database: "chatdb",
});

pool.connect()
  .then(() => console.log("Banco conectado com sucesso"))
  .catch((err) => console.error("Erro ao conectar no banco:", err));

