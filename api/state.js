// Serverless function for GET/POST /api/state
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (req.method === 'GET') {
    if (!kvUrl || !kvToken) {
      return res.status(200).json({ status: 'offline', message: 'Vercel KV not connected' });
    }

    try {
      const response = await fetch(`${kvUrl}/get/adiyogi_state`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const data = await response.json();
      
      if (data && data.result) {
        return res.status(200).json(JSON.parse(data.result));
      }
      return res.status(200).json({ empty: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    if (!kvUrl || !kvToken) {
      return res.status(200).json({ status: 'offline', message: 'Vercel KV not connected' });
    }

    try {
      const state = req.body;
      const response = await fetch(`${kvUrl}/set/adiyogi_state`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(state))
      });
      await response.json();
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
