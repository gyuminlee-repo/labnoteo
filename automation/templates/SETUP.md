# 연구노트 자동화 설정 가이드 (관리자/개발자용)

> **이 문서는 저장소를 처음 설정하는 관리자·개발자용입니다.**
> 실험하는 연구원의 일상 사용법은 **`QUICKSTART.md`** 를 보세요.

이 문서와 함께 설치된 파일들은 labnoteo 플러그인의 **"Setup research automation"**
명령이 현재 보관함(vault)에 프로비저닝한 것입니다.

## 최초 설정 체크리스트 (한 번만)

**전제** — 커뮤니티 플러그인 설치와 *연구노트 자동화 설정* 실행은 이미 끝난 상태입니다
(그래서 이 문서가 보관함에 있습니다). **git 설치와 빈 private 저장소 개설**을 포함한
보관함 생성부터 Copilot 설정까지의 전체 순서는 저장소의
[설치 가이드](https://github.com/sblabkribb/labnoteo/blob/main/docs/INSTALL.md)를
보세요(아래 ①은 그 저장소가 준비됐다는 전제).

순서대로 진행하세요. 특히 **push보다 훅 활성화가 먼저**입니다 — 훅 없이 첫 커밋을 만들면
대용량 파일이 Git 이력에 박히고, 그 뒤에는 history rewrite 말고 되돌릴 방법이 없습니다(⑤ 참고).

- [ ] **① 비공개(PRIVATE) GitHub 저장소 확인** — 연구 정보 보호의 전제입니다.
      공개 저장소는 fork PR을 통한 워크플로우 악용 위험도 있습니다.
- [ ] **② pre-commit 훅 활성화** — 보관함 루트에서 한 번 실행:

  ```sh
  git config core.hooksPath .labnoteo/hooks
  ```

  macOS/Linux에서는 실행 권한도 한 번 부여하세요(Windows는 불필요):

  ```sh
  chmod +x .labnoteo/hooks/pre-commit
  ```

- [ ] **③ GitHub로 push** — 보관함이 GitHub 저장소여야 Actions(검증/이슈/Wiki)가 동작합니다.
- [ ] **④ (Wiki 사용 시) Wiki 초기화 + 토큰** — GitHub Wiki는 별도 저장소입니다.
      저장소 Wiki 탭에서 첫 페이지를 한 번 만들어 초기화하고, 기본 `GITHUB_TOKEN`으로
      Wiki push가 안 되는 구성이라면 Wiki push 권한이 있는 PAT를 시크릿
      `GH_WIKI_TOKEN`에 설정하세요(관리자가 직접 생성).
- [ ] **⑤ (선택·고급) 기존 Git 이력 대용량 감사** — pre-commit 훅은 **이미 커밋된**
      대용량 파일은 막지 못합니다. 오래된 보관함이라면 확인하세요:

  ```sh
  git rev-list --objects --all \
    | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
    | awk '/^blob/ {print $3, $4}' | sort -nr | head -20
  ```

  큰 파일이 이미 있으면 history rewrite(`git filter-repo` 등) 또는 저장소 이전 여부를
  사람이 판단합니다.

**참고 사항**

- **`.obsidian` ignore 정책**: 전체 제외 금지. 개인 상태(`workspace.json`,
  `workspace-mobile.json`)만 제외하고 공유 설정은 버전관리합니다. (설치된 `.gitignore` 참고)
- 로컬 대용량 파일 훅은 **로컬 Node**를 전제로 합니다. Node가 없으면
  `.labnoteo/hooks/pre-commit`이 순수 shell 크기 검사로 대체됩니다(서버측 검증이 최종 게이트).

## 폴더 구조

연구원이 Obsidian에서 보지 않아도 되는 기계장치는 전부 숨김 폴더 `.labnoteo/`에 모여
있습니다. 점(`.`)으로 시작하는 폴더는 Obsidian 파일 탐색기·검색·그래프에 나타나지 않습니다.

```
vault/
├── .labnoteo/            기계장치 (Obsidian에서 숨김)
│   ├── scripts/          check-large-files.mjs, validate.mjs, issue-sync.mjs
│   ├── hooks/            pre-commit
│   └── SETUP.md          이 문서
├── .github/              워크플로 + 이슈 템플릿
├── .gitignore
├── AGENTS.md             AI 에이전트 규칙
├── CLAUDE.md             @AGENTS.md 포인터
├── QUICKSTART.md         연구원 가이드
├── wiki-staging/         원고 초안 (사람이 편집)
└── labnote/              실험 노트
    └── 001_Yield_opt/          ← 실험 폴더 = 자동화의 스캔 단위
        ├── README.labnote.md   frontmatter(status/id/discuss) + 마커
        ├── 001_WD010_….labnote.md   워크플로 노트 — 마커는 여기에도
        ├── 002_WB020_….labnote.md
        └── resources/labsamples/
```

`issue-sync`와 `validate`는 **실험 폴더 안의 모든 `*.labnote.md`** 에서 `@issue` 마커를
읽습니다. README 하나가 아니라 폴더 전체가 단위라는 점이 마커 ID 유일성 범위와도
직결됩니다(같은 폴더 안에서 ID가 겹치면 두 논의가 한 이슈로 합쳐짐).

루트에 남는 것에는 각각 이유가 있습니다. `.github/`는 GitHub이 강제하는 경로이고,
`AGENTS.md`/`CLAUDE.md`는 AI 에이전트가 저장소 루트에서만 찾습니다. `QUICKSTART.md`와
`wiki-staging/`은 사람이 Obsidian에서 직접 열어 읽고 편집하는 대상입니다.

## 설치되는 자산 (레퍼런스)

### 대용량 파일 보호

| 경로 | 설명 |
| --- | --- |
| `.labnoteo/scripts/check-large-files.mjs` | 파일 크기 검사(<10MB 허용 / 10–50MB 경고 / >50MB 차단, 자동 이동 없음) |
| `.labnoteo/hooks/pre-commit` | 커밋 전 대용량 파일 **차단**. 이어서 `labnote/` 파일이 스테이징된 커밋에 한해 `validate.mjs --notes-only`를 **경고 전용**으로 실행(마커 형식·ID 중복을 push 전에 알림). Node 없으면 shell 크기 검사로 대체 |
| `.gitignore` | 대용량 데이터 패턴 + Obsidian 개인 상태 + AI 에이전트 상태 폴더(**스킬은 제외 예외로 커밋됨**) (기존 내용에 누락분만 추가) |

### 노트 검증 (GitHub-hosted)

| 경로 | 설명 |
| --- | --- |
| `.labnoteo/scripts/validate.mjs` | status 허용값 / 중복 id / `@issue` 마커 형식·폴더 내 ID 중복 / 대용량 파일 중앙 재검사 (결정적). `--notes-only`는 마지막 대용량 재검사를 생략(훅 전용) |
| `.github/workflows/validate.yml` | `labnote/**` push마다 `node .labnoteo/scripts/validate.mjs` 실행. Actions 탭에서 **수동 실행**도 가능(항상 전체 검사) |

### Experiment ↔ Issue (결정적, AI 불필요)

| 경로 | 설명 |
| --- | --- |
| `.labnoteo/scripts/issue-sync.mjs` | `discuss: true`/`status: needs-review` 실험은 스레드 이슈 1개(닫혀 있으면 재오픈), 폴더 내 모든 `*.labnote.md`의 `@issue;<ID>;<주제>` 마커는 각각 별도 이슈(닫힌 것은 그대로). 모두 멱등 |
| `.github/workflows/experiment-issues.yml` | 결정적 잡(ubuntu, GitHub-hosted)만 — self-hosted 러너 불필요. Actions 탭의 **수동 실행은 `--all` 백필**(아래 참고) |
| `.github/ISSUE_TEMPLATE/experiment.md` | 노트 링크 + Objective + status + Discussion. 사람이 **실험 단위** 논의를 직접 열 때 쓰는 서식이라 항상 README를 가리킵니다 |

**백필(`--all`)** — push는 이번에 바뀐 실험 폴더만 봅니다. 자동화를 도입하기 전에 적어
둔 마커나, 그 뒤로 한 번도 건드리지 않은 폴더의 마커는 그대로 잠들어 있습니다. Actions
탭 → `experiment-issues` → **Run workflow**를 누르면 모든 실험 폴더를 훑어 한꺼번에
채웁니다.

- 처음 한 번은 **잠들어 있던 마커가 전부 이슈로 열립니다.** 규모를 먼저 가늠하려면
  `git grep -c '@issue;' -- 'labnote/**/*.labnote.md'`로 세어 보세요.
- 백필은 **닫힌 실험 이슈를 재오픈하지 않습니다.** `discuss: true`가 남은 채 논의만
  끝난 노트가 흔한데, 그걸 한꺼번에 되살리는 건 백필의 일이 아니기 때문입니다.
  (평소 push에서는 재오픈이 정상 동작입니다.)
- 마커가 많으면 GitHub 2차 레이트 리밋에 걸려 중간에 실패할 수 있습니다. `ensureIssue`가
  멱등이라 **그냥 다시 실행하면** 됩니다 — 중복 이슈는 생기지 않습니다.

### AI 에이전트 규칙 (로컬 에이전트 워크플로우)

| 경로 | 설명 |
| --- | --- |
| `AGENTS.md` | AI 에이전트 규칙 (git/커밋 메시지, 연구노트 규칙, 이슈 신호·Wiki 초안 playbook, 스킬 규칙). 마커 블록만 갱신되므로 사용자 규칙은 마커 밖에 작성 |
| `CLAUDE.md` | Claude Code용 `@AGENTS.md` 1줄 import (내용 중복 없음, AGENTS.md가 단일 소스) |

### Living Manuscript Wiki (사실 연결형)

| 경로 | 설명 |
| --- | --- |
| `.github/workflows/wiki-sync.yml` | 승인된 `wiki-staging/` → GitHub Wiki 동기화 (체크리스트 ④의 토큰 참고) |
| `wiki-staging/*.md` | 논문형 골격(Home/Abstract/…/Results(Finding)/Evidence Index/References) |

### 사용자 문서

| 경로 | 설명 |
| --- | --- |
| `QUICKSTART.md` | 연구원용 일상 사용 가이드(5분 따라하기 + 치트시트 + 기능 참조 + FAQ) |
| `.labnoteo/SETUP.md` | 이 문서 — 관리자/개발자용 설정 가이드 |
| `.labnoteo/installed.json` | 파일마다 마지막으로 맞춘 템플릿 기록. 플러그인 업데이트 때 직접 고치지 않은 파일만 자동 갱신하는 데 씀([업데이트](#업데이트) 참고) |

## 워크플로우 실행 조건 (문의가 가장 잦은 지점)

"push했는데 아무 일도 안 일어난다"는 대부분 아래 표로 설명됩니다.

| 워크플로우 | 경로 조건 | 브랜치 | 수동 실행 |
| --- | --- | --- | --- |
| `validate` | `labnote/**` 변경 | **모든 브랜치** | 가능 (전체 검사) |
| `experiment-issues` | `labnote/**` 변경 | **모든 브랜치** | 가능 (`--all` 백필) |
| `wiki-sync` | `wiki-staging/**` 변경 | **`main`만** | 가능 |

여기서 나오는 세 가지 착각:

- **경로 조건이 먼저입니다.** `.labnoteo/` 스크립트만 고쳐 push하면 `labnote/`가 바뀌지
  않았으므로 실행 자체가 없습니다. 실행 기록이 아예 비어 있다면 워크플로우 오류가 아니라
  이 조건에 걸린 것입니다.
- **이슈는 작업 브랜치에서도 열립니다.** 머지 전에 열리는 게 의도된 동작입니다.
- **Wiki만 `main`을 요구합니다.** 브랜치에서 `wiki-staging/`을 고쳐 놓고 발행을 기다리는
  일이 없도록 연구원에게 안내하세요(`QUICKSTART.md`에도 적혀 있습니다).

## 아키텍처: AI 워크플로우 (로컬 에이전트 — self-hosted 러너 불필요)

AI가 필요한 판단은 GitHub Actions가 아니라 **로컬 AI 에이전트**(Claude Code, Cursor 등)가
`AGENTS.md` 규칙에 따라 수행합니다. 서버측 자동화는 전부 결정적이라 GitHub-hosted 러너만으로
동작합니다.

- **커밋/푸시**: 에이전트가 네이티브 `git`으로 수행하며, 변경 내용 기반 커밋 메시지를
  작성합니다(Conventional Commits + `EXP-###`). Obsidian Git 플러그인은 필요 없습니다.
  `git commit --no-verify`는 금지입니다(대용량 훅 우회 방지).
- **토론 이슈**: 노트의 자유 서술에서 논의가 필요하다고 판단되면 에이전트가 (사용자 확인 후)
  frontmatter에 `discuss: true`를 설정합니다. push 후 서버 `issue-sync`가 이슈를 멱등
  생성/갱신하므로 에이전트가 이슈를 직접 만들지 않습니다(중복 방지).
  에이전트를 쓰지 않는 연구원은 플러그인의 *Toggle discussion flag* 명령으로 같은
  표시를 켭니다 — 본문 문구만으로는 이슈가 열리지 않습니다(자유 서술 스캔 없음).
- **지점별 논의**: 실험 폴더의 **모든 `*.labnote.md`**(README + 워크플로 노트) 본문에서
  `@issue;<ID>;<주제문장>` 마커마다 별도 이슈가 열리며,
  이슈 본문에는 마커가 있는 그 파일·그 줄로 가는 커밋 기준 퍼머링크가 들어갑니다.
  스캔 범위는 "이번 push에서 바뀐 파일"이 아니라 "바뀐 실험 폴더 전체"라
  이전 push에 남아 있던 마커도 다음 push 때 처리됩니다(`ensureIssue`가 멱등). 마커는 명시적 토큰이라
  오탐이 없어 AI 판단 없이 결정적으로 처리됩니다. ID는 플러그인의
  *Insert issue marker* 명령이 생성하며, 형식이 깨진 마커는 `validate`가 줄 번호와
  함께 오류로 보고합니다(조용히 무시되면 논의가 유실되기 때문).
- **Wiki 초안**: 에이전트가 노트의 객관적 사실만 `wiki-staging/` 관련 섹션에
  근거 ID(`EXP-###`)와 함께 추가합니다(해석/의견 금지). 사람이 검토·머지하면
  `wiki-sync.yml`이 GitHub Wiki로 발행합니다.
- **Claude Code 사용자**: `CLAUDE.md`의 `@AGENTS.md` import로 위 규칙이 자동 로드됩니다.
  터미널이든 Copilot 에이전트 모드든 같은 `claude` CLI라면 동일하게 적용됩니다.
- **에이전트 상태 폴더**(`.claude/`, `.copilot/`, `.opencode/`, `.agents/`)와 Copilot
  플러그인 폴더 `copilot/`(대화 기록·메모리·프롬프트)은 설치된 `.gitignore`가 커밋에서
  제외합니다. 다만 **스킬은 예외로 커밋됩니다** — 정본은
  `.agents/skills/`(Codex·Cursor가 읽음)이고, Claude Code용으로는 `.claude/skills/`에
  얇은 포인터를 둡니다. 스킬은 `AGENTS.md`의 "자동화와의 경계"를 무효화할 수 없습니다.
  Copilot의 스킬 공유 폴더 `copilot/skills/`도 커밋되는데, 여기에는 Copilot이 만드는
  내장 스킬(`copilot-web-search` 등)도 들어 있어 연구원마다 Copilot 버전이 다르면 그
  파일에 diff가 생길 수 있습니다. Copilot 설정에서 폴더 위치(Copilot folder location)를
  바꿨다면 `.gitignore`의 `copilot/*`, `!copilot/skills/` 두 줄도 그 이름으로 바꾸세요.

연구원 관점의 사용 절차(실험 생성 → 논의 표시 → 커밋 → 이슈 확인 → Wiki)는
`QUICKSTART.md`에 있습니다.

## 수동 점검 명령

```sh
node .labnoteo/scripts/check-large-files.mjs   # 대용량 파일 검사
node .labnoteo/scripts/validate.mjs            # 노트 검증 (status/중복 id/@issue 마커)
node .labnoteo/scripts/validate.mjs --notes-only  # 위에서 대용량 재검사만 생략 (훅과 동일)
```

## 업데이트

플러그인을 업데이트하면 Obsidian을 켤 때 스크립트와 문서가 자동으로 갱신되고, 바꾼
파일을 알림으로 알려 줍니다. 변경 사항은 Git diff로 검토한 뒤 커밋하세요.

- 설치한 뒤 **직접 고치지 않은** 파일은 새 버전으로 통째로 교체합니다. 어느 템플릿과
  맞췄는지는 `.labnoteo/installed.json`에 기록되며, 이 파일도 함께 커밋합니다.
- `AGENTS.md`는 마커 블록만, `.gitignore`/`CLAUDE.md`는 누락 줄만 갱신되므로 사용자
  수정이 보존됩니다.
- **직접 고친** 파일(`QUICKSTART.md`에 덧붙인 메모 등)과 보관함에 **없는** 파일은
  건드리지 않고 목록만 알려 줍니다. 그때 "Setup research automation" 명령을 다시
  실행하면 파일마다 덮어쓸지 묻습니다. 한 번 알린 파일은 템플릿이 다시 바뀔 때까지
  다시 알리지 않습니다.
- `wiki-staging/` 초안은 자동으로 바꾸지 않습니다.
- `installed.json`이 없는 보관함(0.95.0 이전 버전으로 설치)도 이전 버전이 만든 그대로인
  파일과 `.labnoteo/scripts/*.mjs`는 자동으로 갱신됩니다. 고친 파일은 위처럼 한 번만
  알립니다.

**갱신된 스크립트는 커밋하고 push해야 서버 동작이 바뀝니다.** GitHub Actions는 플러그인이
아니라 저장소에 **커밋된** `.labnoteo/scripts/*.mjs`를 실행합니다. 재설정만 하고 push하지
않으면 서버는 계속 옛 스크립트를 돌리고, 로그도 옛 메시지를 출력합니다.

```sh
git add .labnoteo .github AGENTS.md CLAUDE.md QUICKSTART.md .gitignore   # .labnoteo/installed.json 포함
git commit -m "chore(labnoteo): 자동화 자산 갱신"
git push
```

push 자체는 `labnote/`를 건드리지 않으므로 워크플로우가 돌지 않습니다. 새 동작을 바로
확인하려면 노트 변경을 같은 push에 포함시키거나, Actions 탭에서 수동 실행하세요.

### 0.86.0 이전 보관함에서 올라올 때 (한 번만)

`@issue` 마커 스캔 범위가 `README.labnote.md` 하나에서 **실험 폴더의 모든
`*.labnote.md`** 로 넓어졌습니다. 그전까지 워크플로 노트에 적은 마커는 전부 무시되고
있었습니다.

- [ ] 재설정 후 `.labnoteo/`를 **커밋·push**(위 참고).
- [ ] Actions 탭에서 `experiment-issues`를 **수동 실행**해 잠들어 있던 마커를 백필.
      **그동안 쌓인 마커가 한꺼번에 이슈로 열립니다** — 규모가 걱정되면 먼저
      `git grep -c '@issue;' -- 'labnote/**/*.labnote.md'`로 세어 보세요.
- [ ] 마커 ID가 폴더 안에서 겹치면 이제 `validate`가 실패합니다. 실패하면 보고된
      줄에서 한쪽 마커를 지우고 *Insert issue marker*로 새로 넣으세요.

### 0.90.7 이전 보관함에서 올라올 때 (한 번만)

Copilot 플러그인 폴더(`copilot/`)의 대화 기록·메모리가 그동안 커밋 대상이었습니다.
재설정하면 `.gitignore`에 `copilot/*`·`!copilot/skills/`가 추가되지만, **이미 커밋된
파일은 무시 규칙만으로 추적에서 빠지지 않습니다.**

- [ ] 보관함에 `copilot/` 폴더가 있으면(Copilot 플러그인을 썼다면) 아래 명령으로
      `copilot/`을 추적에서 뺀 뒤, 무시되지 않는 것(스킬)만 다시 추가합니다. 파일
      자체는 지우지 않습니다. 폴더가 없으면 이 단계는 건너뜁니다.

  ```sh
  git rm -r -q --cached --ignore-unmatch copilot
  git add copilot
  git status   # copilot-conversations/·memory/ 등은 "deleted", skills/만 남는지 확인
  git commit -m "chore: Copilot 대화 기록을 추적에서 제외"
  ```

- [ ] 팀이 Copilot 사용자 명령(`copilot/copilot-custom-prompts/`)을 일부러 공유해
      왔다면, `.gitignore`의 `copilot/*` 줄 아래에 `!copilot/copilot-custom-prompts/`를
      추가한 뒤 위 명령을 실행하세요.
- [ ] 이미 push된 대화는 원격 저장소 기록에 남습니다. 지워야 할 내용이 있으면 관리자와
      기록 정리 여부를 상의하세요.

### 0.82.0 이전 보관함에서 올라올 때 (한 번만)

자산이 루트(`scripts/`, `.githooks/`, `SETUP.md`)에서 `.labnoteo/`로 옮겨졌습니다.
명령을 다시 실행하면 옛 파일을 **확인 후 삭제**해 주지만, 다음 두 가지는 직접 해야 합니다.

- [ ] **훅 경로 재설정** — 옛 `.githooks/pre-commit`이 삭제되면 Git이 훅 없는 폴더를
      가리켜 **대용량 보호가 조용히 꺼집니다.** 반드시 다시 실행하세요:

  ```sh
  git config core.hooksPath .labnoteo/hooks
  ```

- [ ] **`.gitignore`의 낡은 두 줄 삭제** — `.gitignore`는 누락 줄만 *추가*하므로 옛
      `.claude/` / `.agents/` 줄이 그대로 남습니다. 폴더를 통째로 제외하면 Git이 내부로
      내려가지 않아 새로 추가된 `!.claude/skills/` 예외가 무효가 되고, **에이전트 스킬이
      커밋되지 않습니다.** 아래 두 줄을 직접 지우세요(설정 명령이 감지되면 경고합니다).

  ```
  .claude/
  .agents/
  ```
