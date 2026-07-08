// ===================================================================
// SCOUTDLE - Game Logic
// ===================================================================

let characters = [], secretChar = null, fuse = null, guesses = [], gameOver = false, currentMode = 'daily';
let hintsRevealed = 0;
const MAX_GUESSES = 10;
const imgCache = new Map();

// Attributes compared every guess, in display order.
const ATTRS = ["Series", "Genre", "Year", "Sex", "Age", "Height", "Hair", "Eyes"];

// -------------------------------------------------------------------
// FIX #8: Guesses/lookups are keyed by MAL_ID (unique) instead of
// Name, so two characters sharing a name can never collide.
// -------------------------------------------------------------------
function findCharById(id) {
    return characters.find(c => c.ID === id);
}

// -------------------------------------------------------------------
// FIX #2: Single source of truth for the tiered green/yellow/orange/
// black comparison logic. Both the on-screen cards (renderGuessCard)
// and the shareable emoji grid (shareResult) call this, so the
// thresholds can never drift out of sync between the two.
//
// FIX #6: The "ageless" (100+) comparison is now symmetric - it
// triggers whenever EITHER the guess or the target is 100+, and
// checks both directions, instead of only working one way.
//
// FIX #7: Missing/non-numeric values now resolve to a distinct
// "unknown" state instead of silently rendering as a normal miss.
// -------------------------------------------------------------------
function compareAttr(key, guessVal, targetVal) {
    const gStr = (guessVal ?? '').toString().trim();
    const tStr = (targetVal ?? '').toString().trim();

    if (!gStr || !tStr) {
        return { state: 'unknown', direction: '' };
    }

    if (gStr.toLowerCase() === tStr.toLowerCase()) {
        return { state: 'green', direction: '' };
    }

    const gVal = parseInt(gStr, 10);
    const tVal = parseInt(tStr, 10);

    if (isNaN(gVal) || isNaN(tVal)) {
        return { state: 'black', direction: '' };
    }

    const diff = Math.abs(gVal - tVal);
    const direction = gVal < tVal ? 'up' : 'down';
    let state = 'black';

    if (key === "Year") {
        if (diff <= 3) state = 'yellow';
        else if (diff <= 5) state = 'orange';
    } else if (key === "Age") {
        // "Ageless" characters (immortals, gods, etc.) are flagged if
        // EITHER value is 100+, and we check both directions so the
        // hint is meaningful no matter which one is the outlier.
        if (gVal >= 100 || tVal >= 100) {
            if ((gVal >= 100) === (tVal >= 100) && diff <= 100) state = 'yellow';
            else if (diff <= 3) state = 'yellow';
            else if (diff <= 5) state = 'orange';
        } else {
            if (diff <= 3) state = 'yellow';
            else if (diff <= 5) state = 'orange';
        }
    } else if (key === "Height") {
        if (diff <= 5) state = 'yellow';
        else if (diff <= 10) state = 'orange';
    }

    return { state, direction };
}

// -------------------------------------------------------------------
// FIX #3: Image fetches are now queued and throttled instead of
// firing one uncapped request per guess. Jikan's public tier is rate
// limited (~3 req/sec, 60/min); a queue with a small delay keeps us
// well under that and avoids silent fallback-image failures.
// -------------------------------------------------------------------
const imgQueue = [];
let imgQueueRunning = false;
const IMG_REQUEST_DELAY_MS = 350; // ~3 req/sec ceiling

function queueImageFetch(id) {
    return new Promise((resolve) => {
        imgQueue.push({ id, resolve });
        runImgQueue();
    });
}

async function runImgQueue() {
    if (imgQueueRunning) return;
    imgQueueRunning = true;
    while (imgQueue.length > 0) {
        const { id, resolve } = imgQueue.shift();
        resolve(await fetchImageNow(id));
        if (imgQueue.length > 0) {
            await new Promise(r => setTimeout(r, IMG_REQUEST_DELAY_MS));
        }
    }
    imgQueueRunning = false;
}

