import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
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

// Automatically use local MongoDB
const MONGODB_URI = 'mongodb://127.0.0.1:27017';
const DB_NAME = 'adiyogi_bugtracker';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log(`✅ Connected to Local MongoDB (${DB_NAME})`);
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB. Is MongoDB installed and running on this PC?', err.message);
  }
}

connectDB();

// ===== API Endpoint for Database Operations =====
app.all('/api/db', async (req, res) => {
  if (!db) return res.status(500).json({ offline: true, message: 'MongoDB not running' });

  try {
    if (req.method === 'GET') {
      const { table } = req.query;
      if (table) {
        const data = await db.collection(table).find({}).toArray();
        return res.status(200).json(data.map(({ _id, ...rest }) => rest));
      }

      const [projects, testers, bugs, notifications, profileArr] = await Promise.all([
        db.collection('projects').find({}).toArray(),
        db.collection('testers').find({}).toArray(),
        db.collection('bugs').find({}).sort({ created: -1 }).toArray(),
        db.collection('notifications').find({}).sort({ id: -1 }).limit(50).toArray(),
        db.collection('profile').find({ id: 'hr_manager' }).toArray()
      ]);

      const strip = arr => arr.map(({ _id, ...rest }) => rest);

      return res.status(200).json({
        projects: strip(projects),
        testers:  strip(testers),
        bugs:     strip(bugs),
        notifications: strip(notifications),
        profile:  strip(profileArr)[0] || null
      });
    }

    if (req.method === 'POST') {
      const { action, table, data, id } = req.body || {};
      
      if (action === 'upsert') {
        await db.collection(table).replaceOne({ id: data.id }, data, { upsert: true });
        return res.status(200).json({ success: true });
      }

      if (action === 'delete') {
        await db.collection(table).deleteOne({ id });
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
  console.log(`\n🚀 Adiyogi Bug Tracker Live Server is Running!`);
  console.log(`\nAccess the app from this PC (Admin):`);
  console.log(`👉 http://localhost:${PORT}`);
  
  console.log(`\nAccess the app from PC 2 (Tester) and PC 3 (Developer):`);
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName in networkInterfaces) {
    for (const net of networkInterfaces[interfaceName]) {
      // Skip internal and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`👉 http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\nMake sure MongoDB is installed on this PC and running!');
});
