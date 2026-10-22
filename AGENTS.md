# labnoteo 개발 저장소 — 에이전트 규칙

여기는 **Labnote Assistant(Obsidian 플러그인)의 개발 저장소**입니다. 연구 데이터를
담는 보관함(vault)이 아닙니다. 보관함에 설치되어 노트 작성·git·이슈·Wiki를 다루는
연구원용 규칙은 [`automation/templates/AGENTS.md`](automation/templates/AGENTS.md)에
따로 있으며, 이 파일과 **별개**입니다. 이 저장소에서 작업할 때는 그 보관함 규칙
(예: `@issue` 마커, `discuss` 플래그, `.labnoteo/hooks` 커밋 훅, 서버 issue-sync)을
적용하지 마세요.

## 저장소 구조 (요약)

- `src/` — Obsidian 플러그인. esbuild로 루트 `main.js`로 번들.
- `packages/labnoteo-core/` — 플랫폼 중립 core (파서·도메인). Node 전용 API 금지.
- `automation/` — 보관함에 설치되는 자동화 스크립트·템플릿의 소스. esbuild가
  `dist-automation/*.mjs`로 번들하고 워크플로/`AGENTS.md`/`QUICKSTART.md`/`SETUP.md`/
  Wiki 템플릿과 함께 `main.js`에 **문자열로 임베드**합니다.
- `docs/` — 사용자용 문서. 한국어는 `INSTALL.md`·`COPILOT.md`·`SCAN.md`, 영어는
 `INSTALL.en.md`·`REFERENCE.en.md`. 저장소 루트 `README.md`(한)·`README.en.md`(영)가
 진입점이고 **요약만** 담습니다.
- `references/` — 설계 아카이브. 어떤 사용자 문서에서도 링크하지 않으며 빌드·배포와 무관합니다.
- `help/` — 도움말 사이트와 기능 영상. `help/site/`(한/영 정적 페이지, `media/`의 영상과
 `manifest.json`)는 [`.github/workflows/pages.yml`](.github/workflows/pages.yml)이 GitHub
 Pages로 배포하고, `help/demos/*.yaml`(영상 대본)·`help/seeds/`(영상 시작 상태)는 testpilotO가
 영상을 녹화할 때 읽습니다. 플러그인 빌드·테스트·릴리스와는 무관합니다. 자세한 것은
 [`help/README.md`](help/README.md).

## 문서 최신화 (중요)

기능·설정·명령·설치 절차가 바뀌면 아래를 **같은 변경 단위**로 갱신합니다.

1. **한/영 동시 갱신** — [`README.md`](README.md)와 [`README.en.md`](README.en.md)는
 항상 짝으로 수정합니다. 한쪽만 고치지 마세요. 도메인/포지셔닝 문구는 **한국어를
 기준**으로 맞춥니다. 설치 절차도
 [`docs/INSTALL.md`](docs/INSTALL.md)·[`docs/INSTALL.en.md`](docs/INSTALL.en.md)가 짝입니다.
   - **명령·동작 세부는 참조 문서를 짝으로 고칩니다.** 세부 정본은 한국어가
     [`automation/templates/QUICKSTART.md`](automation/templates/QUICKSTART.md),
     영어가 [`docs/REFERENCE.en.md`](docs/REFERENCE.en.md)입니다. 한쪽만 고치면 두 언어의
     설명이 갈라집니다. QUICKSTART는 템플릿이라 고치면 아래 4번(재임베드)이 따라붙지만
     REFERENCE.en.md는 평범한 문서라 갱신 경로가 다르다는 점에 주의하세요.
   - **README에 세부를 다시 쌓지 마세요.** README 한/영은 명령마다 **목적 한 문장**,
     기능마다 2~3문장까지입니다. 삽입 위치 규칙·확인 창·파일 이름/번호/복사본 처리 같은
     동작 설명은 위 참조 문서에 적고 README에서는 링크만 겁니다. 릴리스마다 README 표
     한 칸에 문장을 덧붙인 것이 과거 비대화의 원인이었습니다.
