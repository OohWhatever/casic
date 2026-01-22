async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' };
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || 'Request failed';
    throw new Error(message);
  }
  return data;
}

async function loadProfile(targetId = 'profile-box') {
  try {
    const data = await api('/profile');
    setProfileBox(data, targetId);
    return data;
  } catch (err) {
    console.error(err);
    const el = document.getElementById(targetId);
    if (el) el.textContent = 'Нужно войти в систему';
    return null;
  }
}

function setProfileBox(data, targetId = 'profile-box') {
  if (!data) return;
  const el = document.getElementById(targetId);
  if (!el) return;
  const prefix = data.username ? `${data.username}: ` : '';
  el.textContent = `${prefix}баланс ${data.balance}₽, фрибеты ${data.freebets}₽`;
}

function attachSlotPreview({ stakeInputId, previewId, defaultStake, multiplier, formatter }) {
  const stakeInput = document.getElementById(stakeInputId);
  const preview = document.getElementById(previewId);
  if (!stakeInput || !preview) return () => {};

  const render = () => {
    const raw = Number(stakeInput.value);
    const stake = raw > 0 ? raw : defaultStake;
    const reward = multiplier ? Math.round(stake * multiplier) : null;
    preview.textContent = formatter
      ? formatter({ stake, reward })
      : `Потенциальный проигрыш: ${stake}₽, потенциальный выигрыш: ${reward}₽`;
  };

  stakeInput.addEventListener('input', render);
  render();
  return render;
}

function randomSymbol(symbols) {
  return symbols[Math.floor(Math.random() * symbols.length)];
}

function setReelSymbols(reelEl, symbols) {
  const container = reelEl.querySelector('.symbols');
  if (!container) return;
  container.innerHTML = '';
  symbols.forEach((sym) => {
    const div = document.createElement('div');
    div.className = 'symbol';
    div.textContent = sym;
    container.appendChild(div);
  });
}

function createSlotAnimator({ reelIds, symbols, durations }) {
  const reels = reelIds.map((id) => document.getElementById(id)).filter(Boolean);
  return function animate(finalSymbols) {
    return new Promise((resolve) => {
      let finished = 0;
      reels.forEach((reel, idx) => {
        const tick = () =>
          setReelSymbols(reel, [randomSymbol(symbols), randomSymbol(symbols), randomSymbol(symbols)]);
        tick();
        const interval = setInterval(tick, 90);
        setTimeout(() => {
          clearInterval(interval);
          setReelSymbols(reel, [randomSymbol(symbols), finalSymbols[idx], randomSymbol(symbols)]);
          finished += 1;
          if (finished === reels.length) resolve();
        }, durations[idx]);
      });
    });
  };
}
