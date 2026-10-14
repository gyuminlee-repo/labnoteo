# Labnote Assistant for Obsidian (labnoteo)

**버전 0.92.1**

[English](README.en.md)

바이오파운드리기반 합성생물학 실험을 위한 Obsidian용 Markdown 기반 실험 노트입니다. 샘플 추적, 워크플로 체크리스트, 유닛 오퍼레이션, 선택적 LLM 보조 기능을 제공합니다.

이 저장소는 Labnote Assistant의 Obsidian 포팅 버전입니다. 파싱·도메인 로직은 동반 VS Code 확장과 개념을 공유하지만, 이 저장소 안에서 완전히 자립적으로 동작합니다.

## 빠른 시작

1. **[설치 가이드](docs/INSTALL.md)** — Obsidian 설치부터 첫 push까지 순서대로.
2. 설치 후 일상 사용법은 명령 팔레트 → **사용법 열기**(`Open user guide`)로 여는 `QUICKSTART.md`(연구원용)를 보세요. 없으면 보관함에 바로 만들어 주며, 연구노트 자동화 설정은 필요 없습니다.
3. 커밋·이슈·Wiki를 AI 에이전트에게 맡기려면 **[Copilot 에이전트 가이드](docs/COPILOT.md)**.

## 주요 기능

