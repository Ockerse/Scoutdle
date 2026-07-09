// ===================================================================
// generate-image-manifest.js
//
// Pre-fetches every character's image URL from the Jikan API ONE TIME
// and writes them to images.json, so the live game never has to hit
// Jikan for these characters at all - it just reads the static file.
//
// This is a build-time tool, not part of the game itself. Run it
// yourself, on your own machine, whenever anime.csv changes (new
// characters added, etc).
//
// USAGE:
//   node generate-image-manifest.js
//
// REQUIREMENTS:
//   Node.js 18 or newer (uses the built-in fetch - no npm install
//   needed). Check your version with `node -v` if this errors out.
//
// It reads anime.csv, finds every unique MAL_ID, fetches each one from
// Jikan with a safe delay + retry between requests (same approach as
// the game's own client-side fetch), and writes the results to
// images.json in this directory. That file just needs to sit next to
// index.html - the game will pick it up automatically on load.
//
// With ~900 characters and a ~400ms delay between requests, this
// takes roughly 6-7 minutes. It prints progress as it goes, and a
// summary of anything that failed at the end (you can just re-run the
// script - already-succeeded entries in an existing images.json are
// kept and skipped, so re-runs only chase down what's still missing).
// ===================================================================

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, 'anime.csv');
const OUTPUT_PATH = path.join(__dirname, 'images.json');
const REQUEST_DELAY_MS = 400; // stays comfortably under Jikan's ~3 req/sec limit
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1000;

function parseCsvIds(csvText) {
    const lines = csvText.split(/\r?\n/).filter(Boolean);
    const ids = [];
    // Skip header row. Columns: Name,Series,Age,Height,Sex,Hair,Eyes,MAL_ID,Genre,Year Release
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const id = cols[7]?.trim();
        if (id && !isNaN(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchImageUrl(id, attempt = 0) {
    try {
        const res = await fetch(`https://api.jikan.moe/v4/characters/${id}`);

        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            if (attempt < MAX_RETRIES) {
                const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
                const delay = !isNaN(retryAfter) ? retryAfter * 1000 : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                console.log(`  [${id}] HTTP ${res.status} - retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await sleep(delay);
                return fetchImageUrl(id, attempt + 1);
            }
            console.log(`  [${id}] HTTP ${res.status} persisted after ${MAX_RETRIES} retries - giving up`);
            return null;
        }

        if (!res.ok) {
            console.log(`  [${id}] HTTP ${res.status} - not retryable, skipping`);
            return null;
        }

        const data = await res.json();
        return data.data?.images?.jpg?.image_url || null;
    } catch (e) {
        console.log(`  [${id}] network error: ${e.message}`);
        return null;
    }
}

async function main() {
    if (typeof fetch !== 'function') {
        console.error('This script needs Node.js 18+ for built-in fetch(). Please upgrade Node and try again.');
        process.exit(1);
    }

    if (!fs.existsSync(CSV_PATH)) {
        console.error(`Couldn't find anime.csv at ${CSV_PATH}`);
        process.exit(1);
    }

    const csvText = fs.readFileSync(CSV_PATH, 'utf8');
    const ids = parseCsvIds(csvText);
    console.log(`Found ${ids.length} unique character IDs in anime.csv`);

    // Resume support: keep any entries an earlier run already succeeded on.
    let manifest = {};
    if (fs.existsSync(OUTPUT_PATH)) {
        try {
            manifest = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
            console.log(`Found existing images.json with ${Object.keys(manifest).length} entries - will only fetch what's missing`);
        } catch (e) {
            console.log('Existing images.json was unreadable - starting fresh');
            manifest = {};
        }
    }

    const idsToFetch = ids.filter(id => !manifest[id]);
    console.log(`Fetching ${idsToFetch.length} missing image(s)...\n`);

    const failed = [];
    for (let i = 0; i < idsToFetch.length; i++) {
        const id = idsToFetch[i];
        const url = await fetchImageUrl(id);
        if (url) {
            manifest[id] = url;
            console.log(`[${i + 1}/${idsToFetch.length}] ${id} -> OK`);
        } else {
            failed.push(id);
            console.log(`[${i + 1}/${idsToFetch.length}] ${id} -> FAILED`);
        }

        // Save progress every 25 characters, so a crash/interrupt doesn't
        // lose everything fetched so far.
        if (i % 25 === 0) {
            fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2));
        }

        if (i < idsToFetch.length - 1) await sleep(REQUEST_DELAY_MS);
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2));

    console.log(`\nDone. images.json now has ${Object.keys(manifest).length} / ${ids.length} character images.`);
    if (failed.length > 0) {
        console.log(`${failed.length} character(s) failed and were skipped (Jikan may not have them, or the ID is stale):`);
        console.log(failed.join(', '));
        console.log('Just run this script again later to retry only the missing ones.');
    }
}

main();
