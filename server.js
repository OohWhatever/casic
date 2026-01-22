const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'casino.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function initializeDb() {
  await runAsync(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      balance INTEGER DEFAULT 0,
      freebets INTEGER DEFAULT 0
    )`
  );
  await runAsync(
    `CREATE TABLE IF NOT EXISTS casino_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bet_amount INTEGER NOT NULL,
      balance_type TEXT NOT NULL,
      reels TEXT NOT NULL,
      multiplier REAL NOT NULL,
      win_amount INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

initializeDb().catch((err) => {
  console.error('DB init failed', err);
  process.exit(1);
});

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

const SLOT_CONFIG = {
  a: { id: 'a', name: 'Slot Machine A', cost: 100, reward: 300, odds: 0.45 }, // reward is for base cost
  b: { id: 'b', name: 'Slot Machine B', cost: 200, reward: 700, odds: 0.35 },
};

const SLOT_SYMBOLS = ['💎', 'A', 'K', 'Q', 'J', '10'];

function authRequired(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return next();
}

async function findUserById(id) {
  return getAsync('SELECT id, username, balance, freebets, password_hash FROM users WHERE id = ?', [id]);
}

app.post('/register', async (req, res) => {
  const { username, password, promo } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const existing = await getAsync('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hash = await bcrypt.hash(password, 8);
    const freebets = promo === 'SCAM' ? 1000 : 0;

    const result = await runAsync(
      'INSERT INTO users (username, password_hash, balance, freebets) VALUES (?, ?, 0, ?)',
      [username, hash, freebets]
    );
    req.session.userId = result.lastID;
    return res.json({ message: 'Registered', promoApplied: freebets > 0 });
  } catch (err) {
    console.error('Register error', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await getAsync('SELECT id, password_hash FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    return res.json({ message: 'Logged in' });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/profile', authRequired, async (req, res) => {
  try {
    const user = await findUserById(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({
      username: user.username,
      balance: user.balance,
      freebets: user.freebets,
    });
  } catch (err) {
    console.error('Profile error', err);
    return res.status(500).json({ error: 'Profile failed' });
  }
});

function calculateOutcome(slotId, userId) {
  // TODO: next iteration may mix client-influenced seed for research; keep RNG server-side for now
  const config = SLOT_CONFIG[slotId];
  if (!config) return false;
  const roll = Math.random();
  return roll < config.odds;
}

function evaluateSlotsReels(reels) {
  const [r1, r2, r3] = reels;
  const counts = reels.reduce((acc, sym) => {
    acc[sym] = (acc[sym] || 0) + 1;
    return acc;
  }, {});

  // Three of a kind
  if (r1 === r2 && r2 === r3) {
    const pay = {
      '💎': 30,
      A: 15,
      K: 10,
      Q: 7,
      J: 5,
      '10': 3,
    };
    return pay[r1] || 0;
  }

  // Pattern wins
  if (r1 === '💎' && r3 === '💎') return 8; // 💎 * 💎
  if (r1 === 'A' && r3 === 'A' && r2 !== 'A') return 4; // A * A
  const akqSet = new Set(['A', 'K', 'Q']);
  if (reels.length === new Set(reels).size && reels.every((s) => akqSet.has(s))) {
    return 2; // all different but among A/K/Q
  }

  // Two of a kind (excluding three of a kind handled above)
  const twoOfKindPay = [
    ['💎', 5],
    ['A', 3],
    ['K', 2],
    ['Q', 1.5],
    ['J', 1],
    ['10', 0.5],
  ];
  for (const [symbol, multi] of twoOfKindPay) {
    if (counts[symbol] === 2) return multi;
  }

  return 0;
}

app.post('/slots/:id/spin', authRequired, async (req, res) => {
  const slotId = req.params.id;
  const config = SLOT_CONFIG[slotId];
  if (!config) {
    return res.status(404).json({ error: 'Unknown slot machine' });
  }

  const useFreebet = Boolean(req.body?.useFreebet);
  const stake = Number(req.body?.stake) > 0 ? Number(req.body.stake) : config.cost;

  try {
    const user = await findUserById(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (useFreebet) {
      if (user.freebets < stake) {
        return res.status(400).json({ error: 'Not enough freebets' });
      }
    } else if (user.balance < stake) {
      return res.status(400).json({ error: 'Not enough balance' });
    }

    const win = calculateOutcome(slotId, user.id);
    const rewardMultiplier = config.reward / config.cost;
    const rewardValue = Math.round(stake * rewardMultiplier);
    const balanceDelta = win ? rewardValue : 0;

    const nextBalance = useFreebet ? user.balance + balanceDelta : user.balance - stake + balanceDelta;
    const nextFreebets = useFreebet ? user.freebets - stake : user.freebets;

    await runAsync('UPDATE users SET balance = ?, freebets = ? WHERE id = ?', [
      nextBalance,
      nextFreebets,
      user.id,
    ]);

    return res.json({
      slot: config.name,
      win,
      stake,
      reward: win ? rewardValue : 0,
      balance: nextBalance,
      freebets: nextFreebets,
      username: user.username,
    });
  } catch (err) {
    console.error('Spin error', err);
    return res.status(500).json({ error: 'Spin failed' });
  }
});

function randomReels() {
  return [0, 1, 2].map(() => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);
}

async function withTransaction(work) {
  await runAsync('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await work();
    await runAsync('COMMIT');
    return result;
  } catch (err) {
    await runAsync('ROLLBACK');
    throw err;
  }
}

app.post('/casino/slot/spin', authRequired, async (req, res) => {
  const betAmount = Number(req.body?.bet_amount);
  const balanceType = req.body?.balance_type === 'freebet' ? 'freebet' : 'real';
  if (!Number.isFinite(betAmount) || betAmount <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }

  try {
    const result = await withTransaction(async () => {
      const user = await getAsync('SELECT id, username, balance, freebets FROM users WHERE id = ?', [
        req.session.userId,
      ]);
      if (!user) throw new Error('User not found');

      const available = balanceType === 'freebet' ? user.freebets : user.balance;
      if (available < betAmount) {
        const err = new Error('Not enough funds');
        err.code = 'INSUFFICIENT';
        throw err;
      }

      let nextBalance = user.balance;
      let nextFreebets = user.freebets;
      if (balanceType === 'freebet') {
        nextFreebets -= betAmount;
      } else {
        nextBalance -= betAmount;
      }

      const reels = randomReels();
      const multiplier = evaluateSlotsReels(reels);
      const winAmount = Math.round(betAmount * multiplier);

      nextBalance += winAmount; // wins always go to real balance

      await runAsync('UPDATE users SET balance = ?, freebets = ? WHERE id = ?', [
        nextBalance,
        nextFreebets,
        user.id,
      ]);

      await runAsync(
        'INSERT INTO casino_spins (user_id, bet_amount, balance_type, reels, multiplier, win_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          user.id,
          betAmount,
          balanceType,
          JSON.stringify(reels),
          multiplier,
          winAmount,
          new Date().toISOString(),
        ]
      );

      return {
        reels,
        multiplier,
        win_amount: winAmount,
        bet_amount: betAmount,
        balance_type: balanceType,
        balance: nextBalance,
        freebets: nextFreebets,
        username: user.username,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('Casino slot spin error', err);
    if (err.code === 'INSUFFICIENT') {
      return res.status(400).json({ error: 'Not enough funds' });
    }
    if (err.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.status(500).json({ error: 'Spin failed' });
  }
});

app.get('/bets', (req, res) => {
  const matches = [
    { id: 1, teams: 'Tigers vs Sharks', odds: '1.8 / 2.1' },
    { id: 2, teams: 'Eagles vs Wolves', odds: '1.5 / 2.5' },
    { id: 3, teams: 'Lions vs Bears', odds: '2.0 / 1.9' },
  ];
  // Betting logic will be implemented later
  res.json({ matches });
});

app.listen(PORT, () => {
  console.log(`Casino Lab running on http://0.0.0.0:${PORT}`);
});
