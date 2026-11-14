'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let db = null;

function getDb() {
  if (db) return db;
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'application.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(database) {
  const migrationFile = path.join(__dirname, 'migrations', '001_init.sql');
  const sql = fs.readFileSync(migrationFile, 'utf8');
  database.exec(sql);
  const current = database.pragma('user_version', { simple: true });
  if (!current || current < 1) {
    database.pragma('user_version = 1');
  }
}

function closeDb() {
  if (db) {
    try { db.close(); } catch (err) { /* already closed */ }
    db = null;
  }
}

module.exports = { getDb, closeDb };