- **샘플 추적**: 전용 Samples 사이드바 뷰. 샘플(DNA, RNA, Plasmid 및 사용자 정의 타입)을 정의·삽입·편집하고(사이드바 검색창과 **보관 위치** 기록 포함), 로컬(노트)/글로벌 범위 간 이동을 지원합니다. 본문에서 **우클릭 → *샘플 추가***로도 바로 만들어 참조를 넣을 수 있습니다.
- **워크플로 체크리스트**: Workflows 사이드바 뷰에서 번호가 매겨진 워크플로 노트를 생성·관리하고 목차를 자동 동기화합니다.
- **유닛 오퍼레이션**: 내장 카탈로그에서 하드웨어/소프트웨어 유닛 오퍼레이션을 삽입하고, 헤딩 정규화와 목차를 자동 갱신합니다.
- **샘플 자동완성·하이라이트 · CSV 내보내기**: 편집 중 샘플 참조 인라인 제안과 하이라이트, 노트 표의 CSV 내보내기(엑셀 호환 UTF-8 BOM).
- **실험 상태 · 논의 표시 · 이슈 마커**: 실험 생애주기(`planned` → `in-progress` → … → `completed`/`failed`)를 frontmatter에 기록하고, 팀 논의가 필요한 노트에는 *논의 표시*나 그 자리에 `@issue;<ID>;<주제문장>` 마커를 달아 push 때 GitHub Issue로 엽니다.
- **LLM 보조(선택)**: Ollama 또는 OpenAI로 방법 초안·결과 요약·샘플 추출. *어시스턴트에게 요청* 명령은 모델이 Labnote 툴을 직접 호출해 목표를 달성하며, 보관함 수정 전 매번 확인합니다. 마지막 답변은 창으로 보여 주고, `노트에 넣기`를 눌러야 노트에 들어갑니다. 같은 툴을 외부 MCP 클라이언트에도 노출할 수 있습니다.
- **연구노트 자동화(선택)**: 명령 한 번으로 GitHub Actions·무의존성 스크립트·AI 에이전트 규칙(`AGENTS.md`)을 보관함에 설치해 노트 검증·Experiment ↔ Issue 연결·Living-Manuscript Wiki를 자동화합니다. 모두 선택적이며 사람이 검토합니다. [아래](#연구노트-자동화) 참고.



## 요구 사항

- Obsidian `1.5.0` 이상 (최신 버전 권장).
- GitHub 자동화를 쓸 때: [git](https://git-scm.com/downloads)과 GitHub 계정. (노트만 쓸 거라면 불필요.)
- 개발 시 Node.js `22+`.



## 설치

Obsidian 설치와 git·GitHub 계정 준비부터 커뮤니티 플러그인·자동화·첫 push까지 단계별
안내는 **[설치 가이드(docs/INSTALL.md)](docs/INSTALL.md)** 에 있습니다. 요약하면:

1. (자동화용) git 설치 + GitHub 계정 준비.
2. Obsidian 설치 → 보관함 만들기 → 커뮤니티 플러그인 켜기.
3. **BRAT**로 이 플러그인(`sblabkribb/labnoteo`)을 설치·활성화.
4. (자동화를 쓸 때만) *연구노트 자동화 설정* 실행 → (선택) Copilot 에이전트 연결 → 빈 private GitHub 저장소를 만들고 첫 커밋·push(Copilot에게 맡기거나 수동 git).



## 주요 명령어

명령 팔레트에는 영문 이름으로 등록됩니다(괄호 안).


| 명령어                                                      | 설명                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| 날짜 삽입 (`Insert date`)                                    | 현재 날짜 삽입                                                                |
| 날짜 및 시간 삽입 (`Insert date and time`)                      | 현재 타임스탬프 삽입                                                             |
| 실험 생성 (`Create experiment`)                              | 새 `.labnote.md` 실험 노트 생성                                                |
| 실험 상태 변경 (`Change experiment status`)                    | 활성 실험의 `status` frontmatter를 피커로 변경                                     |
| 논의 표시 전환 (`Toggle discussion flag`)                      | 활성 실험의 `discuss` 표시를 켜고 끔 — 다음 push 때 GitHub Issue 생성(연구노트 자동화 설정 필요) |
| 논의 이슈 마커 삽입 (`Insert issue marker`)                      | 커서 위치에 `@issue;<ID>;<주제문장>` 마커 삽입(선택 영역이 주제문장) — 마커마다 별도 Issue 생성(연구노트 자동화 설정 필요). 선택 뒤에 글자가 남거나 커서가 줄 중간이면 원문은 그대로 두고 줄 끝에 마커를 붙임. 제목 줄에서는 아랫줄에 넣고, 표 안에서는 넣지 않음 |
| 워크플로 생성 (`Create workflow`)                              | 번호가 매겨진 워크플로 노트 생성                                                      |
| 워크플로 번호 다시 매기기 (`Renumber workflows`)                   | 실험 폴더의 워크플로 번호를 001부터 빈틈없이 다시 매기고, 체크리스트에 없는 워크플로도 함께 등록. `Export tables to CSV`로 만든 `<노트이름>.labnote_tableN.csv`도 새 번호로 함께 옮김(같은 이름의 파일이 이미 있으면 그 CSV는 그대로 두고 알림) |
| 폴더와 워크플로 체크리스트 맞추기 (`Sync workflow checklist with folder`) | 옮겨 오거나 복사한 워크플로를 README 체크리스트에 등록하고, 파일이 없는 항목은 확인 후 제거. 라벨이 파일 이름과 어긋난 항목은 `옛 라벨 → 새 라벨` 목록을 보여 주고 확인 후 고침. README·실험 폴더 우클릭에도 있음 |
| 유닛 오퍼레이션 삽입 (`Insert unit operation`)                    | 카탈로그에서 유닛 오퍼레이션 삽입                                                      |
| 표 CSV 내보내기 (`Export tables to CSV`)                      | 노트의 표를 노트와 같은 폴더에 `<노트이름>.labnote_tableN.csv`로 내보내기. 행은 머리글 칸 수에 맞추고(넘치는 칸은 버리고 모자란 칸은 빈 칸) 셀 안 `<br>`은 줄바꿈이 됨. 이제 없는 표의 CSV가 남아 있으면 목록을 보여 주고 확인 후 휴지통으로 옮김 |
| 연구노트 자동화 설정 (`Setup research automation`)                | GitHub Actions·스크립트를 현재 보관함에 설치([연구노트 자동화](#연구노트-자동화) 참고)               |
| AI: Method 섹션 초안 (`AI: Draft Method section`)            | 설정된 LLM으로 실험 방법 초안 작성. 유닛 오퍼레이션 안에서 실행하면 그 `#### Method` 절을 채우고(이미 쓴 내용이 있으면 먼저 확인), 밖에서는 커서가 있는 줄 다음에 넣음 |
| AI: 결과 요약 (`AI: Summarize results`)                      | 설정된 LLM으로 결과 요약을 커서가 있는 줄 다음에 넣음. 커서가 머리말(frontmatter) 안이나 첫 제목 위에 있으면 문서 끝(마지막 절)에 붙임 |
| AI: 샘플 정의 추출 (`AI: Extract sample definitions`)          | 설정된 LLM으로 노트에서 샘플 추출. 알 수 없는 타입은 건너뛰고, `<타입>-<숫자>` 형식이 아닌 ID는 새로 만듦(원래 값은 별칭이 비어 있을 때 별칭으로 남김) |
| AI: 어시스턴트에게 요청 (`AI: Ask assistant (uses tools)`)        | 목표를 말하면 모델이 Labnote 툴로 수행(지금 노트 앞부분을 함께 읽음). 마지막 답변은 창으로 보여 주며 `노트에 넣기`·`복사`·`닫기` 중 고름 — 노트에 자동으로 들어가지 않음 |
| MCP 서버 토글 (`Toggle MCP server`)                          | 로컬 MCP 서버 시작/중지([Copilot 가이드](docs/COPILOT.md#선택-labnote-툴-연결--mcp) 참고) |
| 워크플로/샘플 뷰 열기 (`Open workflow view` / `Open sample view`) | 사이드바 뷰 표시                                                               |
| 사용법 열기 (`Open user guide`)                                  | 연구원용 퀵스타트(`QUICKSTART.md`)를 열고, 없으면 보관함에 만듦(연구노트 자동화 설정 불필요). 설정 탭 맨 위 버튼도 같음 |


> 파일 탐색기에서 워크플로 파일 이름을 바꾸면 README 체크리스트가 새 번호(NNN) 순서로 자동 재정렬되고, 삭제하면 해당 체크리스트 항목이 정리됩니다(샘플은 남고 그 노트의 사용 기록만 지워집니다). 지운 노트의 `.labnote_tableN.csv`가 남아 있으면 확인 후 휴지통으로 옮깁니다. 이름을 바꾸면 그 노트의 `_tableN.csv`도 따라 옮겨지고, 라벨이 옛 파일 이름과 같았던 항목은 라벨도 새 이름을 따라가며, 노트의 `title`과 `## [ID 이름]` 제목도 옛 파일 이름과 같았다면 새 이름을 따라갑니다(직접 고친 라벨·title은 그대로 둠). `Sync workflow checklist with folder`는 파일 이름과 어긋난 노트 `title`·제목과 라벨을 찾아 확인을 받은 뒤 고칩니다. 이름을 바꾸다 `###_….labnote.md` 형식이 깨지면 경고하고 고칠 이름을 제안하며, 형식을 되찾으면(제안을 받아들이거나 직접 고쳐도) 체크리스트가 다시 그 파일을 따라갑니다. 다른 실험 폴더로 옮긴 워크플로는 자동 등록되지 않고 알림만 뜨므로 `Sync workflow checklist with folder`로 등록하고, "복사본 생성"으로 만든 `….labnote 1.md`는 원본 별칭을 채운 입력 창으로 새 별칭을 물은 뒤 다음 번호의 파일 이름·노트 `title`·`## [ID 이름]` 제목을 함께 바꾸고 체크리스트에 등록합니다(취소하면 아무것도 바꾸지 않음). `Insert workflow`(README 우클릭)는 카탈로그에서 새 워크플로를 만드는 기능입니다.
>
> 실험 폴더 이름은 `###_`(예: `020_GFP`)로 시작해야 합니다. 이름을 바꾸다 번호가 빠지면 경고하고 옛 번호를 붙인 이름으로 되돌릴지 묻습니다. 번호 없는 폴더의 노트에서 워크플로 명령을 실행하면 "실험 폴더가 아님"을 알려 줍니다.



## 연구노트 자동화

노트 자체를 넘어, labnoteo는 보관함을 GitHub 위의 경량 연구노트 시스템으로 바꿔 줍니다 — 노트 검증, Experiment ↔ Issue 연결, Living-Manuscript Wiki를 CI를 직접 작성하지 않고도 구성합니다. 명령 팔레트에서 **연구노트 자동화 설정**(`Setup research automation`)을 실행하면 아래 자산을 현재 보관함에 프로비저닝합니다.

- **대용량 파일 보호** — `.labnoteo/scripts/check-large-files.mjs` + pre-commit 훅 + `.gitignore`로 커밋 전 과대 파일 차단.
- **검증** — `validate.mjs` + `validate.yml`. push마다 `status` 값·실험 id 중복·`@issue` 마커 형식과 폴더 내 ID 유일성 검사.
- **Experiment ↔ Issue** — `issue-sync.mjs` + `experiment-issues.yml`. `discuss: true`/`status: needs-review` 실험은 스레드 이슈 1개, 폴더 내 모든 `*.labnote.md`의 `@issue` 마커는 각각 별도 이슈. 결정적·멱등.
- **AI 에이전트 규칙** — `AGENTS.md`/`CLAUDE.md`. 로컬 AI 에이전트를 위한 git·커밋·이슈 신호·Wiki 초안 규칙.
- **Living-Manuscript Wiki(선택)** — `wiki-sync.yml`. 사람이 검토·머지한 `wiki-staging/` 초안을 GitHub Wiki로 발행.

번들 스크립트는 **무의존성** Node ESM이라 보관함에서 `npm install`이 필요 없습니다. 서버측 자동화는 전부 **결정적**이라 GitHub-hosted 러너만으로 동작하고, "이 노트에 논의가 필요한가?" 같은 AI 판단은 **로컬 AI 에이전트**가 `AGENTS.md` 규칙에 따라 수행합니다 — 이슈 생성/Wiki 발행은 서버가 단독 담당하므로 중복이 없습니다. 자동화는 **노트를 되쓰지 않으며**, `status` 변경과 과학적 판단은 사람의 몫입니다.

전체 자산 표·전제 조건·백필 절차는 설치 후 보관함에 생기는 관리자 문서 `.labnoteo/SETUP.md`를, 일상 사용법은 `QUICKSTART.md`를 참고하세요. `AGENTS.md`는 [Copilot과도 공유](docs/COPILOT.md#agentsmd-공유-규칙)됩니다.

## 설정

**샘플**

- **샘플 추적**: Samples 사이드바 뷰 표시 여부.
- **사용자 정의 샘플 타입**: 내장 타입 외에 사용자 정의 타입 추가. 한글 타입(`배지`)도 `@배지` 자동완성·하이라이트가 됩니다. 글자·숫자·`_`만 쓰세요 — 공백이나 `-`가 든 타입(`Cell Line`, `Cell-Line`)은 자동완성되지 않습니다.
- **글로벌 샘플 폴더**: 보관함 전역 샘플 저장소 폴더 (기본 `resources/labsamples`). 보관함 최상위 노트는 로컬 폴더가 이 폴더(기본값일 때)와 같으므로, 거기서 만든 샘플은 직전에 연 실험과 상관없이 글로벌 샘플이 되며 그렇게 알려 줍니다.

**워크플로**

- **유닛오퍼레이션 TOC 자동 정렬** (`Auto-sync unit operation TOC`): 편집 후 워크플로 노트의 `Related Unit Operations` 목록을 헤딩 순서에 맞게 자동 정렬합니다 — 유닛 오퍼레이션 블록을 옮기면 문서 맨 위 목차도 따라 재정렬됩니다. Obsidian Outline 보기에서 드래그로 블록을 옮기면 목차와 `---` 구분선이 곧바로 정리되고, 다른 유닛 오퍼레이션 위에 놓아도 블록이 쪼개지지 않고 그 유닛 오퍼레이션 뒤로 들어갑니다. 정리는 이동과 별도로 저장되므로, 이동 전으로 되돌리려면 Ctrl+Z를 두 번 눌러야 할 수 있습니다. 목차 링크는 GitHub에서 노트를 볼 때 해당 블록으로 이동하도록 GitHub 앵커 규칙(한글 유지, 같은 유닛 오퍼레이션 반복 시 `-1`, `-2`)을 따릅니다. Obsidian 안에서는 목차 링크 대신 Outline(개요) 보기를 클릭해 이동하세요. 기본 켜짐.
- **마지막 갱신일 자동 기록** (`Auto-update last updated date`): 연구노트(실험 폴더의 `*.labnote.md`)를 편집기에서 직접 고치거나, `Change experiment status`·`Toggle discussion flag`로 바꾸거나, AI가 고치면 frontmatter의 `last_updated_date`를 오늘 날짜(서울 기준)로 바꿉니다. 노트마다 하루에 한 번만 바뀌고, 워크플로 노트를 고치거나 새 워크플로를 만들면 그 실험의 README 날짜도 함께 바뀝니다. git pull 등으로 받아온 변경과 되돌리기는 반영하지 않으며, 체크리스트 동기화·번호 다시 매기기 같은 자동 정리도 날짜를 바꾸지 않습니다. 날짜를 직접 고친 노트는 Obsidian을 다시 켤 때까지 그대로 둡니다. 날짜 갱신도 실행 취소 기록에 남으므로, 그날 첫 편집을 되돌리려면 Ctrl+Z를 한 번 더 눌러야 할 수 있습니다. 기본 켜짐.

**AI 제공자**

- **제공자**: `none`, `ollama`, `openai`. 플러그인이 제공자와 직접 통신합니다.
- **Ollama 엔드포인트** / **OpenAI 엔드포인트**: 기본 URL. 제공자를 바꿀 때 OpenAI 키가 로컬 Ollama 주소로 새어 나가지 않도록 필드를 분리해 두었습니다.
- **모델**: 모델 id. 예: `qwen3`, `gpt-4o-mini`.
- **API 키**: OpenAI 호환 제공자 전용 — Ollama로는 전송되지 않습니다.

> **툴 호출에는 함수 호출(function calling)을 지원하는 모델이 필요합니다.** Ollama에서는 `tools` capability가 있는 모델(`qwen3`, `llama3.1` 등)을 쓰세요. 지원하지 않는 모델은 툴을 호출하지 않고 산문으로만 답합니다.

**MCP 서버 · Copilot 에이전트** — 로컬 MCP 서버로 Labnote 툴을 외부 클라이언트에 노출하거나, Copilot 에이전트 모드로 커밋·이슈·Wiki를 맡기는 설정은 **[Copilot 에이전트 가이드](docs/COPILOT.md)** 를 참고하세요.

## 개발자 참고

npm workspaces 모노레포 구조입니다:

- `src/` — Obsidian 플러그인. esbuild로 저장소 루트의 `main.js`로 번들됩니다. Obsidian 커뮤니티 디렉터리가 루트의 `manifest.json`을 읽기 때문에 플러그인이 루트에 있습니다.
- `packages/labnoteo-core` — 플랫폼 중립 core 로직 (파서, 워크플로/샘플 도메인). 플러그인이 사용합니다. Node 전용 API를 import하면 안 되며, 플랫폼 의존 기능은 포트(`LabnoteFs`, `LabnoteHost`) 뒤에 둡니다.
- `automation/` — 보관함에 설치되는 [연구노트 자동화](#연구노트-자동화) 스크립트의 소스. esbuild가 (1단계) 무의존성 `dist-automation/*.mjs`로 번들하고 — 플러그인과 같은 `@labnoteo/core` 소스를 재사용하므로 드리프트가 없음 — (2단계) 워크플로/AGENTS.md/Wiki 템플릿과 함께 `main.js`에 문자열로 임베드합니다. 덕분에 3-파일 설치만으로 자립합니다. *연구노트 자동화 설정* 명령이 그 문자열을 보관함에 기록합니다. 이 폴더의 소스가 전부 배포되는 것은 아닙니다 — `issue-gate.ts`와 `wiki-propose.ts`는 그 판단을 이제 로컬 AI 에이전트가 맡으므로 빌드에서 제외되어 있고(`esbuild.config.mjs`), 향후 opt-in 경로를 위해 소스만 남겨 둡니다.
- `issue-sync`와 `validate`는 **같은 마커를 봐야** 합니다. 그래서 둘 다 README를 직접 읽지 않고 `readMarkerSources`로 폴더를 읽습니다 — 한쪽만 범위를 좁히면 검증되지 않은 마커로 이슈가 열리거나 그 반대가 됩니다.
- `tests/` — 플러그인 계층 테스트와 `obsidian` 패키지의 런타임 스텁(해당 패키지는 타입만 제공). core 테스트는 코드 옆 `packages/labnoteo-core/src/__tests__/`에 있습니다.

```bash
npm install           # 전체 워크스페이스 설치
npm run dev           # 워치 빌드
npm run build         # Obsidian 플러그인 번들 -> main.js
npm run typecheck     # core + plugin 타입 검사
npm test              # 전체 테스트 실행 (vitest: core + plugin 프로젝트)
npm run sync:versions # 루트 버전을 패키지, manifest, README에 전파
```

`npm run sync:versions -- --check`는 아무것도 쓰지 않고, 루트 `package.json` 버전과 어긋난 대상이 있으면 실패합니다. CI가 이 형태로 실행합니다.

모든 `LabnoteFs` 구현은 `packages/labnoteo-core/src/__tests__/labnoteFsContract.ts`의 공용 계약 테스트를 통과해야 합니다. `{Type}.json`의 원자성 보장이 여기서 강제됩니다.

`npm run record:fixtures`는 `tests/fixtures/llm/`의 LLM 응답 픽스처를 실제 제공자로부터 다시 녹화합니다. 픽스처의 목적과 provenance 표기는 해당 폴더의 README를 참고하세요.

## 라이선스

[Apache License 2.0](LICENSE) © 2026 Korea Biofoundry (KRIBB). 재배포 시 [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE) 파일을 함께 보존하세요.