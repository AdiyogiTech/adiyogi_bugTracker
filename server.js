import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from 'web' directory
app.use(express.static(path.join(__dirname, 'web')));

// ===== Zero-Setup JSON Database =====
// This removes the need for MongoDB entirely, ensuring 100% sync across PCs out of the box.
const DB_FILE = path.join(__dirname, 'db.json');

// Initialize database file if it doesn't exist
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      projects: [], testers: [], bugs: [], notifications: [], profile: []
    }, null, 2));
  }
}

function readDB() {
  initDB();
  const data = fs.readFileSync(DB_FILE, 'utf-8');
  return JSON.parse(data);
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ===== API Endpoint for Database Operations =====
app.all('/api/db', (req, res) => {
  try {
    const db = readDB();

    if (req.method === 'GET') {
      const { table } = req.query;
      
      if (table) {
        return res.status(200).json(db[table] || []);
      }

      // Fetch all collections at once (initial load)
      // Sort bugs by newest first, notifications by id desc
      const sortedBugs = [...(db.bugs || [])].reverse();
      const sortedNotifs = [...(db.notifications || [])].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
      
      return res.status(200).json({
        projects: db.projects || [],
        testers: db.testers || [],
        bugs: sortedBugs,
        notifications: sortedNotifs,
        profile: (db.profile && db.profile.length > 0) ? db.profile[0] : null
      });
    }

    if (req.method === 'POST') {
      const { action, table, data, id } = req.body || {};
      
      if (!db[table]) db[table] = [];

      if (action === 'upsert') {
        const index = db[table].findIndex(item => item.id === data.id);
        if (index > -1) {
          db[table][index] = data; // Update
        } else {
          db[table].push(data); // Insert
        }
        writeDB(db);
        return res.status(200).json({ success: true });
      }

      if (action === 'delete') {
        db[table] = db[table].filter(item => item.id !== id);
        writeDB(db);
        return res.status(200).json({ success: true });
      }
    }
  } catch (err) {
    console.error('DB Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start Server and print IP addresses for other PCs to connect
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==============================================`);
  console.log(`🚀 Adiyogi Bug Tracker Live Server is Running!`);
  console.log(`==============================================\n`);
  
  console.log(`💻 Access the app from THIS PC (Admin):`);
  console.log(`   👉 http://localhost:${PORT}\n`);
  
  console.log(`🌐 Access the app from PC 2 & PC 3 (Type this exactly into their browser):`);
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName in networkInterfaces) {
    for (const net of networkInterfaces[interfaceName]) {
      // Skip internal and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   👉 http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\n✅ Database is using local file sync (db.json). No MongoDB needed!`);
  console.log(`⚠️  Leave this terminal open to keep the server running.`);
});