async function fetchImageNow(id) {
    if (!id || isNaN(id)) return "Scoutdle.jpeg";
    if (imgCache.has(id)) return imgCache.get(id);
    try {
        const res = await fetch(`https://api.jikan.moe/v4/characters/${id}`);
        if (res.ok) {
            const data = await res.json();
            const url = data.data?.images?.jpg?.image_url || "Scoutdle.jpeg";
            imgCache.set(id, url);
            return url;
        }
    } catch (e) { console.error("Img fetch error", e); }
    return "Scoutdle.jpeg";
}

async function fetchImage(id) {
    if (!id || isNaN(id)) return "Scoutdle.jpeg";
    if (imgCache.has(id)) return imgCache.get(id);
    return queueImageFetch(id);
}

function resetToHome() {
    gameOver = false;
    guesses = [];
    hintsRevealed = 0;
    document.getElementById('game-content').style.display = 'none';
    document.getElementById('start-screen').style.display = 'block';
    document.getElementById('gameGrid').innerHTML = '';
    document.getElementById('end-actions').innerHTML = '';
    document.getElementById('hint-text').innerHTML = '';
    document.getElementById('hint-btn').style.display = 'none';
    document.getElementById('guessInput').value = '';
    document.getElementById('guessInput').disabled = false;

    setupMetaDashboard();
    showSection('game-view', document.getElementById('play-nav'));
}

function showLoadError(message) {
    const loadingMsg = document.getElementById('loading-msg');
    loadingMsg.innerText = message;
    loadingMsg.style.color = 'var(--orange)';
}

