# furious-tp — 臺北開放資料 3D 數位孿生

臺北市全域可駕駛 3D 數位孿生:純臺灣開放資料(NLSC 3D Tiles 建物、內政部 20m DTM、data.taipei、OSM),桌機瀏覽器、公開免登入。PRD 與 RFC(架構決策 D1–D10)在 Linear 專案文件;工作流程遵循 yclaude-force(Linear team key: FTP)。

## Modules

- `web-client/` — TypeScript;CesiumJS + Rapier WASM(RFC D1/D8)。目前為 scaffold。
- `scene-pipeline/` — Python 離線場景編譯(尚未建立;RFC 模組 1)。
- `contracts/` — pipeline↔client 的 tile 格式契約(尚未建立;RFC D7)。merge = finalized,不在 CODEOWNERS 管轄。

## Commands (web-client)

```bash
cd web-client
npm run lint / typecheck / build / test
```

## Workflow rules (agents)

- Branch model:feature → `develop`(PR + 兩層 review)→ `test` 自動部署 → `main` 只在 human 明確指示時 merge。
- Branch 命名:`<type>/FTP-<n>-<slug>`;squash merge 標題 `FTP-<n>: <summary>`。
- PR body 用 `Refs FTP-<n>`,禁止 auto-close 關鍵字(ticket 由 Verifier 關,不由 merge 關)。
- 一張 PR 對一張 ticket;不在 ticket Scope 外改檔案。
- 治理檔(本檔、.github/workflows/、DESIGN.md、CODEOWNERS)只有 human 能 merge。

## Review trust model(兩層 review 的實際保證)

### 怎麼複核

本節每一句宣稱都必須通過下列檢查。這裡寫的是**性質**,不是快照數字:任一條的輸出變了,本節的結論就要重寫。指令刻意完全不含雙引號 —— PowerShell 會吃掉 native command 引數裡的裸雙引號,同一行指令在 bash 會過、在 PowerShell 會靜默解析成別的東西。

共用查詢(以下稱 `<Q>`,複製時整段替換):

```graphql
query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:100){totalCount nodes{number merged author{login} reviews(first:50,states:APPROVED){totalCount nodes{author{login}}}}}}}
```

**C0** 先確認這個查詢看得完 —— `first:100` 是硬上限:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -f query='<Q>' --jq '.data.repository.pullRequests.totalCount'
```

輸出若超過 100,C2–C4 的結論**不成立**,必須改成分頁查詢再讀一次。

**C1** repo 只有兩個 collaborator:

```bash
gh api repos/CLYEH/furious-tp/collaborators --jq '.[]|[.login,.role_name]|@tsv'
```

只該有 `CLYEH admin` 與 `yclawlobster write` 兩行。出現第三個帳號,「誰能滿足 review 要求」就變了,本節要重寫。

**C2** 史上核准過 PR 的帳號集合:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -f query='<Q>' --jq '[.data.repository.pullRequests.nodes[].reviews.nodes[].author.login]|unique'
```

應得 `["CLYEH"]`:每一次 Layer 2 核准都是 owner 帳號提交的。這條是本節整段論述的事實來源。

**C3** 有沒有 PR 被自己的作者核准:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -f query='<Q>' --jq '[.data.repository.pullRequests.nodes[]|select(.author.login as $a|[.reviews.nodes[].author.login]|index($a))|.number]'
```

應得 `[]`。但要知道這條**驗不到本節在講的風險**:bot 開的 PR 由 owner 帳號核准,在 GitHub 眼中就是兩個不同帳號,永遠會留在 `[]` 裡。它抓得到的只有最笨的那種違規。

**C4** 有沒有零核准就 merge 的 PR:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -f query='<Q>' --jq '[.data.repository.pullRequests.nodes[]|select(.merged and .reviews.totalCount==0)|.number]'
```

應得 `[]`。

**C5** branch protection 的實際設定:

```bash
gh api repos/CLYEH/furious-tp/branches/develop/protection
```

**這條需要 admin。** 本檔因此不複述它的數值 —— 以指令輸出為準。用 bot 憑證跑會得到 HTTP **404**(不是 403;GitHub 對權限不足的這個端點回 404),而那個 404 本身就是證據:**agent 連保護設定長什麼樣都讀不到,只能照著紀律走。**

## Language

Tickets、文件、面向 owner 的溝通:繁體中文(zh-TW)。程式碼與註解:英文。
