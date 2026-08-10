# Secrets skeleton(Milestone 0)

結構與命名慣例。**值一律不進 repo** — 由 human 放置。

## 存放位置

| 用途 | 位置 |
|---|---|
| CI | GitHub Actions repository secrets |
| 本機開發 | `.env`(已在 .gitignore;樣板見 `.env.example`) |
| 部署 | 部署平台的環境變數(M0 e2e ticket 定案平台後補) |

## 命名慣例

`FTP_<SCOPE>_<NAME>`,全大寫底線分隔。例:

- `FTP_DEPLOY_TOKEN` — test 環境部署權杖(e2e harness ticket 啟用時建立)
- `FTP_CDN_*` — 發布用 object storage/CDN 憑證(M4 前不需要)

## 現況

第一版資料來源全為公開服務(NLSC/DTM/data.taipei/OSM),**目前沒有任何必要 secret**。本檔案先定結構;新增 secret 時必須同步更新此清單與 `.env.example`。