// -------------------------------------------------------------------
// FIX #10: CSV load failures now surface a visible error instead of
// silently leaving `characters` empty forever.
// -------------------------------------------------------------------
async function init() {
    Papa.parse("anime.csv", {
        download: true, header: false, skipEmptyLines: true,
        error: function (err) {
            console.error("CSV load error", err);
            showLoadError("⚠️ Couldn't load character data. Please refresh, or check your connection.");
        },
        complete: function (results) {
            try {
                if (!results.data || results.data.length === 0) {
                    showLoadError("⚠️ Character data was empty. Please refresh the page.");
                    return;
                }

                const startIdx = (results.data[0][0]?.toLowerCase() === "name" || results.data[0][1]?.toLowerCase() === "series") ? 1 : 0;

                const parsed = results.data.slice(startIdx).map(r => ({
                    "Name": r[0]?.trim(),
                    "Series": r[1]?.trim() === "FMA: B" ? "Full Metal Alchemist Brotherhood" : r[1]?.trim() || "???",
                    "Age": r[2]?.trim(),
                    "Height": r[3]?.trim(),
                    "Sex": r[4]?.trim(),
                    "Hair": r[5]?.trim(),
                    "Eyes": r[6]?.trim(),
                    "ID": r[7]?.trim(),
                    "Genre": r[8]?.trim() || "???",
                    "Year": r[9]?.trim() || "????"
                })).filter(c => c.Name);

                if (parsed.length === 0) {
                    showLoadError("⚠️ No valid characters found in data file.");
                    return;
                }

                // FIX #4: Stable sort order by numeric MAL_ID (fallback to
                // Name) rather than the CSV's row order. Combined with
                // charForDate() below, this makes the daily seed far less
                // likely to shift for existing dates when new characters
                // are appended to the roster.
                characters = parsed.sort((a, b) => {
                    const idA = parseInt(a.ID, 10), idB = parseInt(b.ID, 10);
                    if (!isNaN(idA) && !isNaN(idB) && idA !== idB) return idA - idB;
                    return a.Name.localeCompare(b.Name);
                });

                fuse = new Fuse(characters, {
                    keys: [
                        { name: 'Name', weight: 1.0 },
                        { name: 'Series', weight: 0.5 }
                    ],
                    threshold: 0.35,
                    minMatchCharLength: 1
                });

                populateArchive();
                document.getElementById('loading-msg').style.display = "none";
                document.getElementById('menu-options').style.display = 'block';

                setupMetaDashboard();
                updateStats();
            } catch (e) {
                console.error("Error processing character data", e);
                showLoadError("⚠️ Something went wrong loading the game. Please refresh.");
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) {
            document.getElementById('dropdown').style.display = 'none';
        }
    });
}

// -------------------------------------------------------------------
// FIX #5: One seeded-RNG helper shared by the daily picker and the
// "yesterday's answer" dashboard, instead of two copies of the same
// mulberry32-style math that could silently drift apart.
// -------------------------------------------------------------------
function seedForDate(date) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function charForDate(date) {
    if (characters.length === 0) return null;
    const seed = seedForDate(date);
    let t = seed + 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    const randomFloat = ((t ^ t >>> 14) >>> 0) / 4294967296;
    return characters[Math.floor(randomFloat * characters.length)];
}

function getDailyChar() {
    return charForDate(new Date());
}

async function setupMetaDashboard() {
    const dashboard = document.getElementById('daily-dashboard-meta');
    dashboard.style.display = 'block';

    function tickTimer() {
        const now = new Date();
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);

        const gap = midnight - now;
        if (gap <= 0) return;

        const hrs = String(Math.floor((gap / (1000 * 60 * 60)) % 24)).padStart(2, '0');
        const mins = String(Math.floor((gap / (1000 * 60)) % 60)).padStart(2, '0');
        const secs = String(Math.floor((gap / 1000) % 60)).padStart(2, '0');

        document.getElementById('meta-timer-countdown').innerText = `${hrs}:${mins}:${secs}`;
    }
    if (!window.metaTimerIntervalId) {
        window.metaTimerIntervalId = setInterval(tickTimer, 1000);
    }
    tickTimer();

    if (characters.length > 0) {
        const now = new Date();
        const yesterdayDate = new Date(now);
        yesterdayDate.setDate(now.getDate() - 1);

        const yesterdayChar = charForDate(yesterdayDate);

        if (yesterdayChar) {
            document.getElementById('yesterday-char-name').innerText = yesterdayChar.Name;
            document.getElementById('yesterday-char-series').innerText = yesterdayChar.Series;
            const imgUrl = await fetchImage(yesterdayChar.ID);
            document.getElementById('yesterday-char-img').src = imgUrl;
            document.getElementById('yesterday-meta-card').style.display = 'flex';
        }
    }
}

function revealHint() {
    const hintText = document.getElementById('hint-text');
    const categories = ATTRS.map(key => ({ key, label: key }));

    const unsolved = categories.filter(cat => {
        const isCorrect = guesses.some(g => String(g[cat.key]).trim().toLowerCase() === String(secretChar[cat.key]).trim().toLowerCase());
        return !isCorrect;
    });

    const displayedHints = hintText.innerText;
    const availableToReveal = unsolved.filter(cat => !displayedHints.includes(cat.label));

    if (availableToReveal.length > 0) {
        hintsRevealed++;
        const randomCat = availableToReveal[Math.floor(Math.random() * availableToReveal.length)];
        const newHint = `<span style="color:#ffffff">${randomCat.label}:</span> ${secretChar[randomCat.key]}`;

        const currentContent = hintText.innerHTML;
        hintText.innerHTML = currentContent ? `${currentContent} | ${newHint}` : newHint;
    } else if (hintsRevealed < 3) {
        hintsRevealed++;
        hintText.innerHTML += " | <span style='color:var(--green)'>All traits discovered!</span>";
    }

    updateHintButtonVisibility();
}

function updateHintButtonVisibility() {
    const btn = document.getElementById('hint-btn');
    const count = guesses.length;
    const canRevealNext = (
        (count >= 3 && hintsRevealed < 1) ||
        (count >= 5 && hintsRevealed < 2) ||
        (count >= 7 && hintsRevealed < 3)
    );
    btn.style.display = (canRevealNext && !gameOver) ? 'inline-block' : 'none';
}

