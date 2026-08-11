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

**作者/審查者的分離目前由 agent 紀律維持,不由存取控制維持。** 這是 owner 看過權衡後明確接受的取捨(FTP-63),不是疏漏。之所以寫進本檔而不是別處:執行這個保證的就是讀本檔的 agent —— 而一個被明文記錄的取捨,跟一個沒人講出來的取捨,安全性差很多。

### 機制擋得住的

- 治理檔(本檔、`DESIGN.md`、`.github/`、`.github/CODEOWNERS`)的 code owner 是 `@CLYEH`,且 GitHub 真的會據此自動指派(C6)。這些路徑的 review 要求**只有 owner 帳號能滿足**,agent 帳號不行。這條是機制,不是紀律。
- `develop` / `main` 有 branch protection:要求 code-owner review、要求 approving review、無 bypass 名單、admin 一併受限(`enforce_admins`)。設定本身是嚴的 —— 這幾項由 Layer 2 以 admin 憑證實測(FTP-62 / FTP-63),agent 憑證複核不到,以 C5 的輸出為準。
- 沒有第二套規則:repository rulesets 是空的(C7),所以 branch protection 就是全部,不存在另一份帶 bypass 名單的規則在旁邊。
- repo 只有兩個 collaborator(C1)。

### 機制擋不住的

問題不在設定,在憑證。Layer 2 簽核者是 `CLYEH`,**而那把憑證就是 owner 自己的 `gh` OAuth token,跟 agent 取用 `githubTokens.author` 的是同一份本機設定檔**。所以:

- 能滿足 approving-review 要求的帳號只有 `CLYEH` 與 bot 兩個(C1),**而 `CLYEH` 那把憑證 agent 摸得到**。要求的數字是 1 還是更多,都不改變這個結論。
- GitHub 的「不能核准自己的 PR」是以**帳號**為單位,不是以**行為者**為單位。bot 開 PR、再以 owner 帳號 approve,GitHub 看到的是兩個不同帳號:規則通過,不會回 422。C3 因此永遠是 `[]` —— **那個 `[]` 不代表分離成立**,只代表沒人笨到用同一個帳號兩邊都做。
- 於是 **approve 這一步**,非治理檔的 PR 沒有任何機制阻止 agent 自行放行。治理檔擋得住,靠的是 code owner 那一條(C6),不是靠兩層 review。

而 **merge 那一步比 approve 更寬:所有路徑都沒有機制。**

- branch protection 的 `restrictions` 是 `null`(Layer 2 以 admin 憑證實測),而 bot 具 write(C1,不需 admin 即可複核)。所以治理檔 PR 一旦拿到 code-owner 核准,**bot 帳號按得下那個 merge** —— approve 那一步治理檔擋得住,merge 那一步治理檔也擋不住。
- 這**不是未授權的暴露,是被記錄下來的授權**:owner 已明確授權 agent 自行 merge 自己的 PR。治理檔則照上面〈Workflow rules〉那條走 owner。兩者都是**授權範圍**,不是存取控制。
- 因此本檔上面那句「治理檔…只有 human 能 merge」**同樣是紀律,不是機制**。這一節的工作就是替本檔的宣稱分類,那一條不能自己豁免。
- 附帶:`mergedBy` 記錄的是**哪把憑證按的**,不是**誰做的決定**。拿它當 human-in-the-loop 的證據會讀錯 —— 這也是為什麼 agent 代按的 merge 該用 bot 憑證,而不是借 owner 帳號留下一個假訊號。
- 附帶,同源的第二個缺口(FTP-62 round 2):簽核者身分同時是 repo owner,@-mention 通知不到人;而提交一次 CHANGES_REQUESTED 會消耗掉 pending 的 review request。兩者疊加 —— **每一輪 review 之後簽核者都不會被通知**,「有人在看」這件事本身也是靠紀律撐著。

### 因此

> **任何「agent 不能自己放行 X」的宣稱,對非治理檔而言,實際保證是紀律而非機制。**

唯一在執行這條線的,是 worker playbook 的那一句:「reviewer token 對你不存在;若你找到了,那是要用 `[escalate]` 回報的事件,不是一項能力。」**沒有第二道。這不是防禦縱深,是單點。**

Agent 的操作結論:

- 取用憑證時只讀你被指名的那一個 leaf。同一份設定檔裡就有 `githubTokens.reviewer` —— **不讀、不用、不印**。
- 發現自己有能力放行本該由他人放行的東西,那是 `[escalate]` 事件,不是一項能力。
- 憑證、branch protection、collaborator 設定一律 human-only。

### 怎麼複核

