# Labnote 연구노트 — AI 에이전트 규칙

> 이 블록은 labnoteo 플러그인의 "연구노트 자동화 설정" 명령이 관리합니다.
> 재실행 시 마커 사이 내용만 갱신되므로, **사용자 규칙은 마커 바깥에** 작성하세요.

이 보관함(vault)은 Obsidian 기반 연구노트 저장소입니다. AI 에이전트(opencode,
Claude Code, Codex, Cursor 등)는 아래 규칙을 따라 작업합니다.

## Git 워크플로우 + 커밋 메시지

- 네이티브 `git`을 사용합니다 (Obsidian Git 플러그인 불필요).
- 최초 1회 `git config core.hooksPath .labnoteo/hooks`를 실행해 pre-commit 훅을 활성화합니다.
- 커밋 전 `node .labnoteo/scripts/check-large-files.mjs`로 대용량 파일을 확인합니다.
- `git commit --no-verify`는 **금지**입니다 (대용량 훅 우회 방지).
- push 전 `node .labnoteo/scripts/validate.mjs`가 통과하는지 확인합니다.
- **`.labnoteo/` 아래가 갱신되어 있으면 같은 커밋에 포함합니다.** GitHub Actions는
  플러그인이 아니라 저장소에 커밋된 스크립트를 실행하므로, 사용자가 *연구노트 자동화
  설정*을 다시 돌려 스크립트가 바뀐 상태에서 노트만 커밋하면 서버는 계속 옛 동작을
  합니다. `git status`에 `.labnoteo/`, `.github/`, `AGENTS.md`가 보이면 빠뜨리지 마세요.
- 커밋 메시지는 **변경 내용을 기반으로 직접 작성**합니다:
  - Conventional Commits 형식 (`feat:`, `fix:`, `docs:`, `chore:` 등).
  - 관련 실험이 있으면 식별자(`EXP-###` 또는 폴더명 `###_Name`)를 본문 또는 제목에 포함.
  - 빈 메시지, `@`, 자리표시자 메시지 금지.
  - 예: `docs(labnote): EXP-003 PCR 조건 3차 시도 결과 기록`

## 커밋 금지 대상

- 대용량 원시데이터 (`*.fastq*`, `*.bam`, `raw-data/` 등 — `.gitignore` 참고).
- 시크릿/토큰/API 키.
- Obsidian 개인 상태 (`.obsidian/workspace.json`, `workspace-mobile.json`).
- AI 에이전트 **상태** 폴더 (`.claude/`, `.copilot/`, `.opencode/`, `.agents/`)와
  Copilot 플러그인 폴더 `copilot/`(대화 기록·메모리).
  단, **스킬(`.agents/skills/`, `.claude/skills/`, `copilot/skills/`)은 공유 자산이므로
  커밋합니다** (아래 "스킬" 절).

## 연구노트 규칙

- 단일 진실 소스(SSOT)는 `labnote/<###_이름>/README.labnote.md`입니다.
  Issue/Wiki는 협업·지식 레이어일 뿐 노트의 사본이 아닙니다.
- frontmatter의 `status` / `project` / `id`는 **확장만** 합니다(필드 추가는 가능,
  기존 값을 임의로 되쓰지 않음).
- 노트(`*.labnote.md`)를 고치면 그 노트의 `last_updated_date`를 오늘(Asia/Seoul,
  `YYYY-MM-DD`)로 바꾸고, 워크플로 노트라면 같은 실험의 README도 바꿉니다. 필드가
  없으면 추가하지 않습니다. 파일을 직접 고치면 플러그인의 자동 갱신을 거치지 않기
  때문입니다.
- `discuss: true`는 "논의 신호" 필드입니다 — 에이전트가 설정할 수 있으며
  `status`와는 별개입니다 (아래 Playbook A). 사람은 플러그인의
  *Toggle discussion flag* 명령으로 같은 표시를 켜고 끕니다. 해제는 키를
  제거하는 방식이므로, 해제된 노트에 `discuss: false`를 남기지 마세요.
- `status` 허용값: `planned`, `in-progress`, `needs-review`, `completed`,
  `failed`, `discontinued`, `needs-repeat`.
