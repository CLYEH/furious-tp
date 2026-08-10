# Test 環境

| 項目 | 值 |
|---|---|
| URL | <https://clyeh.github.io/furious-tp/> |
| 平台 | GitHub Pages(build_type=workflow) |
| 觸發 | push to `test`(由 `develop` merge 後同步) |
| Workflow | `.github/workflows/test-deploy.yml`(build → deploy → Playwright smoke) |

## 部署流程

1. PR merge 進 `develop` 後,merge 的 agent 將 `develop` 推進 `test`(`git push origin develop:test`)。
2. `test-deploy` workflow:build `web-client` → 組裝 `site/`(public + dist)→ deploy Pages → smoke。
3. Smoke 失敗即代表 test 環境壞掉:先看 run log,常見原因是 Pages CDN 尚未傳播(workflow 已設 `retries: 1`)。

## 前置條件(bootstrap 已配置,重建 repo 時需重做)

- Pages 啟用為 workflow build。
- `github-pages` environment 的 deployment-branch-policies 含 `test`。

## 本機對 test 環境跑 e2e

```bash
cd web-client
npm run e2e            # 預設打上表 URL
TEST_URL=... npm run e2e   # 打其他部署
```