本節每一句宣稱都必須通過下列檢查。這裡寫的是**性質**,不是快照數字:任一條的輸出變了,本節的結論就要重寫。指令刻意完全不含雙引號 —— PowerShell 會吃掉 native command 引數裡的裸雙引號,同一行指令在 bash 會過、在 PowerShell 會靜默解析成別的東西。

共用查詢(以下稱 `<Q>`,複製時整段替換):

```graphql
query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:100){totalCount nodes{number merged author{login} reviews(first:50,states:APPROVED){totalCount nodes{author{login}}}}}}}
```

**C0** 先確認這個查詢看得完 —— `first:100` 與 `first:50` 都是硬上限:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -f query='<Q>' --jq '[.data.repository.pullRequests.totalCount,([.data.repository.pullRequests.nodes[].reviews.totalCount]|max)]|@tsv'
```

兩個數字:PR 總數、單一 PR 的最多核准數。前者超過 100 或後者超過 50,C2–C4 的結論**不成立**,必須改成分頁查詢再讀一次。**截斷不會報錯,只會讓下面三條安靜地少看幾筆** —— 所以先跑這條。

**C1** repo 只有兩個 collaborator:

```bash
gh api repos/CLYEH/furious-tp/collaborators --jq '.[]|[.login,.role_name]|@tsv'
```

只該有 `CLYEH admin` 與 `yclawlobster write` 兩行。出現第三個帳號,「誰能滿足 review 要求」就變了,本節要重寫。這條之所以承重,是因為 repo 是 **public**:**任何 GitHub 使用者都能*提交* review,只有 write 以上能*滿足* review 要求。** 名單短不等於沒人看得到,是等於沒幾個人按得動。

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

**這條需要 admin。** 本檔因此不複述它的數值(必要檢查清單、review 數量)—— 以指令輸出為準。**非 admin 憑證讀不到**(實測:bot 憑證 404、未認證 401)。**承重的是「讀不到」,不是特定狀態碼** —— 拿到 403 或別的碼不代表文件錯了,只有拿到 200 才代表這一節要重寫。agent 連保護設定長什麼樣都讀不到,只能照著紀律走。

**C5b** 同一件事有一個粗粒度版本,**不需要 admin**:

```bash
gh api --paginate repos/CLYEH/furious-tp/branches --jq '.[]|[.name,(.protected|tostring)]|@tsv'
```

(`--paginate` 不能省:預設每頁 30,branch 一多,那三行會**整行消失**而不是變 `false` —— 一個看起來不像失敗的失敗。)

`develop`、`main`、`test` 三條都應為 `true`(`test` 會自動部署,所以它一起算)。這條的界線要講清楚:**agent 查得出保護被整個關掉,查不出保護被改鬆。** 要看鬆緊只能靠 C5,而 C5 要 admin。

**C6** code-owner 要求不只是寫在檔案裡,而是真的會生效。對一個動到治理檔的 PR:

```bash
gh api graphql -F owner=CLYEH -F name=furious-tp -F num=<n> -f query='query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){reviewRequests(first:10){nodes{asCodeOwner requestedReviewer{... on User{login}}}}}}}'
```

應得 `{asCodeOwner: true, requestedReviewer: {login: CLYEH}}`。

**承重的是 `asCodeOwner`,不是那個 `CLYEH`。** 手動送出的 review request 同樣會讓 `CLYEH` 出現,但 `asCodeOwner` 是 `false` —— 這個欄位是唯一能分辨「CODEOWNERS 自動指派」與「有人手動點的」的東西。REST 的 `requested_reviewers` **沒有**任何出處欄位(整包只有 `teams` / `users`,`users[]` 全是一般 user 欄位),所以拿 REST 查這件事,一條手動 request 就會讓它照樣印出 `CLYEH` 而通過 —— 那是**用紀律守一條本該由機制守的宣稱**,正是本節在講的病。

限制寫在這裡:**review request 一旦被簽核者提交 review 就會被消耗**,`reviewRequests` 隨即變 `[]`。所以這條只在 pending 期間查得到,不是「在手動指定之前」——**時機是機制決定的,不是紀律決定的。**

**C7** 沒有第二套規則在 branch protection 旁邊:

```bash
gh api repos/CLYEH/furious-tp/rulesets
gh api repos/CLYEH/furious-tp/rules/branches/develop
```

兩者都應為 `[]`。這兩條**不需要 admin**,agent 自己就能複核 —— 與 C5 的 404 對照:rulesets 讀得到,branch protection 讀不到。

## Language

Tickets、文件、面向 owner 的溝通:繁體中文(zh-TW)。程式碼與註解:英文。
