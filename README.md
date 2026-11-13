# 詰棋練習

在 iPad 上練習圍棋死活題的網頁。題目顯示在 19 路棋盤左下角的 13×8 範圍，支援自動應答／自由擺子、手動製題、JSON 匯入匯出，並可透過 Cloudflare D1 在多台裝置間同步題庫與作答紀錄。

## 檔案結構

```
public/index.html     網頁本體（單一檔案）
src/worker.js         同步 API（Cloudflare Worker）
wrangler.jsonc        Worker 設定：網頁資料夾、D1 資料庫綁定
samples/quiz.json     範例題庫（可在「題庫 → 匯入」使用）
```

- 資料表會在第一次呼叫 API 時自動建立，不需要手動執行 SQL。
- 直接用瀏覽器開 `public/index.html`，或放在沒有 API 的主機（例如 GitHub Pages）上也能用，只是資料只存在本機（左上角不會出現同步狀態）。

## 部署到 Cloudflare Workers（免費方案）

> Cloudflare 後台的選單名稱偶爾會調整，若找不到可用搜尋框找關鍵字。

### 1. 建立 D1 資料庫，把 ID 填進 wrangler.jsonc
1. 後台 → **Storage & Databases** → **D1** → **Create**，名稱填 `tsumego`（已建立過就不用再建）。
2. 打開這個資料庫，複製頁面上的 **Database ID**（一串像 `xxxxxxxx-xxxx-...` 的文字）。
3. 在 GitHub 上編輯 `wrangler.jsonc`，把 `"請貼上你的-database-id"` 換成剛才的 ID，然後 commit。

### 2. 確認 Worker 名稱
`wrangler.jsonc` 裡的 `"name"` 必須和 Cloudflare 後台的 Worker 名稱**完全相同**（目前寫的是 `tsumego`）。如果你的 Worker 叫別的名字，就把這裡改成一樣。

### 3. 連結 GitHub（已連結可跳過）
後台 → **Workers & Pages** → 你的 Worker → **Settings** → **Build** → 連結 `alubapagurian/tsumego`。
- Build command：（留空）
- Deploy command：`npx wrangler deploy`

之後每次 push 到 GitHub 都會自動重新部署。網頁會在 `https://tsumego.<你的帳號>.workers.dev`。

### 4. 設定同步密碼
部署成功、Worker 有程式之後，才能新增變數。

1. 準備一組**至少 12 個字元**、不容易猜到的密碼，例如用密碼管理工具產生。
2. Worker → **Settings** → **Variables and Secrets** → **Add**：
   - Type：**Secret**（存好後連你自己在後台也看不到內容，請另外記下來）
   - Variable name：`SYNC_PASSWORD`
   - Value：剛才的密碼
3. 儲存後會自動套用，不需要重新部署。Secret 不會被之後的 push 覆蓋。

### 5. 在 iPad 上使用
1. 用 Safari 開網站，會跳出「雲端同步密碼」視窗，輸入密碼後按「連線」。
2. 左上角出現綠點「已同步」就完成了。每台裝置只需要輸入一次。
3. 分享 → **加入主畫面**。

> 密碼存在該裝置的瀏覽器裡。不要在別人的裝置上輸入；若曾經在公用裝置上輸入，可點左上角同步狀態 →「清除密碼」，並到 Cloudflare 更換 `SYNC_PASSWORD`。

同步狀態說明：

| 顯示 | 意思 |
|---|---|
| 已同步 | 本機和雲端一致 |
| 同步中… | 正在上傳／下載 |
| 離線・稍後同步 | 沒有網路；變更已存在本機，連線後自動上傳 |
| 輸入同步密碼 | 還沒輸入密碼，或密碼不正確（例如後台換過密碼），點一下重新輸入 |
| 伺服器未設定 | 還沒完成第 4 步，或密碼少於 12 個字元 |

## 同步規則
- 每一題獨立同步，以最後修改時間較新的一方為準。
- 刪除的題目會留下刪除標記，其他裝置同步時也會刪掉。
- 新裝置第一次開啟時，會直接採用雲端題庫。

## 免費額度
D1 免費方案每天 500 萬次讀取列、10 萬次寫入列；Workers 每天 10 萬次請求（只有 `/api/*` 會計入）；靜態網頁請求不計費。個人練習的用量遠低於這些上限。超過上限時同步會暫停到隔天（UTC 午夜），不會自動收費。
