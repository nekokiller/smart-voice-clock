# 智慧語音報時

在 24 小時開機的 Mac mini 上常駐，**每到整點隨機挑一種語音、一段文字報時**。
後端 Node.js（零外部相依）負責排程與發聲，網頁只是控制面板，區網任何裝置都能開。

- 語音：優先使用本機 **CosyVoice3** 服務（`127.0.0.1:8765`，多種音色）；失敗或離線自動改用 **macOS `say`**。
- 預先合成：每小時 xx:55 先合成好下一個整點的語音，整點直接播放，不受 ~10 秒合成時間影響。
- 靜音時段：預設 **01:00–05:00** 不報時（5:00 會報）。
- 文案：`data/phrases.json`，依時段分類（共 74 句），也可在面板新增自訂文案。

詳細設計見 [docs/development-plan.md](docs/development-plan.md)。

## 快速開始

```bash
cp .env.example .env      # 若已存在 .env 則直接編輯
# 編輯 .env，填入 PANEL_PASSWORD=你的密碼
npm start                 # 預設 http://<本機IP>:8780
npm test                  # 跑單元與整合測試
```

登入時帳號任意，密碼為 `.env` 的 `PANEL_PASSWORD`。**未設定密碼時程式拒絕啟動。**

## 設為常駐服務（開機自動啟動）

```bash
scripts/install-service.sh      # 安裝並啟動 LaunchAgent
scripts/uninstall-service.sh    # 移除
```

- 日誌：`~/Library/Logs/voiceclock/`
- 需要 Mac mini 設定為「自動登入」，且關閉自動睡眠，LaunchAgent 才能使用音訊輸出。
- 改了 `.env` 後重新執行 `install-service.sh` 即可重啟套用。

## 環境變數（`.env`）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PANEL_PASSWORD` | （必填） | 控制面板密碼 |
| `PORT` | `8780` | 面板埠 |
| `HOST` | `0.0.0.0` | 綁定位址（僅本機用 `127.0.0.1`） |
| `COSYVOICE_URL` | `http://127.0.0.1:8765` | CosyVoice 服務位址 |
| `COSYVOICE_VOICES_DIR` | `/Volumes/AcasisRaid2TB/CosyVoice3/audios_pt` | 音色檔目錄（用來列出音色） |

## 控制面板

- **概覽**：下次報時倒數、立即報時。
- **設定**：開關、引擎、靜音時段、啟用的音色、自訂文案。
- **測試中心**：T1 系統自檢、T2 單一音色試聽、T3 全部音色巡聽、T4 隨機抽選預覽、T5/T6 完整流程演練與備援驗證、T7 靜音判斷、T8 排程判斷、T9 文案檢查、T10 即時日誌。測試不影響正式排程。
- **歷史**：最近 100 筆報時紀錄（✅ 播報／⚠️ 備援／🌙 靜音略過／❌ 失敗）。

## 安全

面板對區網開放，因此：一律需密碼（Basic Auth）、失敗次數與操作頻率有限制、請求大小與文字長度有上限、拒絕跨來源的寫入請求。**請勿對外網開放**；需要遠端存取時建議使用 Tailscale 等 VPN。
連線是 HTTP（區網明文），密碼請不要與其他服務共用。

## 目錄

```
server.js          入口
src/               排程、報時核心、引擎、API
public/            控制面板（無建置）
data/phrases.json  文案庫
data/              config.json / state.json / history.json 於執行時產生（不進版控）
tests/             node --test
scripts/、launchd/ 常駐服務安裝
```