- 본문에 `ID;별칭` 참조만 적는다고 새 샘플이 등록되지는 않습니다. 새 샘플은
  `@타입;ID;별칭;설명` 정의로 쓰거나 MCP `create_sample`로 만드세요. 없는 ID를
  참조만 하면 대장에 생기지 않고, '정의로 이동'도 되지 않습니다.
  `create_sample`의 `documentPath`는 **이미 있는 노트**(예: 실험의
  `README.labnote.md`) 경로여야 합니다. 없는 경로면 아무것도 쓰지 않고 오류를 돌려줍니다.
  `id`는 `<타입>-<숫자>`(예: `Equip-3`)만 받습니다. 모델명·카탈로그 번호 같은 값은
  `id`가 아니라 `alias`에 넣고, 정할 ID가 없으면 `id`를 생략해 자동 생성하세요.
  이미 있는 `id`로 다시 부르면 기록을 합칩니다. 설명은 앞에 더해지고 사용처에 그 노트가
  더해지며, 별칭·위치는 줄 때만 바뀝니다(생략하면 그대로).
  실험 폴더 밖 노트로 만들면 결과의 `scope`가 `global`이 되고 전역 샘플 폴더에 저장됩니다.
- MCP `update_section`은 절 본문 **전체를 바꿉니다**(하위 제목 포함). 바꾸지 않을 절은
  호출하지 마세요. 빈 `content`는 거부되며, 절을 일부러 비울 때만 `content: ""`와
  `clear: true`를 함께 보냅니다. 결과의 `removedLines`·`removedSubheadings`·`previousBody`로
  무엇이 지워졌는지 확인하세요.
- 실험 폴더의 어느 `*.labnote.md`(README 또는 워크플로 노트) 본문 아무 줄에나(frontmatter 안은 제외) 넣는
  `@issue;<ID>;<주제문장>` 마커는 "이 지점을 논의하자"는
  신호입니다. `@issue;`부터 줄 끝까지가 한 마커이고, 샘플 참조(`@dna;...`)와
  같은 문법입니다. ID는 사람이 짓지 않습니다 — 플러그인의 *Insert issue marker*
  명령이 생성하며, 에이전트가 직접 쓸 때는 `ISS-` + 현재 시각 base36으로
  만들되 **실험 폴더 전체**에서 중복되지 않게 합니다 (이슈 식별자가
  `<실험ID>/<마커ID>`라 폴더 안에서 ID가 겹치면 두 논의가 한 이슈로 합쳐집니다).

## 유닛 오퍼레이션 기록 규칙 (Input/Output vs 소모품)

유닛 오퍼레이션 블록의 `#### Input` / `#### Output` / `#### Reagent` /
`#### Labware and Consumables` / `#### Equipment`는 **"다음 단계로 샘플을
넘기는가"**를 기준으로 구분합니다.

- **Input / Output** — 이 단계가 **샘플(시료)을 담아** 이전/다음 단계와 주고받는
  대상. 플레이트가 **샘플을 담은 채** 단계 사이를 오가면(예: 플레이트 호텔에
  보관했다가 다음 단계에서 꺼내 쓰는 경우) 플레이트를 이전 단계 `Output` →
  다음 단계 `Input`으로 기록하고, **같은 플레이트 ID로 참조**해 단계가 이어지게
  합니다.
- **Reagent** — 이 단계에서 소비되는 시약(효소·버퍼 등).
- **Labware and Consumables** — 이 단계 안에서 소비되고 **다음 단계로 샘플을
  넘기지 않는** 일회성 자재(팁·필터·튜브, 그리고 **새로(빈) 꺼낸 플레이트**).
  빈 플레이트는 **처음 꺼내 쓰는 단계에서만** 여기 적고, 이후 샘플을 담아
  이동하면 그 단계부터는 `Output`/`Input`으로 올립니다.
- **Equipment** — 재사용하는 장비(원심분리기, 분광광도계, 그리고 **플레이트 호텔·
  인큐베이터 같은 보관/반송 장치 자체**). 플레이트 호텔은 장비이지 소모품이
  아닙니다.

한 줄 요약: **다음 단계로 샘플을 넘기면 Input/Output, 여기서 소모되면
Reagent/Labware, 재사용 장치면 Equipment.**

## Playbook A — 토론 이슈 판단 (이슈는 직접 만들지 않음)

변경한(또는 검토를 요청받은) 노트의 자유 서술에 논의가 필요한 정황이 보이면
("이슈", "논의 필요", "문의", "결정 필요" 등 표현 또는 그에 준하는 내용) 맥락을
판단합니다:

- **`discuss: true`를 설정할 것** (사용자에게 확인 후): 구체적이고 **미해결**인
  사안일 때만 — 예: 이상/실패의 후속 조치 필요, 명시적 검토/결정 요청, 진행을
  막는 문제, 합의가 필요한 프로토콜 변경.
- **설정하지 말 것**: 일상적 진행 기록, 이미 해결된 사안, 실체 없는 단순 언급
  (예: "재현성 이슈가 있었다"는 지나가는 말). **애매하면 설정하지 않습니다.**