async function startGame(mode) {
    currentMode = mode;
    gameOver = false;
    guesses = [];
    hintsRevealed = 0;

    document.getElementById('gameGrid').innerHTML = '';
    document.getElementById('end-actions').innerHTML = '';
    document.getElementById('hint-text').innerHTML = '';
    document.getElementById('hint-btn').style.display = 'none';
    document.getElementById('start-screen').style.display = 'none';
    document.getElementById('game-content').style.display = 'block';
    document.getElementById('guessInput').disabled = false;
    document.getElementById('guessInput').value = '';

    document.getElementById('daily-dashboard-meta').style.display = 'none';

    if (mode === 'daily') {
        secretChar = getDailyChar();
        const today = new Date().toISOString().split('T')[0];
        await loadProgress(today);
    } else {
        secretChar = characters[Math.floor(Math.random() * characters.length)];
    }

    setupSearch();
    updateGuessCounter();
    updateHintButtonVisibility();
}

function setupSearch() {
    const input = document.getElementById('guessInput');
    const dropdown = document.getElementById('dropdown');

    input.oninput = () => {
        const query = input.value.trim();
        if (query.length < 1) { dropdown.style.display = 'none'; return; }

        const results = fuse.search(query).slice(0, 15);

        if (results.length > 0) {
            // FIX #8: dropdown items are selected by ID, not Name, so
            // duplicate-name characters resolve to the exact one clicked.
            dropdown.innerHTML = results.map(r => `
                <div class="item" onclick="selectGuess('${r.item.ID}')">
                    <strong style="color:#ffffff; font-size:1rem;">${r.item.Name}</strong><br>
                    <small style="color:#aaa;">${r.item.Series}</small>
                </div>`).join('');
            dropdown.style.display = 'block';
        } else {
            dropdown.style.display = 'none';
        }
    };
}

// -------------------------------------------------------------------
// FIX #8: Takes an ID now (previously took a Name string), and guards
// against duplicate guesses by ID rather than Name.
// -------------------------------------------------------------------
async function selectGuess(id) {
    if (gameOver) return;
    const char = findCharById(id);
    if (!char || guesses.some(g => g.ID === id)) return;

    document.getElementById('guessInput').value = '';
    document.getElementById('dropdown').style.display = 'none';

    guesses.push(char);
    updateGuessCounter();
    await renderGuessCard(char);

    if (char.ID === secretChar.ID) {
        await endGame("Victory!");
    } else if (guesses.length >= MAX_GUESSES) {
        await endGame("Game Over!");
    } else {
        saveProgress();
        updateHintButtonVisibility();
    }
}

function updateGuessCounter() {
    document.getElementById('guess-counter').innerText = `Guesses: ${guesses.length} / ${MAX_GUESSES}`;
}

// -------------------------------------------------------------------
// FIX #11: localStorage payloads are now versioned. If the shape of
// the stored data ever changes again in the future, bumping
// STORAGE_VERSION will cause old, incompatible data to be discarded
// instead of crashing JSON parsing / rendering assumptions.
// -------------------------------------------------------------------
const STORAGE_VERSION = 2;

function saveProgress() {
    if (currentMode !== 'daily') return;
    const today = new Date().toISOString().split('T')[0];
    localStorage.setItem('scoutdle_daily', JSON.stringify({
        v: STORAGE_VERSION,
        date: today,
        guesses: guesses.map(g => g.ID),
        gameOver
    }));
}

