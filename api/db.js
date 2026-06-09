// ===== MongoDB API Handler for Vercel Serverless =====
// Connection string is stored in MONGODB_URI environment variable on Vercel.
// Frontend never sees the database credentials.

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'adiyogi_bugtracker';

// Reuse connection across warm invocations (Vercel caches module state)
let cachedClient = null;

async function getDB() {
  if (cachedClient) return cachedClient.db(DB_NAME);
  if (!MONGODB_URI) throw new Error('MONGODB_URI environment variable is not set.');
  cachedClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await cachedClient.connect();
  return cachedClient.db(DB_NAME);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // If no MONGODB_URI configured, return offline signal gracefully
  if (!MONGODB_URI) {
    return res.status(200).json({ offline: true, message: 'MONGODB_URI not configured on server.' });
  }

  try {
    const db = await getDB();

    // ── GET: fetch all data or a single collection ─────────────────────────
    if (req.method === 'GET') {
      const { table } = req.query;

      if (table) {
        const data = await db.collection(table).find({}).toArray();
        // Remove MongoDB _id field before sending
        return res.status(200).json(data.map(({ _id, ...rest }) => rest));
      }

      // Fetch all collections at once (used on initial app load)
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

    // ── POST: upsert or delete ─────────────────────────────────────────────
    if (req.method === 'POST') {
      const { action, table, data, id } = req.body || {};

      if (!action || !table) {
        return res.status(400).json({ error: 'Missing action or table in request body.' });
      }

      if (action === 'upsert') {
        if (!data || !data.id) return res.status(400).json({ error: 'data.id is required for upsert.' });
        await db.collection(table).replaceOne(
          { id: data.id },
          data,
          { upsert: true }
        );
        return res.status(200).json({ success: true });
      }

      if (action === 'delete') {
        if (!id) return res.status(400).json({ error: 'id is required for delete.' });
        await db.collection(table).deleteOne({ id });
        return res.status(200).json({ success: true });
      }

      if (action === 'deleteMany') {
        // e.g. delete all bugs for a project
        const { filter } = req.body;
        await db.collection(table).deleteMany(filter || {});
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('MongoDB handler error:', err);
    // Reset cached client on connection errors so next request retries
    if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') {
      cachedClient = null;
    }
    return res.status(500).json({ error: err.message });
  }
}
