# furious-tp — 臺北開放資料 3D 數位孿生

臺北市全域可駕駛 3D 數位孿生:純臺灣開放資料(NLSC 3D Tiles、內政部 20m DTM、data.taipei、OSM),桌機瀏覽器、公開免登入。

- 需求與架構:Linear 專案「臺北開放資料 3D 數位孿生城市」(PRD / RFC 文件)
- 工作流程:yclaude-force(branch model 與協定見 `CLAUDE.md`)
- **Test 環境**:https://clyeh.github.io/furious-tp/ (`test` 分支 push 自動部署 + Playwright smoke)

## Develop

```bash
cd web-client
npm ci
npm run lint && npm run typecheck && npm run build && npm run test
npm run e2e   # against the deployed test environment (TEST_URL to override)
```
