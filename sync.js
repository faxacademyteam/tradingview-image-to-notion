import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

const API_URL = process.env.API_URL;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const IMAGE_PROPERTY = "Image";

function tradingViewImageUrl(url) {
  if (!url) return null;

  const match = url.match(
    /tradingview\.com\/x\/([A-Za-z0-9_-]+)\/?/i
  );

  if (!match) return null;

  const snapshotId = match[1];

  // TradingView snapshot image
  return `https://s3.tradingview.com/snapshots/${snapshotId[0].toLowerCase()}/${snapshotId}.png`;
}

function getTradeNo(properties) {
  for (const key of Object.keys(properties)) {
    if (key.trim().toUpperCase() === "TRADE NO") {
      const p = properties[key];

      if (p.type === "title" && p.title?.length) {
        return p.title.map(x => x.plain_text || "").join("").trim();
      }

      if (p.type === "rich_text" && p.rich_text?.length) {
        return p.rich_text.map(x => x.plain_text || "").join("").trim();
      }

      if (p.type === "number" && p.number !== null) {
        return String(p.number);
      }
    }
  }

  return null;
}

async function getDataSourceId() {
  const response = await notion.databases.retrieve({
    database_id: DATABASE_ID
  });

  if (!response.data_sources || response.data_sources.length === 0) {
    throw new Error("No Notion data source found.");
  }

  return response.data_sources[0].id;
}

async function getNotionPages(dataSourceId) {
  const pages = [];
  let cursor = undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100
    });

    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return pages;
}

async function main() {
  console.log("IMAGE-ONLY SYNC STARTED");
  console.log(`Image property: ${IMAGE_PROPERTY}`);

  // ---------------------------------------------------------
  // 1. Get Google API data
  // ---------------------------------------------------------

  const apiResponse = await fetch(API_URL);

  if (!apiResponse.ok) {
    throw new Error(
      `Google API failed: ${apiResponse.status} ${apiResponse.statusText}`
    );
  }

  const rows = await apiResponse.json();

  console.log(`Google API rows: ${rows.length}`);

  // ---------------------------------------------------------
  // 2. Get Notion data source
  // ---------------------------------------------------------

  const dataSourceId = await getDataSourceId();

  console.log(`Notion data source: ${dataSourceId}`);

  // ---------------------------------------------------------
  // 3. Get Notion pages
  // ---------------------------------------------------------

  const pages = await getNotionPages(dataSourceId);

  console.log(`Notion pages: ${pages.length}`);

  // Map Trade No → Notion page
  const pageMap = new Map();

  for (const page of pages) {
    const tradeNo = getTradeNo(page.properties);

    if (tradeNo) {
      pageMap.set(tradeNo, page);
    }
  }

  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  // ---------------------------------------------------------
  // 4. Process each Google row
  // ---------------------------------------------------------

  for (const row of rows) {
    const tradeNo = String(row["TRADE NO"] || "").trim();

    if (!tradeNo) {
      console.log("SKIP row: missing Trade No");
      skipped++;
      continue;
    }

    const page = pageMap.get(tradeNo);

    if (!page) {
      console.log(`MISSING Trade ${tradeNo}: Notion page not found`);
      missing++;
      continue;
    }

    // IMPORTANT:
    // Use ScreenshotUrl, NOT Screenshot
    const screenshotUrl =
      row["ScreenshotUrl"] ||
      row["ScreenshotURL"] ||
      row["Screenshot Url"] ||
      "";

    if (!screenshotUrl) {
      console.log(
        `SKIP Trade ${tradeNo}: ScreenshotUrl is empty`
      );
      skipped++;
      continue;
    }

    const imageUrl = tradingViewImageUrl(screenshotUrl);

    if (!imageUrl) {
      console.log(
        `SKIP Trade ${tradeNo}: unsupported ScreenshotUrl: ${screenshotUrl}`
      );
      skipped++;
      continue;
    }

    console.log(`Trade ${tradeNo}`);
    console.log(`  ScreenshotUrl: ${screenshotUrl}`);
    console.log(`  Image: ${imageUrl}`);

    try {
      await notion.pages.update({
        page_id: page.id,
        properties: {
          [IMAGE_PROPERTY]: {
            files: [
              {
                type: "external",
                name: `Trade ${tradeNo}`,
                external: {
                  url: imageUrl
                }
              }
            ]
          }
        }
      });

      console.log(`  UPDATED Trade ${tradeNo}`);
      updated++;

    } catch (error) {
      failed++;

      console.error(
        `  FAILED Trade ${tradeNo}:`,
        error.body || error.message || error
      );
    }
  }

  console.log("");
  console.log(
    `DONE — updated: ${updated}, skipped: ${skipped}, missing Notion pages: ${missing}, failed: ${failed}`
  );
}

main().catch(error => {
  console.error("FATAL ERROR:");
  console.error(error.body || error.message || error);
  process.exit(1);
});
