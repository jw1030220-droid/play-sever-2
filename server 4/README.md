# 惡搞棋院 — 帳號伺服器 (beta1.0)

玩家用 Google 登入 → 伺服器**真的驗證**憑證 → 自動註冊建帳號 → 每次登入都留下紀錄。
金幣、元寶、技能都存在伺服器上，換手機、重灌都還在。

---

## 一、這包東西做了什麼

| 檔案 | 用途 |
|---|---|
| `server.js` | API 路由 + Socket.io 連線 |
| `db.js` | 帳號資料庫（JSON 檔，無外部相依） |
| `auth.js` | 用 Google 公鑰**真正驗證** ID Token |
| `game/index.html` | **遊戲本體**，掛在網站根目錄 `/` |
| `public/index.html` | 管理後台，掛在 `/admin` |

### 資料表

- **accounts** — 帳號本體。用 `googleSub`（Google 給的永久 ID）認人，**不是用 email**，所以玩家改 Gmail 地址也還是同一個帳號
- **sessions** — 登入憑證，32 bytes 隨機 token，30 天到期
- **loginRecords** — 每次登入的時間、IP、裝置、方式，最多保留 5000 筆
- **games** — 對局紀錄

---

## 二、必要設定（環境變數）

| 變數 | 必填 | 說明 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 是 | **必須和前端 App 裡填的那組一模一樣**，不然驗證一定失敗 |
| `ADMIN_PASSWORD` | 是 | 管理後台密碼，請設長一點 |
| `DB_PATH` | 否 | 資料庫檔位置，預設 `./data.json` |
| `PORT` | 否 | 預設 3000 |

---

## 二點五、零設定部署（推薦）

`game/index.html` 就是遊戲本體，伺服器啟動後會直接把它掛在網站根目錄。

部署完之後：

| 網址 | 內容 |
|---|---|
| `https://你的網址/` | **遊戲**（玩家直接開這個） |
| `https://你的網址/admin/` | 管理後台 |
| `https://你的網址/api/config` | 前端自動抓 Client ID 用的 |

這樣做的好處是**玩家和你都不用填任何設定**：

- 遊戲和 API 同一個網域 → 前端自動用 `location.origin` 當伺服器位置
- 前端開機時打 `/api/config` → 自動拿到你設在環境變數的 `GOOGLE_CLIENT_ID`
- 玩家打開網址 → 直接看到 Google 登入按鈕 → 按下去就能玩

Google Cloud Console 的「已授權的 JavaScript 來源」只要填這一個網址就好。

> 如果你想把遊戲放 Netlify、伺服器放 Render（分開部署），那前端就抓不到同網域的 API，
> 需要到遊戲的登入畫面 →「⚙ 進階設定」→ 填伺服器網址。能動，但比較麻煩。

---

## 三、本機跑起來

```bash
cd server
npm install
GOOGLE_CLIENT_ID=你的.apps.googleusercontent.com \
ADMIN_PASSWORD=改成你自己的密碼 \
npm start
```

- 遊戲 API：`http://localhost:3000`
- 管理後台：`http://localhost:3000`（用 `ADMIN_PASSWORD` 登入）

然後在 App 的登入畫面點「設定伺服器網址」，填 `http://localhost:3000`。

---

## 四、部署到 Render

1. 把 `server/` 推到 GitHub
2. Render → New → Web Service → 選這個 repo
3. Build Command: `npm install`／Start Command: `npm start`
4. Environment 加上 `GOOGLE_CLIENT_ID` 和 `ADMIN_PASSWORD`
5. 部署完拿到網址（像 `https://xxx.onrender.com`），填進 App 的「設定伺服器網址」
6. **把這個網址加進 Google Cloud Console 的「已授權的 JavaScript 來源」**

### 免費方案的兩個坑

- **檔案系統是暫存的**：`data.json` 在每次重新部署或重啟後會**被清空**，玩家帳號全沒。要正式營運必須：
  - 掛一顆 Render Disk，把 `DB_PATH` 指過去，或
  - 改用 Postgres（`db.js` 的介面很單純，要換不難）
- **會睡著**：閒置後第一個請求要等 ~30 秒喚醒

---

## 五、API

### 玩家端

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/google` | 送 `{credential}`，驗證後回傳 `{token, account, isNew}`，`isNew=true` 代表是新註冊 |
| GET | `/api/me` | 帶 `Authorization: Bearer <token>`，取回自己的帳號 |
| POST | `/api/progress` | 存進度（金幣/元寶/技能） |
| POST | `/api/logout` | 讓目前的 session 失效 |
| GET | `/api/config` | 回傳 `{googleClientId}`，前端自動設定用（Client ID 本來就是公開資訊） |

### 管理端（需 `x-admin-password` 標頭）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/stats` | 全站統計 |
| GET | `/api/admin/accounts` | 所有帳號 |
| GET | `/api/admin/accounts/:id` | 單一帳號 + 登入紀錄 + session |
| POST | `/api/admin/accounts/:id/currency` | 手動發幣 |
| POST | `/api/admin/accounts/:id/ban` | 封鎖／解封（會踢掉所有 session） |
| POST | `/api/admin/accounts/:id/kick` | 踢掉所有 session |
| GET | `/api/admin/logins` | 全站登入紀錄 |
| GET | `/api/admin/games` | 對局紀錄 |

---

## 六、必須知道的安全限制

**進度目前是「相信客戶端」的。** `/api/progress` 收到什麼就存什麼（只有做型別和範圍驗證，擋掉負數和垃圾資料）。有心人可以自己發請求把金幣改成 999999。

要真正防作弊，必須把遊戲規則搬到伺服器端驗證——也就是伺服器自己算「這場你贏了，所以給你 40 金幣」，而不是聽客戶端說「我贏了給我 40」。這是個大工程，目前這版沒做。

**登入本身是安全的**：`auth.js` 用 `google-auth-library` 向 Google 驗證簽章、發行者、有效期限和 audience，偽造不了。

---

## 七、還沒做完的

- 2v2 只有房間配對，同隊輪流出手的邏輯沒寫
- 進度沒有伺服器端規則驗證（見上）
- 沒有排行榜 API