2. **UI 문자열은 실제 라벨 그대로** — 설정·명령 이름은 [`src/settingsTab.ts`](src/settingsTab.ts)/
   [`src/l10n.ko.ts`](src/l10n.ko.ts)의 실제 문자열을 확인해 옮깁니다(추정 금지).
3. **사용자 문서** — 관련되면 [`docs/INSTALL.md`](docs/INSTALL.md)·
 [`docs/INSTALL.en.md`](docs/INSTALL.en.md)·[`docs/COPILOT.md`](docs/COPILOT.md)·
 [`docs/SCAN.md`](docs/SCAN.md)·[`docs/REFERENCE.en.md`](docs/REFERENCE.en.md)와,
 보관함에 설치되는 템플릿
   [`automation/templates/QUICKSTART.md`](automation/templates/QUICKSTART.md)·
   [`automation/templates/SETUP.md`](automation/templates/SETUP.md)·
   [`automation/templates/AGENTS.md`](automation/templates/AGENTS.md)도 함께 갱신합니다.
4. **템플릿을 고치면 반드시 재임베드** — `automation/templates/*`는 `main.js`에
   문자열로 박히므로 `npm run build` 없이는 사용자에게 도달하지 않습니다. 편집 후
   `npm run build`로 재임베드하고, 릴리스에 포함합니다. 기존 보관함 사용자는
   플러그인 업데이트 후 명령 팔레트 → `Setup research automation`을 다시 실행해야
   반영됩니다(문서에도 그렇게 안내).
5. **버전 배지 동기화** — 버전은 루트 [`package.json`](package.json)에서 올린 뒤
   `npm run sync:versions`로 `manifest.json`·`versions.json`·README 배지
   (`**버전 x.y.z**` / `**Version x.y.z**`)까지 전파합니다. CI는
   `npm run sync:versions -- --check`로 검증하므로, 배지 형식을 임의로 바꾸지 마세요.
6. **외부 정보는 웹으로 재확인** — 설치/Copilot 문서를 손댈 때 Obsidian 버전,
   BRAT 명령 이름, Copilot 버전(현재 V4)·Claude Code 최소 버전·`codex-acp` 최소
   버전을 최신 자료로 확인하고 반영합니다.
7. **링크·상호참조 점검** — 한/영 헤딩 앵커, `docs/` 상호 링크, `INSTALL.md`의
 단계 번호 참조가 어긋나지 않는지 육안 확인합니다. 도움말 사이트는 QUICKSTART·README
 헤딩 앵커로 링크하므로, 그 헤딩을 바꾸면 `help/site`의 링크도 고칩니다.
8. **도움말 사이트와 영상** — 기능이나 UI 문구가 바뀌면 `help/demos/`의 해당 대본을 같이
 고치고 그 영상을 testpilotO로 다시 녹화합니다(`npm run demo -- <id>`). 오래된 영상은
 `help/site/media/manifest.json`의 `version`으로 찾습니다. `help/site/index.html`(한)과
 `help/site/en/index.html`(영)은 README처럼 짝으로 고칩니다. 명령 팔레트 표기(한국어 UI의
 `한글 (English)`)가 바뀌면 사이트의 명령 표기도 같이 고칩니다.

## 빌드·검증·커밋

- 코드 변경 후: `npm run typecheck`, `npm test`, 필요 시 `npm run build`.
- 템플릿/버전 변경 후: `npm run build` + `npm run sync:versions -- --check`.
- 커밋 메시지는 Conventional Commits(`feat:`, `fix:`, `docs:`, `chore:` 등).
  문서·템플릿 폴리시는 `docs:`.
- 릴리스는 semver 태그로 트리거되는 [`.github/workflows/release.yml`](.github/workflows/release.yml)이
  담당하며, 태그 버전은 `manifest.json`과 일치해야 합니다.
