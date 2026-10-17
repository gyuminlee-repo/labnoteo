# 설치 가이드

[← README로 돌아가기](../README.md) · [English](../README.en.md)

Obsidian을 처음 깔 때부터 첫 push까지 **위에서 아래로 한 번만** 따라가면 됩니다.
각 단계 끝의 **✅ 확인**으로 제대로 됐는지 스스로 점검할 수 있습니다. 5번까지만
해도 노트 작성은 시작할 수 있고, 6번부터는 GitHub 자동화(검증·이슈·Wiki)를 쓸 때만
필요합니다.

> **왜 이 순서인가** — 세 가지 이유가 순서를 강제합니다.
> - **`.gitignore`(6단계)가 첫 push(8단계)보다 앞**: 대용량 원시데이터가 Git 이력에
>   한 번 박히면 이력 rewrite 말고는 되돌릴 방법이 없습니다. `.gitignore`는 *연구노트
>   자동화 설정*이 만들므로 git 연결을 그 뒤에 둡니다.
> - **훅 활성화가 첫 push(8단계)보다 앞**: 훅 없이 첫 커밋을 만들면 같은 사고가 납니다.
> - **AI 에이전트 연결(7단계)이 자동화 설정(6단계)보다 뒤·첫 push(8단계)보다 앞**: Agent
>   Chat이 보관함 루트 `AGENTS.md`를 지시문으로 읽으므로 규칙 파일이 생긴 뒤에 연결하고,
>   그래야 첫 커밋부터 에이전트에게 맡길 수 있습니다.

---

## 사전 준비

Obsidian 외에 **git**과 **GitHub 계정**이 필요합니다. GitHub 자동화(6단계 이후)를 쓰지
않고 노트만 쓸 거라면 건너뛰어도 됩니다.

