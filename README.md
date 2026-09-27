# Fax TradingView Image → Notion (Image Only)

This repository does ONLY one job:

Google Apps Script API → read `Screenshot` → find matching Notion page by `TRADE NO` → update only the Notion `Image` property.

It does not create trades and does not update any other Notion properties.

## GitHub Secrets

- `API_URL` = existing Google Apps Script `/exec` URL
- `NOTION_TOKEN` = new Notion integration token
- `NOTION_DATABASE_ID` = Journal Database ID

The Notion database must contain:
- `TRADE NO`
- `Image` (Files & media)
- `Screenshot` is in the Google API data; the Notion Screenshot property is not modified by this script.

## Workflow

Runs manually or approximately every 10 minutes.