async function loadProgress(today) {
    const saved = localStorage.getItem('scoutdle_daily');
    if (saved) {
        let data;
        try {
            data = JSON.parse(saved);
        } catch (e) {
            localStorage.removeItem('scoutdle_daily');
            return;
        }

        if (data.v !== STORAGE_VERSION) {
            // Old/incompatible save shape - discard rather than risk
            // mis-rendering guesses from a previous data format.
            localStorage.removeItem('scoutdle_daily');
            return;
        }

        if (data.date === today) {
            for (const id of data.guesses) {
                const char = findCharById(id);
                if (char) {
                    guesses.push(char);
                    await renderGuessCard(char);
                }
            }
            updateGuessCounter();
            if (data.gameOver) {
                const win = guesses.length > 0 && guesses[guesses.length - 1].ID === secretChar.ID;
                await endGame(win ? "Victory!" : "Game Over!", false);
            }
        } else {
            localStorage.removeItem('scoutdle_daily');
        }
    }
}

function readStats() {
    const played = parseInt(localStorage.getItem('scoutdle_played') || '0');
    const wins = parseInt(localStorage.getItem('scoutdle_wins') || '0');
    let dist;
    try {
        dist = JSON.parse(localStorage.getItem('scoutdle_dist') || '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0}');
    } catch (e) {
        dist = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0, "10": 0 };
    }
    return { played, wins, dist };
}

async function recordGameOver(isWin) {
    if (currentMode !== 'daily') return;
    const { played, wins, dist } = readStats();

    localStorage.setItem('scoutdle_played', played + 1);
    if (isWin) {
        localStorage.setItem('scoutdle_wins', wins + 1);
        dist[guesses.length] = (dist[guesses.length] || 0) + 1;
        localStorage.setItem('scoutdle_dist', JSON.stringify(dist));
    }

    updateStats();
}

function updateStats() {
    const { played, wins, dist } = readStats();
    const maxVal = Math.max(...Object.values(dist), 1);

    let distHtml = '<div style="margin-top:25px; text-align:left;"><p style="font-size:0.8rem; color:var(--green); font-weight:bold; margin-bottom:12px; text-align:center;">GUESS DISTRIBUTION</p>';
    for (let i = 1; i <= 10; i++) {
        const count = dist[i] || 0;
        const width = Math.max((count / maxVal) * 100, 7);
        distHtml += `<div style="display:flex; align-items:center; margin-bottom:6px;"><div style="width:25px; color:#fff; font-size:0.8rem;">${i}</div><div style="flex-grow:1; background:#111; border-radius:4px; height:20px;"><div style="width:${width}%; background:${count > 0 ? 'var(--green)' : '#333'}; color:white; height:100%; display:flex; align-items:center; justify-content:flex-end; padding-right:8px; font-size:0.75rem;">${count > 0 ? count : ''}</div></div></div>`;
    }
    document.getElementById('stats-container').innerHTML = `<div style="display:flex; justify-content:space-around;"><div><h2>${played}</h2><p>PLAYED</p></div><div><h2 style="color:var(--green);">${wins}</h2><p>WINS</p></div><div><h2 style="color:var(--yellow);">${played ? Math.round((wins / played) * 100) : 0}%</h2><p>WIN %</p></div></div>${distHtml}`;
}

const STATE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', black: '⬛', unknown: '⬜' };

function shareResult() {
    const win = guesses.length > 0 && guesses[guesses.length - 1].ID === secretChar.ID;
    const score = win ? guesses.length : 'X';
    let shareText = `Scoutdle ${currentMode === 'daily' ? 'Daily' : 'Unlimited'} ${score}/${MAX_GUESSES}\n\n`;

    guesses.forEach(g => {
        let row = "";
        ATTRS.forEach(key => {
            const { state } = compareAttr(key, g[key], secretChar[key]);
            row += STATE_EMOJI[state];
        });
        shareText += row + "\n";
    });
    shareText += `\n${window.location.href}`;
    copyToClip(shareText);
}

function copyToClip(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => alert("Result copied to clipboard! 📋")).catch(() => fallbackCopy(text));
    } else { fallbackCopy(text); }
}

