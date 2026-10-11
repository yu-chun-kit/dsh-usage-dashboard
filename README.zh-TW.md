# DSH Usage Dashboard

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一款非官方的 DeepSeek Harness（DSH）用量與額度儀表板，顯示於其官方右側邊欄中。

> **Preview 相容性：** 以 **DSH Preview `0.2.0-rc.2`** 與 Cordis `~4.0.4` 為目標。DSH 仍處於預發行（prerelease）階段；本實驗性社群外掛不承諾相容於其他預覽版本或未來的穩定版本。瀏覽器 UI 需要 DSH 0.2 的側邊欄 API。舊版傳輸回退機制無法讓該 UI 相容於 DSH 0.1。

## 功能特色

- 供應商餘額、額度與配額卡片，於開啟時或由使用者操作時重新整理；無背景輪詢，也不進行會產生計費的模型探測。
- 用量優先，憑證置於下方的可摺疊區段；行動裝置版面與適合觸控的控制項。
- 英文、簡體中文、繁體中文與日文 UI，遵循 DSH 語言設定，並以瀏覽器語言/英文作為回退。
- 取得、嘗試、憑證更新與手動重新整理的時間戳記。重新整理失敗會保留上一次成功的快照及其時間戳記。
- DSH Connection 驗證與 Host/Origin 檢查。憑證解析與供應商要求均在 DSH 伺服器上執行。

## 供應商支援

| 供應商 | 目前行為 |
| --- | --- |
| OpenRouter | 額度/用量轉接器；需要管理 API key |
| DeepSeek | 官方唯讀 `GET /user/balance`；餘額顯示 |
| Deepgram | 餘額轉接器；需要管理金鑰、`projectId` 與 `balanceId` |
| Tavily | 用量轉接器；`projectId` 為選用 |
| ChatGPT / Codex | 正規化由伺服器提供的用量來源；不自動登入或擷取 |
| OpenCode Go | 針對滾動、每週與每月視窗的實驗性唯讀用量轉接器 |
| Kilo、Serper、Brave | 實驗性/不受支援；新增憑證不會啟用取得功能 |

供應商 API 可能獨立於 DSH 而變更。離線測試資料驗證的是轉接器行為，而非即時帳戶或端點。

## 從原始碼安裝

請另行安裝 DSH Preview `0.2.0-rc.2`。需要 Node.js 20 或更新版本。這是 GitHub 原始碼發佈；該套件未發佈至 npm。

```sh
git clone https://github.com/yu-chun-kit/dsh-usage-dashboard.git
cd dsh-usage-dashboard
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-usage-dashboard
```

請將最後一個路徑替換為你複製（clone）該儲存庫後的絕對路徑，並將 `web` 替換為你的 DSH profile 名稱。重新啟動該 profile 的 DSH Web 程序，重新載入瀏覽器，然後從右側邊欄指南中選擇 **Usage dashboard**。可在啟動前使用 `dsh web --dump-config` 檢查組合後的設定。

## 憑證與隱私

請使用 DSH 憑證管理，或在其憑證儲存區可寫入時使用需驗證的儀表板。切勿將憑證放入 `cordis.patch.yml`、原始碼檔案、Git、截圖、問題回報或命令列引數中。

| 參照 | 供應商 |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `DEEPGRAM_API_KEY` | Deepgram |
| `TAVILY_API_KEY` | Tavily |
| `OPENCODE_GO_API_KEY` | OpenCode Go |

已知的 DSH Models API key 記錄（用於 OpenRouter、DeepSeek 與 OpenCode Go）也可在伺服器上重複使用。明確參照優先。OAuth 授權與任意記錄不會被解譯。

設定會傳回參照名稱、布林設定/寫入狀態、已知來源標籤與時間戳記。密鑰值與部分金鑰預覽絕不會傳回。密碼輸入欄位在成功儲存後會清空。寫入僅接受已宣告的參照，以及不含換行符號的 8–4096 個字元。

快照僅保留在記憶體中。DSH `dsh-usage-dashboard/activity` 記錄僅儲存允許的參照名稱、時間戳記與重新整理結果，不含金鑰或供應商快照。若無記錄 API，活動僅保留在記憶體中，重新啟動後即消失。較早的事件、外部環境變更與原始工作階段簽發日期均無法重建。

公開錯誤使用固定訊息。日誌不包含憑證、供應商回應主體與原始例外文字。作業系統暫存目錄中的盡力而為日誌 `dsh-usage-dashboard-boot.log` 僅記錄路由名稱與註冊結果；該檔案可刪除。

已通過驗證的使用者可以看到帳戶用量與餘額；分享截圖時請將這些數字視為私密資訊。儲存庫測試資料包含合成資料。憑證、環境檔案、日誌與本機開發筆記已排除於公開原始碼快照之外。僅靠忽略規則無法移除已提交至 Git 歷史中的檔案。

## 傳輸與邊界

`/api/usage-dashboard/{snapshot,settings,settings-write,credential}` 下的精確路由會重用 Connection 的瀏覽器工作階段與受信任主機圍籬。若無 Connection，路由輔助函式僅允許回環要求。啟用時會等待 `webServer`、`connection` 與 `credentials`。行動裝置與桌面端使用相同的需驗證同源 API。

舊版 `/usage-dashboard` RPC 僅為沒有現代圍籬的舊版 Connection 轉接器保留。DSH 0.2 使用需驗證的精確路由。本外掛不會變更 Harness 的 agent 迴圈，也不會授予命令/工作區權限。

## 開發與驗證

```sh
npm ci
npm test
npm run check
```

測試使用假憑證與離線的供應商/瀏覽器測試資料。無需真實金鑰、模型要求或外部 MCP 伺服器。除非提供模組根目錄，否則選用的已安裝 DSH 契約檢查會被略過：

```sh
DSH_TEST_MODULE_ROOT=/absolute/path/to/dsh/node_modules node --test test/dsh-contract.test.mjs
```

該檢查使用已安裝的服務與測試資料憑證，並禁止供應商流量；它不會載入即時 profile。相容性以本機已驗證的 `0.2.0-rc.2` 安裝為目標，而非未來的版本。

編輯 `locales/{en,zh-Hans,zh-Hant,ja}.json` 與 `src/client/i18n.ts`，然後建置。建置過程會驗證鍵/參數，並同步產生的字典與瀏覽器在地化程式碼。請勿直接編輯產生的在地化區段。其他 DSH UI 翻譯屬於其各自的語言套件。

## 授權條款

[MIT](LICENSE)。本專案為社群專案，並非 DeepSeek 官方發佈。