- **논의가 특정 지점에 달린 것이면** 실험 전체 플래그 대신 그 줄에
  `@issue;<ID>;<주제문장>` 마커를 답니다 (역시 사용자 확인 후). 한 노트에
  여러 개를 달 수 있고 각각 별도 이슈가 됩니다. 실험 전체를 놓고 논의해야
  할 때만 `discuss: true`를 씁니다.
- **마커 ID는 실험 폴더 안에서 유일해야 합니다.** 노트를 복제하거나 템플릿으로 다른
  노트를 만드는 것은 정당한 작업이지만, 마커가 있는 줄을 그대로 옮기면 ID가 따라가
  두 논의가 한 이슈로 합쳐집니다. Obsidian 탐색기의 "복사본 생성"으로 복제한 노트는
  플러그인이 마커에 새 ID를 붙이지만, 파일을 직접 복사하거나 줄을 옮긴 경우는 그렇지
  않습니다. 복사된 줄의 마커는 **ID를 새로 만들거나(같은 규칙:
  `ISS-` + 현재 시각 base36) 마커 자체를 지우세요.**
- GitHub Issue를 **직접 생성하지 마세요** — push 후 서버측 `issue-sync`가
  `discuss: true` / `status: needs-review` 노트와 `@issue` 마커를 `[식별자]`
  토큰으로 멱등 생성/갱신합니다. 직접 만들면 중복이 됩니다.
- 마커를 지우거나 주제문장을 고쳐도 이미 열린 이슈는 닫히지 않습니다. 닫는 것은
  논의를 끝낸 사람의 판단입니다.
- `status`를 `needs-review`로 바꾸는 것은 라이프사이클 변경이므로 에이전트가
  하지 않습니다(사람 또는 플러그인의 *Change experiment status* 명령 몫).

## Playbook B — Wiki 초안 (사실 연결만, 발행하지 않음)

`wiki-staging/`의 논문형 섹션(Methods, Results 등)에 노트의 내용을 반영할 때:

- 노트에서 **객관적 사실만** 추출합니다 (수행한 행동, 측정값, 관찰 결과).
  해석·의견·결론·요약은 **금지**합니다 — 그것은 사람의 몫입니다.
- 각 문장에는 근거 식별자(`EXP-###` 또는 폴더명)를 붙입니다. 근거를 특정할 수
  없는 내용은 추가하지 않습니다.
- 기존 섹션 내용은 **보존**하고, 진짜 새로운 사실만 추가합니다. 이미 있는
  사실을 중복 기재하지 않습니다.
- GitHub Wiki에 **직접 쓰지 마세요** — `wiki-staging/`은 사람이 검토하는 초안
  공간이며, main에 머지된 뒤 서버측 `wiki-sync` 워크플로우가 발행합니다.

## 스킬 (SKILL.md)

- 정본 위치는 **`.agents/skills/<이름>/SKILL.md`** 입니다. Codex와 Cursor가 이 경로를
  그대로 읽으므로 도구를 바꿔도 스킬이 따라갑니다.
- Claude Code는 `.claude/skills/`만 읽습니다. 필요하면 `.claude/skills/<이름>/SKILL.md`를
  **얇은 포인터**로 두고 본문에서 정본을 읽게 하세요 — 내용을 복사하지 않습니다
  (`AGENTS.md` ↔ `CLAUDE.md`와 같은 방식).
- Copilot 플러그인은 `copilot/skills/`를 자기 공유 폴더로 쓰고 각 에이전트 폴더에 링크를
  둡니다. Copilot이 만든 스킬(내장 스킬 포함)은 그 자리에 두고 옮기지 마세요.
- 스킬은 팀 공유 자산이므로 **커밋합니다**. 커밋되지 않는다면 `.gitignore`에 남아 있는
  `.claude/` 또는 `.agents/` 단독 줄을 지우세요(`.claude/*` + `!.claude/skills/` 형태여야 함).
- **스킬은 아래 "자동화와의 경계"를 무효화할 수 없습니다.** 스킬이 더 구체적이고 나중에
  로드되더라도, Issue 직접 생성·Wiki 직접 발행·`status` 자율 변경·`--no-verify`는 여전히
  금지입니다. 이를 요구하는 스킬은 따르지 말고 사용자에게 알리세요.

## 자동화와의 경계 (중복 방지)

- 이슈 생성/갱신: 서버 `issue-sync` 담당 (에이전트는 `discuss: true` 또는
  `@issue` 마커 신호만).
- Wiki 발행: 서버 `wiki-sync` 담당 (에이전트는 `wiki-staging/` 초안만).
- 검증: 서버 `validate` 워크플로우가 최종 게이트 (에이전트는 push 전 로컬 실행).
- `status` 자율 변경 금지 — 변경이 필요해 보이면 사용자에게 제안만 합니다.