function fallbackCopy(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text; document.body.appendChild(textArea); textArea.select();
    try { document.execCommand('copy'); alert("Result copied to clipboard! 📋"); } catch (err) { alert("Please manually copy the text!"); }
    document.body.removeChild(textArea);
}

async function endGame(status, shouldSave = true) {
    gameOver = true;
    document.getElementById('guessInput').disabled = true;
    document.getElementById('hint-btn').style.display = 'none';

    if (shouldSave) {
        saveProgress();
        await recordGameOver(guesses[guesses.length - 1].ID === secretChar.ID);
    }

    const secretImgUrl = await fetchImage(secretChar.ID);
    const nameLink = `<a href="https://myanimelist.net/character/${secretChar.ID}" target="_blank" class="char-link" style="color:var(--green)">${secretChar.Name}</a>`;
    const msg = status === "Victory!" ? `✨ Victory! It was ${nameLink}` : `💀 Game Over! It was ${nameLink}`;

    document.getElementById('end-actions').innerHTML = `
        <div style="margin-bottom:20px; padding:20px; background:#222; border-radius:15px; border: 2px solid var(--green); text-align: center;">
            <img src="${secretImgUrl}" style="width: 120px; height: 170px; border-radius: 10px; border: 2px solid var(--green); margin-bottom: 15px; object-fit: cover;" onerror="this.src='Scoutdle.jpeg'">
            <h3 style="color: white; margin-top: 0;">${msg}</h3>
            <button class="menu-btn" style="background:var(--green); color:black;" onclick="shareResult()">Share Result 📊</button>
            <button class="menu-btn" style="background:#444; color:white; margin-top:10px;" onclick="resetToHome()">Back to Menu</button>
        </div>`;
}

async function renderGuessCard(guess) {
    const grid = document.getElementById('gameGrid');
    const card = document.createElement('div');
    card.className = 'char-card';
    const imgUrl = await fetchImage(guess.ID);

    const attrHtml = ATTRS.map((key, i) => {
        const val = guess[key];
        const target = secretChar[key];
        const { state, direction } = compareAttr(key, val, target);

        const cls = state === 'black' ? '' : state;
        const arrow = direction === 'up' ? ' ↑' : direction === 'down' ? ' ↓' : '';
        const displayVal = state === 'unknown' ? (val || '?') : val;

        return `<div class="attr-box ${cls}" style="animation-delay:${i * 0.05}s"><span class="attr-label">${key}</span><span><b style="color:#ffffff;">${displayVal}${arrow}</b></span></div>`;
    }).join('');

    const nameLink = `<a href="https://myanimelist.net/character/${guess.ID}" target="_blank" class="char-link"><strong style="color:var(--green); font-size:1.1rem;">${guess.Name}</strong></a>`;
    card.innerHTML = `<div class="char-header"><img src="${imgUrl}" class="char-image" onerror="this.src='Scoutdle.jpeg'"><div>${nameLink}<br><small style="color:#ffffff;">${guess.Series}</small></div></div><div class="attr-grid">${attrHtml}</div>`;
    grid.prepend(card);
}

function showSection(id, btn) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    btn.classList.add('active');
    if (id === 'stats-view') updateStats();
}

function populateArchive() {
    const sortedChars = [...characters].sort((a, b) => a.Series.localeCompare(b.Series) || a.Name.localeCompare(b.Name));
    document.getElementById('archiveBody').innerHTML = sortedChars.map(c => `<tr><td style="color:#ffffff;">${c.Series}</td><td><a href="https://myanimelist.net/character/${c.ID}" target="_blank" class="char-link"><strong>${c.Name}</strong></a></td></tr>`).join('');
}

function filterArchive() {
    const filter = document.getElementById("archiveSearch").value.toLowerCase();
    const rows = document.getElementById("archiveBody").getElementsByTagName("tr");
    for (let row of rows) row.classList.toggle("hidden", !row.textContent.toLowerCase().includes(filter));
}

window.onload = init;
