import { Client } from '@notionhq/client';

const API_URL = process.env.API_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2026-03-11';
const IMAGE_PROPERTY = process.env.IMAGE_PROPERTY || 'Image';
const TRADE_PROPERTY = process.env.TRADE_PROPERTY || 'TRADE NO';
const SCREENSHOT_PROPERTY = process.env.SCREENSHOT_PROPERTY || 'Screenshot';

if (!API_URL || !NOTION_TOKEN || !DATABASE_ID) {
  throw new Error('Missing API_URL, NOTION_TOKEN, or NOTION_DATABASE_ID GitHub Secret.');
}

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: NOTION_VERSION });

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API HTTP ${res.status}: ${text.slice(0, 1000)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Google API did not return JSON: ${text.slice(0, 1000)}`); }
}

function getTradingViewImageUrl(value) {
  if (!value) return null;
  const url = String(value).trim();

  // TradingView snapshot link: https://www.tradingview.com/x/ABC123/
  const match = url.match(/^https?:\/\/(?:www\.)?tradingview\.com\/x\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i);
  if (match) {
    const id = match[1];
    // TradingView snapshot image path uses the first character of the snapshot id.
    return `https://s3.tradingview.com/snapshots/${id[0].toLowerCase()}/${id}.png`;
  }

  // If the sheet already contains a direct image URL, use it as-is.
  if (/^https?:\/\/.+\.(?:png|jpe?g|gif|webp)(?:\?.*)?$/i.test(url)) return url;

  return null;
}

function getPropertyText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(x => x.plain_text || '').join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(x => x.plain_text || '').join('');
  if (prop.type === 'url') return prop.url || '';
  if (prop.type === 'number') return prop.number == null ? '' : String(prop.number);
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  return '';
}

async function getDataSourceId() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  const sources = db.data_sources || db.dataSources || [];
  if (!sources.length) throw new Error('No Notion data source was found in the database.');
  return sources[0].id;
}

async function getAllPages(dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await notion.request({
      path: `data_sources/${dataSourceId}/query`,
      method: 'post',
      body
    });
    pages.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function updateImage(pageId, imageUrl) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [IMAGE_PROPERTY]: {
        files: [{
          type: 'external',
          name: 'TradingView chart',
          external: { url: imageUrl }
        }]
      }
    }
  });
}

async function main() {
  console.log('IMAGE-ONLY SYNC STARTED');
  console.log(`Image property: ${IMAGE_PROPERTY}`);

  const apiRows = await getJson(API_URL);
  if (!Array.isArray(apiRows)) throw new Error('Google API response is not an array.');
  console.log(`Google API rows: ${apiRows.length}`);

  const dataSourceId = await getDataSourceId();
  console.log(`Notion data source: ${dataSourceId}`);

  const pages = await getAllPages(dataSourceId);
  console.log(`Notion pages: ${pages.length}`);

  // Map pages by TRADE NO. We only update the Image property.
  const pageByTrade = new Map();
  for (const page of pages) {
    const trade = getPropertyText(page.properties?.[TRADE_PROPERTY]).trim();
    if (trade) pageByTrade.set(trade, page.id);
  }

  let updated = 0, skipped = 0, missing = 0, failed = 0;

  for (const row of apiRows) {
    const trade = String(row[TRADE_PROPERTY] ?? row['TRADE NO'] ?? row._row ?? '').trim();
    const screenshot = String(row[SCREENSHOT_PROPERTY] ?? row['Screenshot'] ?? row['ScreenshotUrl'] ?? '').trim();
    const imageUrl = getTradingViewImageUrl(screenshot);

    if (!trade) { console.log('SKIP: no TRADE NO'); skipped++; continue; }
    if (!imageUrl) { console.log(`SKIP Trade ${trade}: no supported Screenshot URL`); skipped++; continue; }

    const pageId = pageByTrade.get(trade);
    if (!pageId) { console.log(`MISSING Trade ${trade}: no matching Notion page`); missing++; continue; }

    try {
      await updateImage(pageId, imageUrl);
      console.log(`UPDATED Trade ${trade} -> ${imageUrl}`);
      updated++;
      // Small delay to be gentle with API rate limits.
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      failed++;
      console.error(`FAILED Trade ${trade}: ${err.message}`);
    }
  }

  console.log(`DONE — updated: ${updated}, skipped: ${skipped}, missing Notion pages: ${missing}, failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
