# Labnote Assistant for Obsidian (labnoteo)

**버전 0.123.0**

[English](README.en.md)

바이오파운드리기반 합성생물학 실험을 위한 Obsidian용 Markdown 기반 실험 노트입니다. 샘플 추적, 워크플로 체크리스트, 유닛 오퍼레이션, 선택적 LLM 보조 기능을 제공합니다.

이 저장소는 Labnote Assistant의 Obsidian 포팅 버전입니다. 파싱·도메인 로직은 동반 VS Code 확장과 개념을 공유하지만, 이 저장소 안에서 완전히 자립적으로 동작합니다.

## 빠른 시작

1. **[설치 가이드](docs/INSTALL.md)** — Obsidian 설치부터 첫 push까지 순서대로.
2. **[사용법(QUICKSTART)](automation/templates/QUICKSTART.md)** — 설치 후 일상 사용법과 모든 명령의 자세한 동작. 명령 팔레트 → **사용법 열기**(`Open user guide`)로 보관함 안에서 열 수도 있습니다(연구노트 자동화 설정은 필요 없음).
3. 커밋·이슈·Wiki를 AI 에이전트에게 맡기려면 **[Copilot 에이전트 가이드](docs/COPILOT.md)**.
4. 기록지를 출력해 손으로 적고 사진·스캔을 노트에 붙이려면 **[출력본 스캔 가이드](docs/SCAN.md)**.
5. 기능을 영상으로 먼저 보려면 **[도움말 사이트](https://sblabkribb.github.io/labnoteo/)** — 기능별 짧은 영상과 사용법(한/영).

## 주요 기능

- **샘플 추적**: 전용 Samples 사이드바 뷰에서 샘플(DNA, RNA, Plasmid 및 사용자 정의 타입)을 정의·삽입·편집하고 로컬(노트)/전역 범위 간에 옮깁니다. 편집 중 `@` 자동완성과 하이라이트가 뜨고, 대장에 없는 ID에는 빨간 물결 밑줄이, 대장과 다른 별칭에는 주황 점선 밑줄이 붙습니다. 다 쓴 시료는 지우지 않고 *폐기로 표시*로 남깁니다. → [샘플 다루기](automation/templates/QUICKSTART.md#샘플-다루기)
- **워크플로 체크리스트**: Workflows 사이드바 뷰에서 번호가 매겨진 워크플로 노트를 만들고 README 목차를 자동 동기화합니다. 뷰 맨 위 **실험** 칸은 보관함의 실험을 상태별·과제별·논의 표시별로 묶어 보여 주고, 검색과 키보드 조작(↑↓→←, Enter, Shift+F10)을 지원합니다. → [기록하기](automation/templates/QUICKSTART.md#기록하기)
- **유닛 오퍼레이션**: 내장 카탈로그에서 하드웨어/소프트웨어 유닛 오퍼레이션을 삽입하고, 헤딩 정규화와 목차를 자동 갱신합니다. → [유닛 오퍼레이션](automation/templates/QUICKSTART.md#유닛-오퍼레이션-한-번의-작업)
- **샘플 자동완성 · CSV 내보내기**: 편집 중 샘플 참조 인라인 제안과 하이라이트, 노트 표의 CSV 내보내기(엑셀 호환 UTF-8 BOM). → [날짜 · 표](automation/templates/QUICKSTART.md#날짜--표)
- **실험 상태 · 논의 표시 · 이슈 마커**: 실험 생애주기(`planned` → `in-progress` → … → `completed`/`failed`)를 frontmatter에 기록하고, 팀 논의가 필요한 노트에는 *논의 표시*나 그 자리에 `@issue;<ID>;<주제문장>` 마커를 달아 push 때 GitHub Issue로 엽니다.
- **노트 ID · QR 기록지 · 스캔 붙이기(데스크톱)**: 실험 노트마다 고유 ID(`labnote_id: LN-7K3M9QX2`)를 붙이고, 워크플로 노트를 페이지마다 QR이 찍힌 **실험 기록지**로 출력합니다. 손으로 적은 뒤 휴대폰 사진이나 복합기 스캔(이미지·PDF·zip)을 **PC 스캔 폴더**에 넣거나 창에 끌어다 놓으면 QR을 읽어 그 유닛 오퍼레이션 끝 `#### Worksheet scans` 절에 이미지를 붙입니다. 내 Slack 봇에게 DM으로 보내도 됩니다(선택). → [출력본 스캔 가이드](docs/SCAN.md)
- **partbank 연동(선택)**: partbank의 부품·플라스미드·프라이머·균주를 `@` 자동완성에서 검색해 시료로 등록하고, 보관 위치를 읽어 오고, partbank 화면을 엽니다. 카탈로그를 통째로 내려받아 오프라인에서 고를 수도 있습니다. API 키는 보관함이 아니라 PC에만 저장됩니다. → [partbank에서 부품 가져오기](automation/templates/QUICKSTART.md#partbank에서-부품-가져오기)
- **LLM 보조(선택)**: Ollama 또는 OpenAI로 방법 초안·결과 요약·샘플 추출. *어시스턴트에게 요청* 명령은 모델이 Labnote 툴을 직접 호출해 목표를 달성하며, 보관함 수정 전 매번 확인합니다. 같은 툴을 외부 MCP 클라이언트에도 노출할 수 있습니다. → [AI 도우미](automation/templates/QUICKSTART.md#ai-도우미)
- **연구노트 자동화(선택)**: 명령 한 번으로 GitHub Actions·무의존성 스크립트·AI 에이전트 규칙(`AGENTS.md`)을 보관함에 설치해 노트 검증·Experiment ↔ Issue 연결·Living-Manuscript Wiki를 자동화합니다. 모두 선택적이며 사람이 검토합니다. → [아래](#연구노트-자동화)

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

명령 팔레트에는 한국어 UI에서 `한글 (English)`(예: `실험 생성 (Create experiment)`)로, 영어 UI에서는 영문 이름(괄호 안)만 표시되며, 한국어 UI에서는 한글·영문 어느 쪽으로도 검색됩니다.

| 명령어 | 하는 일 |
| --- | --- |
| 날짜 삽입 (`Insert date`) | 커서 위치에 오늘 날짜를 넣습니다(머리말과 `#### Meta`에서는 값이 빈 줄만 채움, 표 칸에서도 됨) |
| 날짜 및 시간 삽입 (`Insert date and time`) | 커서 위치에 현재 타임스탬프를 넣습니다 |
| 실험 생성 (`Create experiment`) | 새 `.labnote.md` 실험 노트와 번호가 붙은 실험 폴더를 만듭니다 |
| 실험 상태 변경 (`Change experiment status`) | 실험의 `status` frontmatter를 피커로 바꿉니다(워크플로 뷰의 실험 우클릭에도 있음) |
| 논의 표시 전환 (`Toggle discussion flag`) | 실험의 `discuss` 표시를 켜고 끕니다 — 다음 push 때 GitHub Issue 생성 |
| 논의 이슈 마커 삽입 (`Insert issue marker`) | 커서 위치에 `@issue;<ID>;<주제문장>` 마커를 넣습니다 — 마커마다 별도 Issue |
| 워크플로 생성 (`Create workflow`) | 카탈로그에서 골라 번호가 매겨진 워크플로 노트를 만들고 체크리스트에 등록합니다 |
| 워크플로 번호 다시 매기기 (`Renumber workflows`) | 실험 폴더의 워크플로 번호를 README 체크리스트 순서대로 001부터 빈틈없이 다시 매깁니다 |
| 폴더와 워크플로 체크리스트 맞추기 (`Sync workflow checklist with folder`) | 옮겨 오거나 복사한 워크플로를 체크리스트에 맞추고, 어긋난 라벨·제목·실험자를 확인 후 고칩니다 |
| 유닛 오퍼레이션 삽입 (`Insert unit operation`) | 카탈로그에서 고른 유닛 오퍼레이션을 워크플로 노트에 넣고 목차를 갱신합니다 |
| 카탈로그 업데이트 (`Update catalogs`) | 보관함의 `resources/workflows/` 카탈로그를 이 플러그인 버전에 맞춥니다(연구실이 고친 값은 그대로) |
| 표 CSV 내보내기 (`Export tables to CSV`) | 노트의 표를 `<노트이름>.labnote_tableN.csv`로 내보냅니다(엑셀 호환 UTF-8 BOM) |
| 연구노트 자동화 설정 (`Setup research automation`) | GitHub Actions·스크립트를 현재 보관함에 설치합니다([연구노트 자동화](#연구노트-자동화) 참고) |
| AI: Method 섹션 초안 (`AI: Draft Method section`) | 설정된 LLM으로 유닛 오퍼레이션의 `#### Method` 초안을 씁니다 |
| AI: 워크플로 결과 요약 (`AI: Summarize workflow results`) | 워크플로 노트의 결과 절을 요약해 `Conclusions and Discussion` 끝에 콜아웃으로 넣습니다 |
| AI: 실험 결과 요약 (`AI: Summarize experiment results`) | 실험 README에서 모든 워크플로 노트의 결과를 요약해 `Summary and Discussion` 끝에 넣습니다 |
| AI: 샘플 정의 추출 (`AI: Extract sample definitions`) | 노트 본문에서 샘플을 찾아 대장에만 등록합니다(본문은 바꾸지 않음) |
| AI: 어시스턴트에게 요청 (`AI: Ask assistant (uses tools)`) | 목표를 말하면 모델이 Labnote 툴로 수행합니다 — 보관함 수정 전 매번 확인 |
| MCP 서버 토글 (`Toggle MCP server`) | 로컬 MCP 서버를 켜고 끕니다([Copilot 가이드](docs/COPILOT.md#선택-labnote-툴-연결--mcp) 참고) |
| 워크플로/샘플 뷰 열기 (`Open workflow view` / `Open sample view`) | 사이드바 뷰를 표시하고 포커스를 목록으로 옮깁니다 |
| 샘플 정의 열기 (편집·이동·삭제) (`Open sample definition`) | 커서 위 샘플이나 검색해 고른 샘플의 정의 창을 엽니다(편집·삭제·이동·타입 변경) |
| 이 실험의 시료 목록 삽입 (`Insert sample list of this experiment`) | 이 실험의 시료를 Markdown 표로 커서 위치에 넣습니다 |
| partbank 카탈로그 내려받기 (`Download partbank catalog`) | partbank의 내 항목을 전역 샘플 폴더의 제품 카탈로그 파일로 받습니다 |
| partbank에서 보관 위치 일괄 갱신 (`Refresh storage locations from partbank`) | partbank와 연결된 시료의 보관 위치를 한꺼번에 다시 읽어 확인 후 저장합니다 |
| 노트 바코드 보기 (`Show note barcode`) | 노트의 ID와 QR을 창으로 보여 줍니다(ID가 없으면 먼저 발급) |
| 노트 ID 발급 (`Assign note ID`) | ID가 없는 노트에 `labnote_id`를 발급합니다 |
| 실험 기록지 출력 (`Print experiment worksheet`) | 고른 유닛 오퍼레이션을 페이지마다 QR이 찍힌 기록지로 출력합니다(A4/Letter) |
| 노트 전체를 바코드와 함께 출력 (`Print whole note with barcodes`) | 노트 전체를 페이지로 나눠 페이지마다 QR을 넣어 출력합니다 |
| 스캔 가져오기 (`Import scanned pages`) | 사진·PDF·zip을 끌어다 놓아 QR로 노트에 붙이고 결과 창을 보여 줍니다 |
| 스캔 폴더 지금 처리 (`Process scan folder now`) | 설정한 PC 스캔 폴더를 기다리지 않고 바로 처리합니다(데스크톱 전용) |
| 미인식 스캔 할당 (`Assign unmatched scans`) | QR을 읽지 못한 페이지를 썸네일로 보고 노트·유닛 오퍼레이션을 골라 붙입니다 |
| 사용법 열기 (`Open user guide`) | 연구원용 퀵스타트(`QUICKSTART.md`)를 열고, 없거나 오래됐으면 이 버전으로 만들거나 바꿉니다 |

> **각 명령의 자세한 동작**(삽입 위치 규칙, 확인 창, 파일 이름·번호·복사본 처리, 예외 상황)은
> **[QUICKSTART](automation/templates/QUICKSTART.md)** 에 있습니다. 특히
> [명령 찾는 법](automation/templates/QUICKSTART.md#명령-찾는-법)(영/한 대응표),
> [팔레트에 없는 기능](automation/templates/QUICKSTART.md#팔레트에-없는-기능-우클릭--클릭-전용)(우클릭 전용),
> [실험 폴더의 구조](automation/templates/QUICKSTART.md#실험-폴더의-구조),
> [기록하기](automation/templates/QUICKSTART.md#기록하기)(워크플로 노트 이름 바꾸기·옮기기·복사본),
> [샘플 다루기](automation/templates/QUICKSTART.md#샘플-다루기),
> [자주 겪는 문제](automation/templates/QUICKSTART.md#자주-겪는-문제)를 보세요.

## 연구노트 자동화

노트 자체를 넘어, labnoteo는 보관함을 GitHub 위의 경량 연구노트 시스템으로 바꿔 줍니다 — 노트 검증, Experiment ↔ Issue 연결, Living-Manuscript Wiki를 CI를 직접 작성하지 않고도 구성합니다. 명령 팔레트에서 **연구노트 자동화 설정**(`Setup research automation`)을 실행하면 아래 자산을 현재 보관함에 프로비저닝합니다.

- **대용량 파일 보호** — `.labnoteo/scripts/check-large-files.mjs` + pre-commit 훅 + `.gitignore`로 커밋 전 과대 파일 차단.
- **검증** — `validate.mjs` + `validate.yml`. push마다 `status` 값·실험 id 중복·노트 ID(`labnote_id`) 중복·`@issue` 마커 형식과 폴더 내 ID 유일성 검사.
- **Experiment ↔ Issue** — `issue-sync.mjs` + `experiment-issues.yml`. `discuss: true`/`status: needs-review` 실험은 스레드 이슈 1개, 폴더 내 모든 `*.labnote.md`의 `@issue` 마커는 각각 별도 이슈. 결정적·멱등.
- **AI 에이전트 규칙** — `AGENTS.md`/`CLAUDE.md`. 로컬 AI 에이전트를 위한 git·커밋·이슈 신호·Wiki 초안 규칙.
- **Living-Manuscript Wiki(선택)** — `wiki-sync.yml`. 사람이 검토·머지한 `wiki-staging/` 초안을 GitHub Wiki로 발행.

번들 스크립트는 **무의존성** Node ESM이라 보관함에서 `npm install`이 필요 없습니다. 서버측 자동화는 전부 **결정적**이라 GitHub-hosted 러너만으로 동작하고, "이 노트에 논의가 필요한가?" 같은 AI 판단은 **로컬 AI 에이전트**가 `AGENTS.md` 규칙에 따라 수행합니다 — 이슈 생성/Wiki 발행은 서버가 단독 담당하므로 중복이 없습니다. 자동화는 **노트를 되쓰지 않으며**, `status` 변경과 과학적 판단은 사람의 몫입니다.

**업데이트** — 플러그인을 업데이트하면 Obsidian을 켤 때 설치된 파일을 새 버전에 맞추고, 바꾼 파일을 알려 줍니다. 파일 종류마다 처리가 다릅니다.

- **직접 고치지 않은 파일**(`.labnoteo/` 스크립트·`SETUP.md`, `.github/` 워크플로 등) — 그대로 교체합니다.
- **`AGENTS.md` · `QUICKSTART.md`** — 관리 블록(`<!-- BEGIN labnoteo (managed) -->`~`END`)만 바꿉니다. 블록 안을 직접 고쳤다면 자동으로 바꾸지 않고 목록에 올리며, *연구노트 자동화 설정*을 다시 실행하면 바꿀지 묻습니다.
- **`.gitignore` · `CLAUDE.md`** — 빠진 줄만 더합니다.
- **직접 고친 파일과 보관함에 없는 파일** — 건드리지 않고 목록만 알려 줍니다(새 버전마다 한 번). 그때 *연구노트 자동화 설정*을 다시 실행하세요.
- **`wiki-staging/` 초안** — 자동으로 바꾸지 않습니다.

파일마다 어느 템플릿과 맞췄는지는 `.labnoteo/installed.json`에 기록되니 함께 커밋하세요. 이 기록이 없는 보관함(0.95.0 이전 버전으로 설치)도 이전 버전이 만든 그대로인 파일과 `.labnoteo/scripts/*.mjs`는 자동으로 갱신됩니다. 서버 동작은 갱신된 파일을 커밋·push해야 바뀝니다.

`QUICKSTART.md`의 연구실 규칙은 관리 블록 **아래**에 적으면 업데이트 뒤에도 남습니다. 0.99.0 이전에 만든 `QUICKSTART.md`는 고치지 않았으면 켤 때 자동으로 이 형식으로 바뀝니다. 직접 고쳤다면 목록에만 오르고, *연구노트 자동화 설정*을 다시 실행해 승인하면 새 형식으로 바뀝니다(이때 고친 내용은 사라지니 먼저 따로 옮겨 두세요).

**첨부 파일 위치** — *연구노트 자동화 설정*을 마친 뒤 Obsidian의 새 첨부 파일 위치가 기본값(보관함 맨 위)이면 `./images`(노트 옆 images 폴더, 랩노트라면 실험의 `images/`)로 바꿀지 묻습니다. Obsidian 설정 → 파일 및 링크 → 새 첨부 파일의 기본 위치를 바꾸는 것과 같습니다.

전체 자산 표·전제 조건·백필 절차는 설치 후 보관함에 생기는 관리자 문서 `.labnoteo/SETUP.md`를, 일상 사용법은 `QUICKSTART.md`를 참고하세요. `AGENTS.md`는 [Copilot과도 공유](docs/COPILOT.md#agentsmd-공유-규칙)됩니다.

## 설정

**샘플**

- **샘플 추적**: 자동완성·하이라이트·`{Type}.json` 대장 기록 사용 여부(다시 불러와야 적용). 실험 README 머리말에 `sample_tracking: 'no'`를 두면 그 실험의 노트에서만 끕니다.
- **사용자 정의 샘플 타입**: 내장 타입 외에 사용자 정의 타입 추가. 한글 타입(`배지`)도 `@배지` 자동완성이 됩니다. 글자·숫자·`_`만 쓸 수 있고, 공백·`-`가 들었거나 기존 타입과 대소문자만 다른 이름은 저장되지 않습니다. `_`는 영문자·숫자 사이에서만 쓰세요(`Cell_Line`). 한글 옆의 `_`는 읽기 화면에서 이름을 기울임으로 보이게 해 저장되지 않고 붙여 쓴 이름(`무세포용해물`)을 알려 줍니다.
- **전역 샘플 폴더**: 보관함 전역 샘플 저장소 폴더 (기본 `resources/labsamples`). 폴더를 바꾸고 설정 창을 닫았을 때 옛 폴더에 샘플이 남아 있으면 새 폴더로 옮길지 묻습니다.

자세한 동작은 [샘플 다루기](automation/templates/QUICKSTART.md#샘플-다루기)를 보세요.

**partbank**

- **partbank 서버** / **partbank 데스크톱 앱**: 각각 주소와 API 키, `연결 확인` 버튼. 키는 보관함이 아니라 이 PC에만 저장되므로 PC마다 적어야 합니다. 데스크톱 연결은 모바일에서 보이지 않습니다.
- **검색할 연결**: 자동완성 검색과 카탈로그 내려받기가 쓸 연결(기본 `partbank 서버`). 데스크톱 앱으로 만든 링크는 그 PC에서만 통하므로 함께 쓰는 보관함은 서버를 쓰세요.

자세한 동작은 [partbank에서 부품 가져오기](automation/templates/QUICKSTART.md#partbank에서-부품-가져오기)를 보세요.

**워크플로**

- **유닛오퍼레이션 TOC 자동 정렬** (`Auto-sync unit operation TOC`): 편집 후 워크플로 노트의 `Related Unit Operations` 목록을 헤딩 순서에 맞게 자동 정렬합니다. 끄면 순서만 그대로 두고 이름·링크는 계속 맞춥니다. 목차 링크는 GitHub에서 노트를 볼 때 해당 블록으로 이동하도록 GitHub 앵커 규칙을 따릅니다(Obsidian 안에서는 Outline 보기를 쓰세요). 기본 켜짐.
- **마지막 갱신일 자동 기록** (`Auto-update last updated date`): 연구노트(`*.labnote.md`)를 고치면 frontmatter의 `last_updated_date`를 오늘 날짜(서울 기준)로 바꿉니다. 노트마다 하루에 한 번만 바뀌고, 워크플로 노트를 고치면 그 실험의 README 날짜도 함께 바뀝니다. git pull로 받아온 변경과 자동 정리는 반영하지 않습니다. 기본 켜짐.

**바코드와 스캔**

- **기록지 용지 크기**: A4 또는 Letter(기록지 출력 창에서도 바꿀 수 있음).
- **스캔 폴더** · **스캔 폴더 방식**(데스크톱 전용): 사진·스캔이 들어오는 PC 폴더와 처리 방식(**전용 폴더** / **공유 폴더**). 이 값은 보관함 설정과 함께 동기화되지 않고 **PC별·보관함별로** 저장되므로 한 PC에서만 지정하세요.
- **미인식 스캔**: 할당을 기다리는 페이지 수와 **미인식 스캔 할당** 버튼.
- **저장할 스캔 크기** · **저장할 스캔 화질** · **노트에 보이는 스캔 폭**: 저장 전 긴 변(기본 2400px), JPEG 화질(기본 85%), 노트에 들어가는 썸네일 폭(기본 200px, 0이면 원본 크기).
- **Slack으로 스캔 받기(선택)**: 내 Slack 봇에게 DM으로 보낸 사진을 받아 처리합니다. 토큰은 이 PC에만 저장되며, 연결은 PC 한 대에만 하세요.

각 설정의 자세한 동작과 입력 경로별(Google Drive·카카오톡·OneDrive·이메일·복합기·Slack) 방법은 [출력본 스캔 가이드](docs/SCAN.md)를 보세요. `_labnote-scans/`(미인식 대기열)는 연구노트 자동화의 `.gitignore`가 커밋에서 뺍니다 — 기존 보관함은 플러그인 업데이트 후 *연구노트 자동화 설정*을 다시 실행하면 반영됩니다.

**AI 프로바이더**

- **프로바이더**: `비활성화됨`, `ollama`, `openai`. 플러그인이 제공자와 직접 통신합니다.
- **Ollama 엔드포인트** / **OpenAI 엔드포인트**: 기본 URL. 제공자를 바꿀 때 OpenAI 키가 로컬 Ollama 주소로 새어 나가지 않도록 필드를 분리해 두었습니다. `localhost:11434`처럼 `http://`·`https://`를 빼고 적으면 접속할 때 `http://`를 붙입니다.
- **모델**: 모델 id. 예: `qwen3`, `gpt-4o-mini`.
- **API 키**: OpenAI 호환 제공자 전용 — Ollama로는 전송되지 않습니다.

AI 요청이 실패하면 알림이 원인과 고칠 설정을 알려 줍니다: 서버에 연결할 수 없으면 엔드포인트, 401/403이면 API 키, 모델을 찾을 수 없으면 모델, 그 밖의 404면 엔드포인트 경로(`/v1`·`/api` 없이 서버 주소만), 엔드포인트가 `http://`·`https://` 주소가 아니면(`htp://` 같은 오타) 적는 방법을 알려 줍니다. 원래 오류는 개발자 콘솔(Ctrl+Shift+I, macOS는 Cmd+Option+I)에 남습니다.

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