- **git 설치** — 커밋·push의 기반이고, AI 에이전트도 이 git으로 커밋합니다.
  - Windows: [git-scm.com/download/win](https://git-scm.com/download/win)에서 **Git for
    Windows**를 설치합니다. 이것이 있어야 Claude Code의 Bash 툴도 동작합니다(없으면
    Claude Code는 PowerShell로 대체).
  - macOS: 터미널에서 `git --version`을 실행하면 미설치 시 설치를 안내합니다(또는
    Homebrew `brew install git`).
  - Linux: 배포판 패키지 매니저(`apt install git`, `dnf install git` 등).
- **GitHub 계정** — [github.com](https://github.com)에서 가입합니다. 저장소는 8단계에서
  만듭니다.

**✅ 확인** — 터미널(Windows는 PowerShell 또는 Git Bash)에서 `git --version`이 버전
번호를 출력합니다.

---

## 1. Obsidian 설치

[obsidian.md/download](https://obsidian.md/download)에서 운영체제에 맞는 설치본을
받아 설치합니다. Windows·macOS·Linux를 모두 지원합니다. 이 플러그인은 Obsidian
`1.5.0` 이상에서 동작하며, 최신 안정판(현재 1.14.x) 사용을 권장합니다. early
access(catalyst) 버전은 쓰지 않아도 됩니다.

**✅ 확인** — Obsidian이 실행되고 시작 화면이 보입니다.

## 2. 보관함(vault) 만들기

Obsidian에서 노트를 담는 **폴더 하나**가 곧 보관함입니다. 시작 화면에서
**Create new vault**(새 보관함 만들기)를 눌러 이름과 위치를 정하거나, 이미 쓰던
폴더가 있으면 **Open folder as vault**(폴더를 보관함으로 열기)로 엽니다.

> 이 보관함 폴더가 나중에 그대로 Git 저장소가 됩니다(8단계). 연구 데이터를 담을
> 것이므로 **개인/팀이 통제하는 위치**에 두세요.

**✅ 확인** — 왼쪽에 파일 탐색기가 있는 빈 보관함이 열립니다.

## 3. 커뮤니티 플러그인 켜기

외부 플러그인을 설치하려면 먼저 **제한 모드(Restricted Mode)**를 꺼야 합니다.

1. **설정**(Settings, 왼쪽 아래 톱니바퀴)을 엽니다.
2. 왼쪽 메뉴에서 **커뮤니티 플러그인**(Community plugins)을 고릅니다.
   - 설정 검색창(1.13+)에 `community`를 쳐서 바로 갈 수도 있습니다.
3. **커뮤니티 플러그인 켜기**(Turn on community plugins)를 누릅니다. 이것이 제한
   모드를 해제하는 동작입니다.

> 커뮤니티 플러그인은 파일·네트워크에 접근할 수 있습니다. 신뢰하는 제작자의
> 플러그인만 설치하세요.

**✅ 확인** — **탐색**(Browse) 버튼과 **설치된 플러그인** 목록이 나타납니다.

## 4. Labnote Assistant 설치

아직 Obsidian 공식 커뮤니티 목록에 없으므로 **BRAT**라는 설치 도우미 플러그인으로
GitHub 릴리스에서 받습니다. 보관함마다 한 번씩 해야 합니다(플러그인은
`.obsidian/plugins/`에 보관함 단위로 저장됩니다).

### 4-1. BRAT 설치

1. **커뮤니티 플러그인 → 탐색**(Browse)에서 `BRAT`를 검색합니다.
2. **Obsidian42 - BRAT**(제작자 TfTHacker)를 골라 **설치**(Install) → **활성화**(Enable).

### 4-2. BRAT로 Labnote Assistant 추가

1. 명령 팔레트(`Ctrl/Cmd + P`)에서
   **`BRAT: Plugins: Add a beta plugin for testing (with or without version)`**을
   실행합니다. `beta plugin`으로 검색하면 빨리 찾습니다. (옛 BRAT에서는
   `BRAT: Add a beta plugin for testing`로 보입니다.)
2. 저장소 칸에 `sblabkribb/labnoteo`(또는 전체 URL
   `https://github.com/sblabkribb/labnoteo`, 끝에 `/` 없이)를 입력합니다.
3. 버전은 **Latest version**으로 두고, **Enable after installing the plugin**
   (설치 후 활성화)이 체크된 채로 **Add Plugin**을 누릅니다.
4. 잠시 뒤 BRAT가 설치 완료를 알립니다. 필요하면 **설정 → 커뮤니티 플러그인**에서
   목록을 새로고침하고 **Labnote Assistant**가 켜져 있는지 확인합니다.

> BRAT는 이후 앱을 켤 때 자동으로 업데이트를 확인합니다(설정에서 끌 수 있음).
> 수동 갱신은 `Check for updates to all beta plugins and UPDATE` 명령으로 합니다.

<details>
<summary><b>BRAT 없이 수동 설치</b>(자동 업데이트 없음)</summary>

1. [릴리스](https://github.com/sblabkribb/labnoteo/releases)에서 `main.js`,
   `manifest.json`, `styles.css` 세 파일을 내려받습니다.
2. 보관함 안에 `.obsidian/plugins/labnoteo/` 폴더를 만들고 세 파일을 복사합니다.
3. 설정 → 커뮤니티 플러그인에서 **Labnote Assistant**를 활성화합니다.

릴리스의 `versions.json`은 Obsidian이 **저장소에서** 읽으므로 보관함에 복사할
필요가 없습니다. 보관함이 여러 개면 각 `.obsidian/plugins/labnoteo`를 하나의
사본으로 심볼릭 링크해 두면 복사를 반복하지 않아도 됩니다.
</details>

**✅ 확인** — 왼쪽 사이드바(리본)에 상자·시험관 아이콘 두 개가 생깁니다.

## 5. 동작 확인

명령 팔레트(`Ctrl/Cmd + P`)에서 **`Create experiment`**(실험 생성)를 실행하고
이름을 입력합니다. `labnote/001_이름/README.labnote.md`가 만들어지고 바로 열립니다.

**✅ 확인** — 실험 노트가 열립니다. 여기까지가 **노트 작성에 필요한 전부**입니다.
GitHub 자동화가 필요 없다면 [QUICKSTART](https://github.com/sblabkribb/labnoteo/blob/main/automation/templates/QUICKSTART.md)로
일상 사용법을 익히면 됩니다. 명령 팔레트 → **`Open user guide`**(사용법 열기)를 실행하면
같은 문서를 보관함에 바로 만들어 엽니다. 자동화를 쓰려면 6번으로 이어집니다.

## 6. 연구노트 자동화 설정

명령 팔레트에서 **`Setup research automation`**(연구노트 자동화 설정)을 실행합니다.
`.labnoteo/`(스크립트·훅), `.github/`(워크플로), `.gitignore`, `AGENTS.md`,
`CLAUDE.md`, `QUICKSTART.md`, `wiki-staging/`를 현재 보관함에 씁니다. 덮어쓰기 전에는
확인을 받고(내용이 이미 같은 파일은 묻지 않고 건너뜀), 기존 `.gitignore`에는 누락된 줄만 추가합니다.

플러그인을 업데이트하면 Obsidian을 켤 때 직접 고치지 않은 파일은 자동으로 새 버전에
맞춰집니다. 직접 고친 파일이나 보관함에 없는 파일이 있으면 새 버전마다 한 번 알림이 뜨니,
그때 이 명령을 다시 실행하세요. 자동 갱신 기록(`.labnoteo/installed.json`)이 없는 보관함
(0.95.0 이전 버전으로 설치)도 이전 버전이 만든 그대로인 파일은 자동으로 갱신됩니다.

자세한 내용은 [연구노트 자동화](../README.md#연구노트-자동화)와 설치 후 보관함에
생기는 관리자 문서 `.labnoteo/SETUP.md`를 참고하세요.

**✅ 확인** — 파일 관리자로 보면 보관함에 `.labnoteo/`, `.github/`, `AGENTS.md`,
`QUICKSTART.md`가 생겨 있습니다. (`.`으로 시작하는 폴더는 Obsidian 탐색기에는
보이지 않습니다.)

## 7. AI 에이전트 연결 (Copilot)

커밋·이슈·Wiki 초안을 말로 시키려면 Copilot 플러그인과 코딩 에이전트를 연결합니다.
**8단계에서 첫 커밋부터 에이전트에게 맡기려면 여기서 먼저 연결**해 두세요(수동 git만
쓸 거라면 건너뛰어도 됩니다). Windows에서 가장 간단한 경로는 Copilot이 직접 내려받아
관리하는 **opencode**입니다. 6단계에서 만든 `AGENTS.md`가 있어야 규칙이 처음부터
적용되므로 자동화 설정 뒤에 연결합니다.

전체 절차와 Claude Code·Codex 연결, 모델 설정은 [Copilot 에이전트 가이드](./COPILOT.md)를
보세요.

**✅ 확인** — Copilot 설정 → `Basic → Agents`에서 에이전트 상태가 **Ready**이고,
`Default backend`가 지정돼 있습니다.

## 8. GitHub 저장소 개설 + 첫 커밋·push

**반드시 6번을 먼저** 끝내세요. `.gitignore`가 있어야 대용량 데이터가 이력에 박히지
않습니다.

### 8-1. 빈 private 저장소 만들기

1. [github.com/new](https://github.com/new)에서 저장소를 만듭니다. 연구 데이터가 있으므로
   반드시 **Private**를 고르세요(공개는 fork PR을 통한 워크플로 악용 위험도 있습니다).
2. **"Add a README file", ".gitignore", "license"는 모두 체크하지 마세요.** 원격에 커밋이
   생기면 첫 push가 거부되어 pull/rebase가 필요해집니다 — 빈 저장소여야 합니다.
3. 만들어진 저장소의 **HTTPS URL**(`https://github.com/<계정>/<저장소>.git`)을 복사합니다.

### 8-2. 경로 A — Copilot에게 맡기기 (권장)

7단계에서 에이전트를 연결했다면, Agent Chat에 이렇게 말하면 됩니다:

> "이 폴더를 git 저장소로 초기화하고 훅을 설정한 뒤, 전부 커밋하고
> `https://github.com/<계정>/<저장소>.git` 에 올려줘."

에이전트는 보관함의 `AGENTS.md` 규칙에 따라 `git config core.hooksPath .labnoteo/hooks`를
먼저 실행하고, 대용량 파일 검사를 통과한 뒤 `--no-verify` 없이 커밋·push합니다.

### 8-3. 경로 B — 수동 git

보관함 루트에서 순서대로 실행합니다. **훅 활성화가 첫 커밋보다 앞**입니다.

```powershell
# PowerShell / bash 공통
git init
git config core.hooksPath .labnoteo/hooks   # ← 커밋 전에 반드시. 대용량 파일 차단 훅
```

macOS/Linux는 훅에 실행 권한을 한 번 부여합니다(Windows는 불필요):

```bash
chmod +x .labnoteo/hooks/pre-commit
```

```powershell
git add .
git commit -m "chore: 초기 보관함"
git remote add origin https://github.com/<계정>/<저장소>.git
git branch -M main
git push -u origin main
```

> 두 경로 모두 **첫 push에서 GitHub 로그인 창**(Git Credential Manager 팝업)이 한 번 뜰 수
> 있습니다 — 정상이며, 로그인하면 이후에는 다시 묻지 않습니다.

**✅ 확인** — GitHub 저장소에 파일이 올라가고, **Actions 탭**에 `validate` 실행 기록이
보입니다(`labnote/` 아래 파일이 포함된 push여야 워크플로가 돕니다).

## 9. (선택) LLM 제공자 설정

Obsidian *안에서* 방법 초안·결과 요약을 하려면 설정 → **Labnote Assistant** →
**AI 프로바이더**에서 `Ollama`(로컬) 또는 `OpenAI 호환`을 고르고 엔드포인트·모델명을
채웁니다. 기본값 `Disabled`에서는 AI 명령이 동작하지 않습니다. 이 층은 7번의 Copilot
에이전트와 별개입니다 — 층 구분은 [Copilot 가이드의 모델 설정](./COPILOT.md#copilot-llm-설정)을
참고하세요.

---

설치가 끝나면 일상 사용법은 보관함에 생성된 `QUICKSTART.md`(연구원용, 명령 팔레트 →
`Open user guide`로 열기)를, 저장소
관리는 `.labnoteo/SETUP.md`(관리자용)를 참고하세요.
