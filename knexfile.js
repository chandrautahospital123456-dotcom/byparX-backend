require('dotenv').config();

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME || 'erp_unified',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'npg_mqN2ahbeYZ7w',
    },

    searchPath: ['public'],

    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },

    seeds: {
      directory: './seeds',
    },

    pool: {
      min: 2,
      max: 10,
      afterCreate: (conn, done) => {
        conn.query('SET search_path TO public', (err) => {
          done(err, conn);
        });
      },
    },

    acquireConnectionTimeout: 10000,
  },

  production: {
    client: 'pg',

    // ✅ FIXED (IMPORTANT CHANGE)
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },

    searchPath: ['public'],

    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },

    seeds: {
      directory: './seeds',
    },

    pool: {
      min: 2,
      max: 10,
    },

    acquireConnectionTimeout: 30000,
  },
};