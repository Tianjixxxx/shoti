const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const winston = require('winston');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', limiter);

// User agent list
const uaList = [
  "Mozilla/5.0 (Linux; Android 12; OnePlus 9 Build/SKQ1.210216.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/335.0.0.11.118;]",
  "Mozilla/5.0 (Linux; Android 13; Google Pixel 6a Build/TQ3A.230605.012; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/340.0.0.15.119;]",
  "Mozilla/5.0 (Linux; Android 11; SM-G998B Build/RP1A.200720.012; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/336.0.0.12.120;]",
  "Mozilla/5.0 (Linux; Android 10; Pixel 4 XL Build/QD1A.190821.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.162 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/337.0.0.13.121;]",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.166 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/341.0.0.16.122;]"
];

// Store active sessions
const activeSessions = new Map();

// Helper function to extract token from cookie
async function extractToken(cookies) {
  try {
    const response = await axios.get('https://business.facebook.com/business_locations', {
      headers: {
        'user-agent': uaList[Math.floor(Math.random() * uaList.length)],
        'referer': 'https://www.facebook.com/',
        'host': 'business.facebook.com',
        'origin': 'https://business.facebook.com',
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      cookies: cookies,
      timeout: 10000
    });

    const tokenMatch = response.data.match(/(EAAG\w+)/);
    return tokenMatch ? tokenMatch[1] : null;
  } catch (error) {
    logger.error('Token extraction error:', error);
    return null;
  }
}

// Share post function
async function sharePost(token, cookies, link, accountShares, failedAccounts) {
  if (failedAccounts.has(token)) {
    return { success: false, error: 'Account failed' };
  }

  const maxRetries = 20;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const ua = uaList[Math.floor(Math.random() * uaList.length)];
      
      const headers = {
        'authority': 'graph.facebook.com',
        'cache-control': 'max-age=0',
        'user-agent': ua
      };

      if (link.toLowerCase().includes('video') || link.toLowerCase().includes('reel')) {
        headers['accept'] = 'application/json';
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }

      const response = await axios.post(
        `https://graph.facebook.com/v18.0/me/feed`,
        null,
        {
          params: {
            link: link,
            published: 0,
            access_token: token
          },
          headers: headers,
          cookies: cookies,
          timeout: 25000
        }
      );

      if (response.data && response.data.id) {
        accountShares.set(token, (accountShares.get(token) || 0) + 1);
        return { 
          success: true, 
          targetUid: response.data.id.split('_')[0] || response.data.id,
          shareCount: accountShares.get(token)
        };
      }

      return { success: false, error: 'Unknown response' };

    } catch (error) {
      if (error.response && error.response.data && error.response.data.error) {
        const errorMsg = error.response.data.error.message.toLowerCase();
        
        if (errorMsg.includes('rate limit') || errorMsg.includes('suspended') || 
            errorMsg.includes('blocked') || errorMsg.includes('checkpoint')) {
          logger.error(`Account suspended/blocked: ${token.substring(0, 10)}...`);
          failedAccounts.add(token);
          return { success: false, error: 'Account suspended/blocked' };
        }
        
        if (errorMsg.includes('video') || errorMsg.includes('reel')) {
          logger.warn(`Video content error for token ${token.substring(0, 10)}..., retrying...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
      }

      // Exponential backoff
      const backoffTime = Math.min(5000 * Math.pow(2, attempt), 900000);
      logger.info(`Retry attempt ${attempt + 1} in ${backoffTime/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }

  failedAccounts.add(token);
  return { success: false, error: 'Max retries exceeded' };
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { cookies } = req.body;
    
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'Invalid cookies data' });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const tokens = [];
    const cookiesList = [];
    const results = [];

    for (let i = 0; i < cookies.length; i++) {
      try {
        const cookieObj = {};
        cookies[i].split('; ').forEach(pair => {
          const [key, value] = pair.split('=');
          if (key && value) cookieObj[key] = value;
        });

        const token = await extractToken(cookieObj);
        
        if (token) {
          tokens.push(token);
          cookiesList.push(cookieObj);
          results.push({ index: i + 1, success: true, token: token });
        } else {
          results.push({ index: i + 1, success: false, error: 'Token extraction failed' });
        }
      } catch (error) {
        logger.error(`Cookie processing error for index ${i + 1}:`, error);
        results.push({ index: i + 1, success: false, error: error.message });
      }
    }

    if (tokens.length === 0) {
      return res.status(400).json({ error: 'No valid cookies found', results });
    }

    // Store session data
    activeSessions.set(sessionId, {
      tokens,
      cookiesList,
      accountShares: new Map(tokens.map(t => [t, 0])),
      failedAccounts: new Set(),
      createdAt: new Date()
    });

    res.json({
      success: true,
      sessionId,
      tokenCount: tokens.length,
      results
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start sharing endpoint
app.post('/api/share', async (req, res) => {
  try {
    const { sessionId, link, limit } = req.body;

    if (!sessionId || !link || !limit) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const maxLimit = Math.min(parseInt(limit) || 0, 5000);
    if (maxLimit <= 0) {
      return res.status(400).json({ error: 'Invalid limit' });
    }

    const startTime = new Date();
    let successCount = 0;
    let failCount = 0;
    const shares = [];

    // Process shares in batches
    for (let i = 0; i < maxLimit; i++) {
      // Get available tokens
      const availableTokens = session.tokens.filter(t => 
        (session.accountShares.get(t) || 0) < 60 && !session.failedAccounts.has(t)
      );

      if (availableTokens.length === 0) {
        // Reset shares for non-failed accounts
        session.tokens.forEach(t => {
          if (!session.failedAccounts.has(t)) {
            session.accountShares.set(t, 0);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Check again
        const resetTokens = session.tokens.filter(t => !session.failedAccounts.has(t));
        if (resetTokens.length === 0) {
          break;
        }
        
        const token = resetTokens[Math.floor(Math.random() * resetTokens.length)];
        const cookie = session.cookiesList[session.tokens.indexOf(token)];
        
        const result = await sharePost(
          token, 
          cookie, 
          link, 
          session.accountShares, 
          session.failedAccounts
        );
        
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
        
        shares.push({
          shareNumber: i + 1,
          ...result
        });
      } else {
        const token = availableTokens[Math.floor(Math.random() * availableTokens.length)];
        const cookie = session.cookiesList[session.tokens.indexOf(token)];
        
        const result = await sharePost(
          token, 
          cookie, 
          link, 
          session.accountShares, 
          session.failedAccounts
        );
        
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
        
        shares.push({
          shareNumber: i + 1,
          ...result
        });
      }

      // Cooldown every 60 shares
      if ((i + 1) % 60 === 0 && i + 1 < maxLimit) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      // Small delay between shares
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;

    res.json({
      success: true,
      stats: {
        totalShares: maxLimit,
        successCount,
        failCount,
        duration: `${duration.toFixed(2)} seconds`,
        activeAccounts: session.tokens.length - session.failedAccounts.size,
        failedAccounts: session.failedAccounts.size
      },
      shares: shares.slice(-10) // Return last 10 shares
    });

  } catch (error) {
    logger.error('Share error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session status
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId,
    tokenCount: session.tokens.length,
    activeAccounts: session.tokens.length - session.failedAccounts.size,
    failedAccounts: session.failedAccounts.size,
    sharesPerAccount: Object.fromEntries(session.accountShares),
    createdAt: session.createdAt
  });
});

// Cleanup old sessions (every hour)
setInterval(() => {
  const now = new Date();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.createdAt > 24 * 60 * 60 * 1000) { // 24 hours
      activeSessions.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

module.exports = app;