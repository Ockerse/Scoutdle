// ===================================================================
// download-character-images.js
//
// Downloads any MISSING character images into your existing
// /character_images folder, named <MAL_ID>.jpg - matching what the
// game already expects (game.js builds the path directly from each
// character's ID, no manifest file involved).
//
// This is a build-time tool, not part of the game itself. Run it
// yourself, on your own machine, to fill in any characters you don't
// already have a local image for (e.g. after adding new characters
// to anime.csv).
//
// USAGE:
//   node download-character-images.js
//
// REQUIREMENTS:
//   Node.js 18 or newer (uses the built-in fetch - no npm install
//   needed). Check your version with `node -v` if this errors out.
//
// HOW IT WORKS:
//   For each unique MAL_ID in anime.csv that doesn't already have a
//   character_images/<id>.jpg on disk:
//     1. Ask Jikan (MAL's official read-API) for that character's
//        current official image URL.
//     2. Download the actual image bytes from that URL.
//     3. Save them to character_images/<id>.jpg.
//   Both steps retry with backoff on rate limits (429) and transient
//   server errors (5xx); a 404 or similar isn't retried since that
//   means Jikan just doesn't have that character.
//
// Already-present files are skipped entirely, so this is safe and
// cheap to re-run any time - it only chases down what's still
// missing. Prints a summary of anything that failed at the end.
// ===================================================================

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, 'anime.csv');
const IMAGES_DIR = path.join(__dirname, 'character_images');
const JIKAN_DELAY_MS = 400; // stays comfortably under Jikan's ~3 req/sec limit
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
                console.log(`  [${id}] Jikan HTTP ${res.status} - retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await sleep(delay);
                return fetchImageUrl(id, attempt + 1);
            }
            console.log(`  [${id}] Jikan HTTP ${res.status} persisted after ${MAX_RETRIES} retries - giving up`);
            return null;
        }

        if (!res.ok) {
            console.log(`  [${id}] Jikan HTTP ${res.status} - not retryable, skipping`);
            return null;
        }

        const data = await res.json();
        return data.data?.images?.jpg?.image_url || null;
    } catch (e) {
        console.log(`  [${id}] Jikan network error: ${e.message}`);
        return null;
    }
}

async function downloadImage(id, url, attempt = 0) {
    try {
        const res = await fetch(url);

        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            if (attempt < MAX_RETRIES) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                console.log(`  [${id}] image download HTTP ${res.status} - retrying in ${delay}ms`);
                await sleep(delay);
                return downloadImage(id, url, attempt + 1);
            }
            console.log(`  [${id}] image download HTTP ${res.status} persisted - giving up`);
            return false;
        }

        if (!res.ok) {
            console.log(`  [${id}] image download HTTP ${res.status} - skipping`);
            return false;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        // Always saved as .jpg to match what game.js expects, regardless
        // of the source URL's actual extension.
        fs.writeFileSync(path.join(IMAGES_DIR, `${id}.jpg`), buffer);
        return true;
    } catch (e) {
        console.log(`  [${id}] image download network error: ${e.message}`);
        return false;
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

    if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR);
        console.log(`Created ${IMAGES_DIR}`);
    }

    const csvText = fs.readFileSync(CSV_PATH, 'utf8');
    const allIds = parseCsvIds(csvText);
    console.log(`Found ${allIds.length} unique character IDs in anime.csv`);

    const idsToFetch = allIds.filter(id => !fs.existsSync(path.join(IMAGES_DIR, `${id}.jpg`)));
    console.log(`${allIds.length - idsToFetch.length} already have a local image - fetching the remaining ${idsToFetch.length}...\n`);

    if (idsToFetch.length === 0) {
        console.log('Nothing to do - every character already has an image!');
        return;
    }

    const failed = [];
    for (let i = 0; i < idsToFetch.length; i++) {
        const id = idsToFetch[i];

        const imageUrl = await fetchImageUrl(id);
        if (!imageUrl) {
            failed.push(id);
            console.log(`[${i + 1}/${idsToFetch.length}] ${id} -> FAILED (couldn't get image URL from Jikan)`);
            if (i < idsToFetch.length - 1) await sleep(JIKAN_DELAY_MS);
            continue;
        }

        const ok = await downloadImage(id, imageUrl);
        if (ok) {
            console.log(`[${i + 1}/${idsToFetch.length}] ${id} -> OK`);
        } else {
            failed.push(id);
            console.log(`[${i + 1}/${idsToFetch.length}] ${id} -> FAILED (couldn't download image file)`);
        }

        if (i < idsToFetch.length - 1) await sleep(JIKAN_DELAY_MS);
    }

    const finalCount = allIds.filter(id => fs.existsSync(path.join(IMAGES_DIR, `${id}.jpg`))).length;
    console.log(`\nDone. character_images/ now has ${finalCount} / ${allIds.length} character images.`);
    if (failed.length > 0) {
        console.log(`${failed.length} character(s) failed and were skipped (Jikan may not have them, or the ID is stale):`);
        console.log(failed.join(', '));
        console.log('Just run this script again later to retry only the missing ones.');
    }
}

main();
