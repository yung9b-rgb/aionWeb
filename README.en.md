# AionWeb

[中文](README.md) | **English**

A GM admin for an Aion 2.7 private server. One Node.js process replaces several programs:

| Before | Now (this project) |
|---|---|
| NCsoft GMServer (.NET) + the old ASP.NET site | Dashboard, announcements and character lookup, talking to the CacheD admin port and the game database directly |
| A standalone GM command proxy script | "Packet Capture": built-in GM command proxy and packet logger |
| A command-line GM mail script | "Send Items": enchant level and manastone sockets, live delivery through CacheD |
| ShopAgent + an external billing platform (missing on private servers, so the shop was unusable) | Points service: balances, buying, gifting, cash-item mail delivery, redelivery after disconnects |
| Shop catalog service | Shop server + a visual goods editor |
| — | Its own database `AionShop`: points ledger, orders, catalog, admin log |

Everything speaks the servers' native protocols. **The main server, CacheD and the client are not modified.** The protocols were worked out by disassembling `Server64` / `CacheD64` (with the PDB symbols that ship with the server); see "Protocols" below.

> For study and research only. No game server or client files are included.

---

## Features

- **Dashboard**: process and port status of every service, character and account counts, recent logins.
- **Announcements**: screen center or chat window, filtered by race and class. Sent through the CacheD admin port and shown in game at once.
- **Characters**: character list, details, and the items in cube, warehouse and mailbox (enchant level, sockets).
- **Send Items**: search items by name or ID, set amount, enchant level and extra manastone sockets, add kinah, and send to one or more characters. Delivered live through CacheD by default, so online players get it right away. Enchant level and sockets are checked against each item's limits.
- **Packet Capture**: a built-in GM command proxy. The game client connects to the proxy port; the proxy rewrites chat lines starting with `//` into GM commands and forwards everything to the main server. The page shows the log live and can record full packets.
- **Cash Shop** (the in-game shop):
  - edit tabs and second-level categories visually; add, edit, copy, list and unlist goods; set the amount per pack (capped at the item's max stack), price, duration and description; fill the 6 ranking slots;
  - saving pushes the catalog to the game at once; reopen the shop in game to see it;
  - server-side checks: name length, price, stack limit, two-level categories, ranking slots and more.
- **Points**: balances per account, admin top-ups and deductions that refresh an online player's shop window live, the points ledger and shop orders (including gift recipients).
- **Buying and gifting**: the game's own flow end to end. After points are taken, the main server writes a cash-item mail through CacheD; the order completes when the main server confirms delivery; undelivered orders are resent automatically when the main server reconnects.
- **Admin Log**: every change made through the admin (logins, announcements, sent items, points, shop catalog, proxy start/stop …) is written to the database with its details; password fields are masked.
- **UI language**: switch between 中文 and English with "Language" at the top right; the choice is kept in the browser. In English, item names use the client's English names, and API messages and service logs switch too; data such as character names, goods names and announcement text stays as it is.

## Architecture

```
game client ──► (GM command proxy 7779) ──► main server Server64 ──► CacheD ──► game DB AionGame
                    ▲                         │    │                  ▲
                    │           shop catalog  │    │ points / buying  │ admin port 2007
                    │                  2300   ▼    ▼   2301           │
                ┌───┴──────────────── AionWeb (this project) ─────────┴──┐
                │  HTTP admin 8088 │ shop server │ points service │ GM proxy │
                └──────────────────────────┬─────────────────────────────┘
                                           ▼
                                  own database AionShop
```

- The admin only talks to the CacheD admin port and the databases; the old GMServer is not involved.
- The main server is the client: it connects to this project's shop server (catalog) and points service (balances, buying).
- The game database `AionGame` is read only, or written only through CacheD. The shop's and the admin's own data live in the separate `AionShop` database, so nothing is mixed into the game database.

## Requirements

- Windows (the server itself is Windows software), Node.js **22.18 or newer** (24 LTS recommended; it runs TypeScript directly, no build step).
- SQL Server (tested with 2022) running in a docker container in WSL. The sa password is read at runtime from the container's environment (`MSSQL_SA_PASSWORD` / `SA_PASSWORD`) and **never written to any file**.
- The Aion 2.7 server (Server64, CacheD64 …), not part of this repository.

## Setup

```bash
npm install
npm start
```

Or double-click `start_admin.bat`: the first run installs the dependencies and opens the browser.

1. The first start writes `config.json` with default values; adjust it using `config.example.json`:
   - `db.dockerContainer`: the docker container that runs SQL Server;
   - `cached`: the CacheD admin port;
   - `proxy` / `shop` / `shopAgent`: listen address and port of the three built-in services.
2. Open http://127.0.0.1:8088/ and set the admin password on the first visit (only a hash is stored, in `data/secrets.json`).
3. The admin listens on localhost only by default.

### The AionShop database

On start the `AionShop` database and all its tables are created (running it again is harmless), and `data/shop.json` is imported as the initial catalog when the database is empty.

`db/` contains:
- `AionShop_schema.sql`: the table definitions, exactly what the program runs at start, for reading;
- `AionShop.bak`: a **sanitized** sample backup (SQL Server 2022). Account names are blanked, account and character IDs renumbered, character names replaced with 「角色N」 ("character N"), and the admin log is empty. Restore it to see sample orders and ledger entries:

```sql
RESTORE DATABASE AionShop FROM DISK = '/var/opt/mssql/backup/AionShop.bak'
  WITH MOVE 'AionShop' TO '/var/opt/mssql/data/AionShop.mdf',
       MOVE 'AionShop_log' TO '/var/opt/mssql/data/AionShop_log.ldf';
```

### Server configuration

In `MainServer\common.xml`, right after `cacheServerPort`, add:

```xml
<shopServerAddr>127.0.0.1</shopServerAddr>
<shopServerPort>2300</shopServerPort>
<shopAgentServerAddr>127.0.0.1</shopAgentServerAddr>
<shopAgentServerPort>2301</shopAgentServerPort>
```

The main server reads these only at start. After that, when the admin restarts, the main server reconnects by itself; there is no need to restart the main server.

GM command proxy: the client connects to the proxy port (7779 by default) and the proxy forwards to the main server (7777). The proxy runs inside the admin process, so restarting the admin drops game connections that go through it.

### Item cache

`data/items_cache.json` caches item names, quality, stack size, sockets and so on, and ships with the repository. When the server or client data changes, regenerate it (needs Python 3):

```bash
py tools/build_items_cache.py --items <server items.xml> --zh <client Chinese strings folder> --en <client English strings folder>
```

The string folders are the `strings/*.xml` files (text XML) unpacked from the client paks. Restart the admin afterwards.

## Layout

| Path | What it is |
|---|---|
| `server/main.ts` | HTTP server, login, API routes, admin log, startup |
| `server/cached.ts` | CacheD admin port client (announcements, mail) |
| `server/game.ts` | Game database queries: characters, items, accounts, service status, sending items |
| `server/gmproxy.ts` | GM command proxy (client ↔ main server, rewrites chat commands) |
| `server/shopserver.ts` | Shop catalog service (peer of the main server's ShopClient) |
| `server/shopagent.ts` | Points service (peer of the main server's ShopAgentClient): balances, buying, delivery, redelivery |
| `server/shopdb.ts` | `AionShop` schema and data access for points, orders, catalog and admin log |
| `server/db.ts` | SQL Server connection pools (per database; the sa password comes from the container environment) |
| `server/items.ts` | Item data: names, quality, max stack, sockets, enchant limits |
| `server/config.ts` | Config loading (relative paths resolve against the project folder) |
| `server/i18n.ts` | Bilingual server messages: Chinese or English according to the `X-Lang` request header |
| `public/` | Front-end pages; the UI is based on the Majestic Admin template |
| `public/js/i18n.js` | English dictionary, keyed by the Chinese source text |
| `data/items_cache.json` | Item cache: server `items.xml` + the client's Chinese and English strings |
| `tools/build_items_cache.py` | Regenerates the item cache |
| `data/shop.json` | Initial catalog (imported when the database is empty) |
| `db/` | Schema SQL and the sanitized sample backup |

## Protocols

All of this was worked out by disassembling the servers and verified against the running game.

### CacheD admin port (2007)

```
request: u16 length (incl. itself) | u16 command | u8 0xBC | u16 ~command | payload
reply:   u16 length | u16 command | u8 0xBD | u16 ~command | u16 result (0 = OK)
```

- `GQ_ANNOUNCE (6)`: `u8 position ('M'/'C') | u8 type ('A'/'E') | UTF-16 text\0 | i32 race mask | i32 class mask`. A mask of −1 means everyone, 0 means nobody.
- `GQ_MAIL_SEND (34)`: live mail delivery; online players get it at once.

### Shop catalog service (main server → 2300)

```
main server → shop: u16 len | u8 type | 0xDC | u8 ~type | payload    0 handshake (u32 serverId)  1 request data (u32 seq)
shop → main server: u16 len | u8 type | 0xDD | u8 ~type | payload
  0 handshake result  1 update notice  2 begin update  3 goods  4 categories  5 goods-category  6 ranking  7 promotions  9 end update
  lists: u32 seq | i16 count | fixed-size struct × count
```

The **last packet of a list carries a negative count**; the main server only builds the category tree after it sees the negative count. Struct sizes: goods 0x248, category 0x78, goods-category 0x18, ranking 0x20, promotion 0x28.

### Points service (main server → 2301)

Both directions use `u16 total length | u16 type | payload`.

| type | Direction | Payload |
|---|---|---|
| 0x00 | main → points | protocol version (1, 0x1b, serverId) |
| 0x14 | main → points | ask for pending items; the reply lists undelivered orders and the main server resends them |
| 0x1a | main → points | balance query at account login; the reply is the balance |
| 0x0c | main → points | buy (buyer account, character, item, amount per pack, price, character name); the reply is the result and the warehouse ID |
| 0x17 | main → points | delivery confirmation (the cash-item mail has been written) |
| 0x1b | points → main | balance change notice; the player's shop window refreshes live |

On the wire a gift is the same as a purchase: the main server first looks up the recipient by name through CacheD, then sends the same buy request, and finally mails the item to the recipient.

## Database tables

| Table | Purpose |
|---|---|
| `account_point` | Points balance per account (constraint: never negative) |
| `point_ledger` | Points ledger, append-only |
| `shop_category` / `shop_goods` / `shop_goods_category` | Catalog (two-level categories, goods can be listed or unlisted) |
| `shop_ranking` / `shop_promotion` | Ranking (maintained by hand) / promotions |
| `shop_order` | Orders: the order number is the warehouse ID sent to the main server; a unique request key prevents double charges |
| `admin_log` | Admin log |
| `schema_meta` | Schema version, one-time import markers |

A purchase runs in one database transaction: duplicate check, balance lock, charge, order, ledger entry. Requests on one main-server connection are processed in arrival order.

## Credits

- UI template: [Majestic Admin](https://github.com/BootstrapDash/MajesticAdmin-Free-Bootstrap-Admin-Template) (MIT).
- The delivery warehouse table of NCsoft's original ShopAgent (buyer and recipient kept separately, an external request key against duplicates) was a useful reference.
