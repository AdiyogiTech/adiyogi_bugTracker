// ===== API Handler for Vercel Serverless =====
// Supports Supabase, Vercel KV, and MongoDB.

import { MongoClient } from 'mongodb';

// Environment Variables auto-injected by Vercel Integrations
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'adiyogi_bugtracker';

const kvUrl = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;

let cachedClient = null;

async function getMongoDB() {
  if (cachedClient) return cachedClient.db(DB_NAME);
  if (!MONGODB_URI) return null;
  cachedClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await cachedClient.connect();
  return cachedClient.db(DB_NAME);
}

// Supabase Helpers (Using raw jsonb to avoid strict schema crashes)
async function supabaseFetch(table, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${options.method === 'GET' || !options.method ? '?select=*' : ''}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    throw new Error(`Supabase request failed: ${res.statusText}`);
  }
  return options.method !== 'POST' && options.method !== 'DELETE' ? res.json() : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ==========================================
    // 1. SUPABASE (If connected via Vercel)
    // ==========================================
    if (SUPABASE_URL && SUPABASE_KEY) {
      if (req.method === 'GET') {
        const { table } = req.query;
        if (table) {
          const data = await supabaseFetch(table).catch(() => []);
          // Extract from flat object or jsonb wrapper
          return res.status(200).json(data.map(d => d.data ? {id: d.id, ...d.data} : d));
        }

        const [projects, testers, bugs, notifications, profileArr] = await Promise.all([
          supabaseFetch('projects').catch(() => []),
          supabaseFetch('testers').catch(() => []),
          supabaseFetch('bugs').catch(() => []),
          supabaseFetch('notifications').catch(() => []),
          supabaseFetch('profile').catch(() => [])
        ]);

        const unwrap = arr => (arr || []).map(d => d.data ? {id: d.id, ...d.data} : d);

        return res.status(200).json({
          projects: unwrap(projects),
          testers: unwrap(testers),
          bugs: unwrap(bugs),
          notifications: unwrap(notifications).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 50),
          profile: unwrap(profileArr)[0] || null
        });
      }

      if (req.method === 'POST') {
        const { action, table, data, id } = req.body || {};
        if (action === 'upsert') {
          // Send flat data. If columns are missing, this will fail unless user ran SQL.
          await supabaseFetch(table, { method: 'POST', body: JSON.stringify(data) });
          return res.status(200).json({ success: true, db: 'supabase' });
        } else if (action === 'delete') {
          const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`;
          await fetch(url, {
            method: 'DELETE',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
          });
          return res.status(200).json({ success: true, db: 'supabase' });
        }
      }
      return res.status(405).end();
    }

    // ==========================================
    // 2. VERCEL KV (Zero Setup - Recommended)
    // ==========================================
    if (kvUrl && kvToken) {
      const stateRes = await fetch(`${kvUrl}/get/adiyogi_state`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const stateData = await stateRes.json();
      const state = (stateData && stateData.result ? JSON.parse(stateData.result) : null) || { projects: [], testers: [], bugs: [], notifications: [], profile: {} };

      if (req.method === 'GET') {
        const { table } = req.query;
        if (table) return res.status(200).json(state[table] || []);
        
        return res.status(200).json({
          projects: state.projects || [],
          testers: state.testers || [],
          bugs: state.bugs || [],
          notifications: state.notifications || [],
          profile: state.profile || null
        });
      }

      if (req.method === 'POST') {
        const { action, table, data, id } = req.body || {};
        if (!state[table]) state[table] = [];

        if (action === 'upsert') {
          const index = state[table].findIndex(item => item.id === data.id);
          if (index > -1) state[table][index] = data;
          else state[table].push(data);
        } else if (action === 'delete') {
          state[table] = state[table].filter(item => item.id !== id);
        }
        
        await fetch(`${kvUrl}/set/adiyogi_state`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(JSON.stringify(state))
        });
        return res.status(200).json({ success: true, db: 'kv' });
      }
      return res.status(405).end();
    }

    // ==========================================
    // 3. MONGODB (If MONGODB_URI is set)
    // ==========================================
    const db = await getMongoDB();
    if (db) {
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
          return res.status(200).json({ success: true, db: 'mongodb' });
        } else if (action === 'delete') {
          await db.collection(table).deleteOne({ id });
          return res.status(200).json({ success: true, db: 'mongodb' });
        }
      }
      return res.status(405).end();
    }

    // If none of the above are configured
    return res.status(200).json({ offline: true, message: 'No Database Configured' });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
