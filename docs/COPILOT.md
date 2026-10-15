# Copilot 에이전트 · MCP 가이드

[← README로 돌아가기](../README.md) · [설치 가이드](./INSTALL.md)

Copilot의 **에이전트 모드(Agent Chat)**는 이 컴퓨터에 설치된 코딩 에이전트
(**opencode** / **Claude Code** / **Codex**)를 그대로 실행해, git 커밋·이슈 신호·Wiki
초안 작성을 말로 시킬 수 있게 합니다. 인증은 **BYOK API 키가 아니라 각 에이전트에
로그인된 계정**을 씁니다.

labnoteo 내장 AI 명령과는 다른 층입니다: 내장 AI는 Obsidian *안에서* 초안·요약을
담당하고(설정 → Labnote Assistant → AI 프로바이더), 이 외부 에이전트는 git·이슈·Wiki를
담당합니다. 층 구분은 아래 [Copilot LLM 설정](#copilot-llm-설정)을 보세요.
[연구노트 자동화](../README.md#연구노트-자동화)를 설정했다면 생성된 `AGENTS.md`/`CLAUDE.md`를
같은 에이전트가 터미널에서든 Copilot 에이전트 모드에서든 자동으로 읽습니다.

> **먼저 [설치 가이드](./INSTALL.md)의 3~6단계**(Obsidian → 커뮤니티 플러그인 → 자동화
> 설정)를 마쳤다고 가정합니다. `AGENTS.md`가 생긴 뒤에 에이전트를 연결해야 규칙이
> 처음부터 적용됩니다.

## Copilot 플러그인 설치

1. 설정 → **커뮤니티 플러그인 → 탐색**에서 `Copilot`(제작자 Logan Yang, **V4**)을
   설치·활성화합니다.
2. 활성화하면 왼쪽 리본에 Agent Chat 아이콘이 생깁니다.

> **Agent Chat은 데스크톱 전용**입니다(각 에이전트가 로컬 프로세스로 돌기 때문).
> 모바일에서는 Quick Chat만 동작합니다.

## 에이전트 연결

Copilot은 최소 한 개의 에이전트를 연결하면 됩니다. **어느 것을 쓸지 아직 정하지
않았다면 opencode**가 가장 간단합니다 — Copilot이 실행 파일을 직접 내려받아 관리하므로
따로 설치할 것이 없습니다. 이미 Claude Code나 Codex를 쓰고 있다면 그쪽을 연결하세요.

> **구독별 자연스러운 선택**: Claude 구독이 있으면 **Claude Code**, ChatGPT 구독이면
> **Codex**, API 키·로컬 모델만 있으면 **opencode** — 단, 아래 opencode 3단계에서
> **Default model을 반드시 지정**하세요. 지정하지 않으면 클라우드 무료 모델로 시작합니다.

### opencode (권장 · 기본)

1. 설정 → Copilot → **Basic → Agents**에서 **opencode** 탭을 엽니다.
2. **Configure → Managed by Copilot → Download & install**을 누릅니다. Copilot이
   보관함 밖에 실행 파일을 내려받아 관리합니다.
3. 상태가 **Ready**가 되면 쓸 모델을 고르고 **Default model**을 지정합니다.
   - Copilot-hosted 모델은 Basic 탭의 **Copilot License**에, 직접 키를 쓸 모델은
     **BYOK**에 등록하면 목록에 나타납니다.
   - Default model을 지정하지 않으면(`Agent default`) 새 세션이 opencode가 운영하는
     클라우드의 무료 모델(예: `opencode/Big Pickle`)로 시작합니다.
4. **Default backend**를 opencode로 둡니다.

> **노트를 외부로 보내지 않으려면** — opencode의 Free 모델에 보낸 내용은 opencode
> 클라우드로 전송되고, Big Pickle 등 일부는 무료 기간 동안 보낸 데이터를 모델 개선에
> 쓸 수 있습니다([opencode Zen 개인정보 안내](https://opencode.ai/docs/zen/#privacy)).
> Copilot-hosted 모델과 클라우드 BYOK(OpenAI 등)도 외부 서비스입니다. 노트가 이
> 컴퓨터를 떠나지 않는 것은 **로컬 모델(Ollama, LM Studio)** 뿐입니다.
>
> 1. **BYOK → Add provider**에서 `Self Host`의 Ollama(또는 LM Studio)를 등록합니다.
> 2. **Basic → Agents → opencode → Default model**을 그 로컬 모델로 지정합니다.
> 3. 새 세션을 열 때마다 입력창 아래 모델 이름이 로컬 모델인지 확인한 뒤 보내세요.

### Claude Code (이미 쓰고 있다면)

Copilot의 Claude 백엔드는 이 컴퓨터의 Claude Code 설치와 Anthropic 로그인을 그대로
씁니다. **Claude Code는 유료 플랜 전용**입니다(Pro/Max/Team/Enterprise/Console — 무료
Claude.ai 플랜으로는 동작하지 않습니다). Copilot 연동에는 **Claude Code 2.1.206 이상**이
필요합니다.

1. Claude Code를 공식 경로로 설치합니다.

   ```powershell
   # Windows PowerShell
   irm https://claude.ai/install.ps1 | iex
   ```

   ```powershell
   # 또는 WinGet (자동 업데이트 안 됨 — winget upgrade Anthropic.ClaudeCode 로 갱신)
   winget install Anthropic.ClaudeCode
   ```

   ```bash
   # macOS / Linux / WSL
   curl -fsSL https://claude.ai/install.sh | bash
   ```

2. 터미널에서 `claude`를 실행하고 브라우저 로그인을 마칩니다. `/status`로 인증 상태를
   확인할 수 있습니다.
3. 설정 → Copilot → **Basic → Agents → Claude → Configure**에서 **Auto-detect**를
   누릅니다. 못 찾으면 `claude` 실행 파일의 절대 경로를 입력하고 **Apply**. 이미 경로가
   채워져 **Ready**라면 그대로 두면 됩니다.
4. 대화창이 **Sign in**을 요구하면 눌러 로그인합니다.

> - 환경변수 `ANTHROPIC_API_KEY`가 있으면 구독 로그인보다 **우선 적용**되어 그 키로
>   과금됩니다. 구독으로 쓰려면 비워 두세요.
> - Copilot은 Claude Code의 로그인만 봅니다 — 이 대화창에 API 키를 넣지 마세요.
>   "installed version is unsupported"가 뜨면 Claude Code를 업데이트하고 다시
>   Auto-detect 하세요.
> - Windows 상세 절차는 [Copilot 공식 Windows 설정 문서](https://docs.obsidiancopilot.com/agent-mode-windows-setup/)를
>   참고하세요.

### Codex (이미 쓰고 있다면)

Codex 백엔드는 Codex CLI와 네이티브 `codex-acp` 어댑터가 모두 필요합니다.

1. 설정 → Copilot → **Basic → Agents → Codex → Configure**의 안내 명령을 실행하면
   Codex CLI 설치·로그인·어댑터 다운로드가 함께 진행됩니다.
2. **Auto-detect**로 잡거나, 안 되면 **`codex-acp.exe`**의 절대 경로를 입력합니다
   (`codex.exe`나 `.cmd` 런처가 아니라 `codex-acp.exe`여야 합니다).

> 수동 설치 시 `@agentclientprotocol/codex-acp` **2.0.0 이상**이 필요합니다(Copilot 4.0.13부터.
> Copilot이 관리하는 설치는 자동으로 맞는 버전을 받습니다). 구
> `@zed-industries/codex-acp` 패키지는 지원되지 않습니다. Codex는 CLI 로그인을 쓰므로
> Copilot에 키를 넣지 않습니다.

### 연결 마무리

1. **Default backend**로 기본 에이전트를 지정합니다.
2. 명령 팔레트에서 **Open Copilot Agent Chat Window**를 실행해 대화창을 엽니다.
3. 노트에서 텍스트를 선택하면 에이전트 모드의 컨텍스트 컨트롤로 선택 텍스트·활성
   노트를 대화에 추가할 수 있습니다.

**권한 모드** — 대화창 입력창 아래 버튼에서 **Safe / Plan / Auto**를 고릅니다.
에이전트마다 고를 수 있는 것이 다릅니다: Claude는 셋 다, opencode는 Safe와 Auto만(Plan
없음), Codex는 설치된 어댑터가 지원하는 것만 보입니다.

- **Safe**(기본) — 에이전트의 승인 규칙대로 동작합니다. 편집마다 묻는다는 뜻이 아니라서,
  **노트 편집은 확인 없이 바로 적용될 수 있습니다**(Claude에서 확인: 명령 실행에만
  `Permission required`가 뜨고 README 편집은 바로 적용됨).
- **Plan** — 계획을 먼저 보여 주고 승인을 받은 뒤 고칩니다(Claude·Codex). **노트를
  고치기 전에 보고 싶으면 Plan**을 고르세요. Codex는 계획을 승인하면 그 뒤로 Auto로
  이어서 진행합니다.
- **Auto** — 확인을 더 줄입니다. Claude는 설정 → Copilot → **Basic → Agents → Claude**의
  **Auto mode permissions**(`Auto` / `Accept edits` / `Bypass permissions`)로 Auto가
  어디까지 자동 승인할지 정합니다. `Bypass permissions`는 권장하지 않습니다.

> Plan이 없는 opencode나 Safe에서 작업했다면, 커밋하기 전에 에이전트에게 "바뀐 내용
> 보여줘"라고 하거나 `git diff`로 변경을 확인하세요.

## AGENTS.md 공유 규칙

Copilot 설정의 *Custom vault instructions* 칸은 **보관함 루트 `AGENTS.md`를 직접
편집**합니다. 그 파일이 Agent Chat(그리고 기본값으로 Quick Chat)의 지시문이므로,
[연구노트 자동화 설정](./INSTALL.md#6-연구노트-자동화-설정)이 설치한 규칙이 Copilot에도
자동 적용됩니다.

- 그 칸에서 편집할 때는 labnoteo 관리 마커 블록을 건드리지 않도록 **사용자 규칙을
  마커 바깥에** 쓰세요.
- 플러그인 업데이트나 *연구노트 자동화 설정*으로 `AGENTS.md`가 갱신되면 **새 Agent
  Chat을 시작**해야 반영됩니다.
- Copilot이 에이전트에 심는 **Skills**는 설정 → Copilot → **Skills**에서 에이전트별로
  켜고 끌 수 있습니다.
- Copilot은 대화를 보관함의 `copilot/copilot-conversations/`에 저장합니다(메모리·사용자
  명령도 `copilot/` 아래). 연구노트 자동화가 설치한 `.gitignore`는 `copilot/skills/`만
  남기고 이 폴더를 커밋에서 제외합니다. 내장 스킬(`copilot-web-search` 등)도 함께
  커밋되므로, 연구원마다 Copilot 버전이 다르면 그 파일에 diff가 생길 수 있습니다.
  설정 → Copilot → Basic → **Copilot folder location**을 바꿨다면 `.gitignore`의 두 줄도
  그 이름으로 바꾸세요.

## Copilot LLM 설정

모델 설정이 헷갈리는 이유는 **층이 3개**인데 층마다 보는 자격증명이 다르기 때문입니다.

| 층 | 모델·인증 | 설정 위치 | 쓰임 |
| --- | --- | --- | --- |
| **labnoteo 자체 AI** | Ollama 또는 OpenAI 호환 엔드포인트 + 자체 `API 키` | 설정 → Labnote Assistant → **AI 프로바이더** — [README 설정](../README.md#설정) 참고 | 노트 안 초안·요약 (`AI: Method 섹션 초안` 등) |
| **Copilot Agent Chat** (opencode / Claude / Codex) | **에이전트 로그인** — BYOK 키는 쓰지 않습니다(Claude/Codex). opencode는 Copilot 라이선스 또는 BYOK | `Basic → Agents`의 각 에이전트 탭 | git 커밋·이슈 신호·Wiki 초안 |
| **Copilot Quick Chat** | Copilot-hosted 또는 **BYOK** 모델. Agent Chat 모델과 **별개 목록**입니다 | `Settings → Copilot → BYOK` + `Basic → Agents → Quick Chat` | Copilot 채팅창에서의 짧은 질의 |

**Quick Chat용 모델 설정**

1. `Settings → Copilot → BYOK → Add provider`. 로컬 모델은 `Self Host` 템플릿(Ollama
   기본 `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`)을, 클라우드는
   해당 제공자를 고르고 키를 입력합니다. 커스텀 OpenAI 호환 엔드포인트는 `Base URL`이
   필수입니다.
2. `Basic → Agents → Quick Chat`에서 쓸 모델을 켜고 `Default model`을 지정합니다.

## (선택) Labnote 툴 연결 — MCP

MCP 서버를 켜면 Labnote의 툴(`get_sample`, `list_samples`, `create_sample`,
`get_unit_operation`, `update_section`, `create_workflow`)을 Claude Desktop 같은 외부
MCP 클라이언트나 로컬 `claude` CLI에 노출합니다. **데스크톱 전용**입니다.

- **엔드포인트**: `http://127.0.0.1:3987` — 루프백 전용이며 라우팅 가능한 인터페이스에는
  바인딩하지 않습니다.
- **인증**: 무작위로 생성되는 베어러 토큰. 설정 → **MCP 토큰**의 `Copy token`(`토큰 복사`)으로
  복사하세요(서버가 꺼져 있어도 됩니다). 토큰은 플러그인 설정(`data.json`)에 저장되어
  Obsidian이나 서버를 다시 시작해도 **바뀌지 않습니다.** 유출이 의심되면
  `Regenerate token`(`토큰 재발급`)으로 바꾸고, 새 토큰을 모든 클라이언트에 다시
  등록하세요. `data.json`은 연구노트 자동화 설정이 넣는 `.gitignore`로 커밋에서 빠집니다.
- **쓰기는 확인을 거칩니다**: 보관함을 수정하는 툴은 실행 전에 대상 경로와 함께 확인을
  요청합니다. 경로를 고르는 것은 모델이기 때문입니다. Obsidian 창이 다른 창에 가려져
  있으면 OS 알림도 함께 뜹니다. `update_section`은 확인 창에 바꿀(또는 비울) 절과 그 절에
  지금 있는 줄 수·하위 제목 수도 보여 줍니다. 대상 절이 없거나 여러 개라 어차피 실패할
  호출은 확인 창 없이 바로 오류로 돌려줍니다.
- **승인 시간 제한**: 확인 창에 **50초** 안에 답하지 않으면 창이 닫히고, 클라이언트는
  `Approval timed out` 오류(JSON-RPC `-32001`)를 받습니다. 클라이언트가 먼저 연결을
  끊었을 때도 창이 닫힙니다. 어느 경우든 그 요청은 **나중에 적용되지 않습니다.**
  클라이언트의 요청 시간 제한이 50초보다 짧으면 클라이언트는 응답을 받지 못하지만,
  그 요청 역시 적용되지 않습니다.
- **`update_section`의 대상 지정**: 워크플로 노트는 유닛 오퍼레이션마다 `#### Method`
  같은 같은 이름의 절이 반복됩니다. 이름이 같은 절이 여러 개면 툴은 **아무것도 쓰지
  않고** 후보 목록(상위 헤딩·순번·줄 번호)을 오류로 돌려줍니다. `parentHeading`
  (상위 헤딩 전체, 대괄호를 뺀 `USW230 Sequence Embedding`, 또는 id `USW230`)이나
  `occurrence`(1부터, `parentHeading`으로 거른 뒤의 순번)를 넣어 다시 호출하면 됩니다.
  같은 유닛 오퍼레이션을 두 번 넣은 노트는 둘을 함께 지정합니다. 성공하면 바꾼
  위치(`parentHeading`, `occurrence`, `total`)와 지운 내용(`removedLines` 비어 있지 않은 줄 수,
  `removedSubheadings` 하위 제목 수, `previousBody` 옛 본문 앞 500자)을 돌려줍니다.
- **`update_section`으로 절 비우기**: `content`가 비어 있거나 공백뿐이면 **아무것도 쓰지 않고**
  오류를 돌려줍니다. 절을 일부러 비울 때만 `content: ""`와 `clear: true`를 함께 보내세요.
  `clear: true`인데 `content`가 비어 있지 않아도 오류입니다.
- **샘플 보관 위치**: `create_sample`은 보관 위치(`location`)도 받습니다. 생략하거나 비워
  두면 기존 위치를 유지합니다. `list_samples`는 각 샘플의 위치를 함께 돌려줍니다.
- **이미 있는 샘플에 다시 부르면 합칩니다**: 같은 `id`로 `create_sample`을 다시 부르면
  기록을 새로 만들지 않습니다. 설명은 기존 설명 앞에 더하고(같은 설명은 한 번만),
  `documentPath` 노트를 사용처에 더합니다. 별칭·위치는 줄 때만 바꾸고, 생략하면 그대로 둡니다.
- **샘플 ID 형식**: `create_sample`의 `id`는 `<타입>-<숫자>`(예: `Equip-3`)만 받습니다.
  다른 형식이면 아무것도 쓰지 않고 `Invalid id` 오류를 돌려주니, 정할 ID가 없으면 `id`를
  생략해 자동 생성하세요. 알려진 타입은 대소문자를 맞춰 저장합니다(`equip-3` → `Equip-3`).
  결과에는 저장한 폴더(`folder`)와 범위(`scope`: `local`/`global`)가 들어 있고, 실험 폴더
  밖 노트로 만들어 전역 샘플 폴더에 저장했다면 `Warning:`으로 알려 줍니다.
- **없는 경로는 거부**: `create_sample`의 `documentPath`는 이미 있는 노트(`.md`)여야 하고,
  `create_workflow`의 `documentPath`는 `README.labnote.md`가 있는 실험 폴더 안이어야 합니다.
  아니면 아무것도 쓰지 않고 `Note not found`/`Experiment not found` 오류를 돌려줍니다.
  경로를 잘못 적어 실험이 아닌 폴더가 생기는 일을 막기 위해서입니다. 보관함 밖 경로는
  `documentPath is outside the vault` 오류로 거부합니다.
- **지원하지 않는 입력**: 툴이 모르는 입력 항목은 무시하되, 결과에 `Warning:`으로 시작하는
  항목을 덧붙여 무엇을 무시했는지와 지원 항목을 알려 줍니다(호출 자체는 실패하지 않음).

서버는 MCP `2025-06-18` 개정의 **무상태(stateless)** 구현입니다(`initialize`,
`tools/list`, `tools/call`). DNS 리바인딩 방어를 위해 `Origin` 헤더를 검증하며, 인증이
OAuth가 아니라 베어러 토큰이므로 클라이언트가 커스텀 `Authorization` 헤더를 설정할 수
있어야 합니다.

**Claude Code에 등록하기**

1. 명령 팔레트에서 **Toggle MCP server**를 실행하고, 설정 → **MCP 토큰**에서 토큰을
   복사합니다(한 번 등록하면 재발급하기 전까지 계속 쓸 수 있음).
2. 복사한 토큰으로 등록합니다:

   ```bash
   claude mcp add --transport http labnoteo http://127.0.0.1:3987 \
     --header "Authorization: Bearer <복사한-토큰>"
   ```

3. `claude mcp list`로 연결을 확인합니다. 이후 자연어로 지시하면 됩니다 — 예:
   "list_samples로 이 보관함의 DNA 샘플을 보여줘".

> - **토큰 재발급 후**: 토큰은 재시작해도 유지되며, `토큰 재발급`을 눌렀을 때만 바뀝니다.
>   그때는 `claude mcp remove labnoteo` 후 새 토큰으로 다시 `add`하세요.
> - **쓰기 확인**: 보관함을 수정하는 툴은 실행 전에 Obsidian이 대상 경로와 함께
>   확인창을 띄웁니다. 50초 안에 허용하지 않으면 거절된 것으로 처리됩니다.
> - **헤더 이슈**: 일부 Claude Code 버전(특히 Windows)이 `Authorization` 헤더를 누락해
>   `401`이 납니다. 반복되면 최신 버전으로 업데이트하세요.

## 막히는 지점

- **`missing key` 라벨이 뜨거나 `Select Model`만 보입니다** — Quick Chat 기본 모델에
  키가 없어서입니다. BYOK에서 제공자를 먼저 추가한 뒤 `Default model`을 바꾸세요.
- **Agent Chat이 안 되는데 BYOK 키를 넣고 있습니다** — 층을 혼동한 것입니다.
  Claude/Codex는 **에이전트 로그인**만 봅니다(위 에이전트 연결 참고).
- **Copilot `Reset Settings` 후 에이전트 모델이 비어 있습니다** — 키는 보존되지만
  백엔드 모델 활성화가 초기화되므로 `Basic → Agents`에서 다시 켜세요.
- **에이전트를 고를 수 없거나 말해도 반응이 없습니다** — 에이전트가 설치·로그인되어
  있는지, `Default backend`가 지정됐는지 확인하세요.
