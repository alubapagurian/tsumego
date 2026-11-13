# 詰棋練習

在 iPad 上練習圍棋死活題的網頁。題目顯示在 19 路棋盤左下角的 13×8 範圍，支援自動應答／自由擺子、手動製題、JSON 匯入匯出，並可透過 Cloudflare D1 在多台裝置間同步題庫與作答紀錄。

## 檔案結構

```
public/index.html            網頁本體（單一檔案）
functions/api/[[path]].js    同步 API（Cloudflare Pages Functions）
samples/quiz.json            範例題庫（可在「題庫 → 匯入」使用）
```

- 資料表會在第一次呼叫 API 時自動建立，不需要手動執行 SQL。
- 直接用瀏覽器開 `public/index.html`，或放在沒有 API 的主機（例如 GitHub Pages）上也能用，只是資料只存在本機（右上角不會出現同步狀態）。

## 部署到 Cloudflare（免費方案）

> Cloudflare 後台的選單名稱偶爾會調整，若找不到可用搜尋框找關鍵字。

### 1. 建立 Pages 專案並連結 GitHub
1. Cloudflare 後台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 選擇 `alubapagurian/tsumego`。
3. 建置設定：
   - Framework preset：**None**
   - Build command：（留空）
   - Build output directory：`public`
4. 部署完成後會得到網址，例如 `https://tsumego.pages.dev`。之後每次 push 到 GitHub 都會自動重新部署。

### 2. 建立 D1 資料庫並綁定
1. 後台 → **Storage & Databases** → **D1** → **Create**，名稱填 `tsumego`。
2. 回到 Pages 專案 → **Settings** → **Bindings** → **Add** → **D1 database**：
   - Variable name：`DB`
   - D1 database：`tsumego`

### 3. 用 Cloudflare Access 保護網站（只有你能登入）
沒有這一步，API 會拒絕所有同步請求（網頁仍可在本機使用）。

1. 後台 → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**。
2. Application domain 填 `tsumego.pages.dev`（換成你的實際網址）。想保護預覽版本，可再加一筆 `*.tsumego.pages.dev`。
3. Session duration 建議設長一點（例如 1 個月），iPad 上就不用常常重新登入。
4. Policy：Action 選 **Allow**，Include → **Emails** → 填你的 email。登入方式用預設的 **One-time PIN**（寄驗證碼到信箱）即可。
5. 儲存後，在這個應用程式的設定頁複製 **Application Audience (AUD) Tag**。
6. 在 Zero Trust → **Settings** 找到你的 team domain，格式是 `https://<團隊名稱>.cloudflareaccess.com`。

### 4. 設定環境變數
Pages 專案 → **Settings** → **Variables and Secrets**（Production）新增：

| 名稱 | 值 |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `https://<團隊名稱>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | 上一步複製的 AUD Tag |

### 5. 重新部署
綁定和變數只會套用到新的部署：Pages 專案 → **Deployments** → 最新一筆 → **Retry deployment**（或 push 任何變更）。

### 6. 在 iPad 上使用
1. 用 Safari 開網站，輸入 email 收驗證碼登入。
2. 左上角出現綠點「已同步」就完成了。
3. 分享 → **加入主畫面**。

同步狀態說明：

| 顯示 | 意思 |
|---|---|
| 已同步 | 本機和雲端一致 |
| 同步中… | 正在上傳／下載 |
| 離線・稍後同步 | 沒有網路；變更已存在本機，連線後自動上傳 |
| 需要登入 | Access 登入過期，點一下會重新整理頁面登入。若從主畫面圖示開啟一直登入失敗，改用 Safari 開啟登入一次即可 |
| 伺服器未設定 | 還沒完成第 3、4 步 |

## 同步規則
- 每一題獨立同步，以最後修改時間較新的一方為準。
- 刪除的題目會留下刪除標記，其他裝置同步時也會刪掉。
- 新裝置第一次開啟時，會直接採用雲端題庫。

## 免費額度
D1 免費方案每天 500 萬次讀取列、10 萬次寫入列；Workers / Pages Functions 每天 10 萬次請求；靜態網頁請求不計費。個人練習的用量遠低於這些上限。超過上限時同步會暫停到隔天（UTC 午夜），不會自動收費。
