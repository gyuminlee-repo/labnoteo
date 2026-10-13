/**
 * Korean catalog for the Obsidian plugin — the single source of Korean strings,
 * consumed via `this.t()` / `host.t()` and wired up in `i18n.ts` (ko locale).
 *
 * Conventions: 워크플로 / 샘플 / 유닛 오퍼레이션 / 실험, formal (존댓말) tone, and
 * positional `{0}` / literal `{Type}` placeholders left intact for `formatMessage`.
 */
const obsidianKo: Record<string, string> = {
  // Commands
  'Create experiment': '실험 생성',
  'Change experiment status': '실험 상태 변경',
  'Toggle discussion flag': '논의 표시 전환',
  'Insert issue marker': '논의 이슈 마커 삽입',
  'Setup research automation': '연구노트 자동화 설정',
  'Create workflow': '워크플로 생성',
  'Renumber workflows': '워크플로 번호 다시 매기기',
  'Insert workflow': '워크플로 삽입',
  'Insert unit operation': '유닛 오퍼레이션 삽입',
  'Insert date': '날짜 삽입',
  'Insert date and time': '날짜 및 시간 삽입',
  'Pick date and time': '날짜 및 시간 선택',
  'Export tables to CSV': '표를 CSV로 내보내기',
  'Open workflow view': '워크플로 뷰 열기',
  'Open sample view': '샘플 뷰 열기',
  'Open user guide': '사용법 열기',
  'Toggle MCP server': 'MCP 서버 켜기/끄기',
  'AI: Draft Method section': 'AI: Method 섹션 초안 작성',
  'AI: Summarize results': 'AI: 결과 요약',
  'AI: Extract sample definitions': 'AI: 샘플 정의 추출',
  'AI: Ask assistant (uses tools)': 'AI: 어시스턴트에게 요청 (툴 사용)',
  'Ask the AI assistant': 'AI 어시스턴트에게 요청',
  'What should the assistant do?': '어시스턴트가 무엇을 하면 될까요?',
  'e.g. Add a Method section describing the PCR setup':
    '예: PCR 조건을 설명하는 Method 섹션 추가',
  'Allow AI tool "{0}" to modify the vault?': 'AI 툴 "{0}"이(가) 보관함을 수정하도록 허용할까요?',
  'AI stopped after too many steps.': 'AI가 너무 많은 단계를 거쳐 중단되었습니다.',
  'AI ran {0} tool call(s).': 'AI가 툴을 {0}회 호출했습니다.',

  // View titles / ribbon
  'Workflows': '워크플로',
  'Samples': '샘플',

  // User guide / view hints
  'Created the user guide: {0}': '사용법 문서를 만들었습니다: {0}',
  'Right-click an item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.':
    '항목을 우클릭해 워크플로를 만들거나 유닛 오퍼레이션을 넣습니다. 실험이 없다면 먼저 "{0}"을(를) 실행하세요.',
  'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.':
    '노트에서 @dna처럼 입력하거나 우클릭 → "{0}"(으)로 샘플을 등록합니다.',

  // Pickers / prompts
  'New experiment': '새 실험',
  'Experiment title': '실험 제목',
  'Title is required.': '제목을 입력해야 합니다.',
  'Select workflow': '워크플로 선택',
  'Search workflows': '워크플로 검색',
  'Search unit operations': '유닛 오퍼레이션 검색',
  'Open a lab note first.': '먼저 랩노트 파일을 여세요.',
  'Select a status': '상태를 선택하세요',
  'current': '현재',
  'Workflow name': '워크플로 이름',
  'Enter a name for this workflow': '이 워크플로의 상세 별칭을 입력하세요',

  // Notices / results
  'Experiment created: {0}': '실험이 생성되었습니다: {0}',
  'Workflow numbering is already sequential.': '워크플로 번호가 이미 순서대로입니다.',
  'Renumber {0} workflow file(s) in {1}?': '{1}의 워크플로 파일 {0}개의 번호를 다시 매길까요?',
  'Renumbered {0} workflow file(s).': '워크플로 파일 {0}개의 번호를 다시 매겼습니다.',
  '"{0}" is no longer a workflow note: its name must end in .labnote.md, so the README checklist stopped following it. Rename it to "{1}"?':
    '"{0}"은(는) 이름이 .labnote.md로 끝나지 않아 워크플로 노트에서 빠졌고, README 체크리스트도 더 이상 따라가지 않습니다. "{1}"(으)로 이름을 고칠까요?',
  '"{0}" is no longer a workflow note: its name must start with ###_ and end in .labnote.md, so the README checklist stopped following it.':
    '"{0}"은(는) 이름이 ###_로 시작하고 .labnote.md로 끝나야 워크플로 노트로 인식됩니다. README 체크리스트가 더 이상 따라가지 않습니다.',
  'Fix name': '이름 고치기',
  'Experiment status changed: {0}': '실험 상태가 변경되었습니다: {0}',
  'Flagged for discussion. An issue opens on the next push.':
    '논의 표시를 설정했습니다. 다음 push 때 이슈가 생성됩니다.',
  'Discussion flag cleared. Any issue already opened stays open.':
    '논의 표시를 해제했습니다. 이미 생성된 이슈는 닫히지 않습니다.',
  'Flagged for discussion. To open it as an issue, run "Setup research automation" first.':
    "논의 표시를 설정했습니다. 이슈로 올리려면 먼저 '연구노트 자동화 설정'을 실행하세요.",
  'Discussion flag cleared.': '논의 표시를 해제했습니다.',
  'Issue marker inserted. To open it as an issue, run "Setup research automation" first.':
    "이슈 마커를 넣었습니다. 이슈로 올리려면 먼저 '연구노트 자동화 설정'을 실행하세요.",
  'Issue markers cannot go inside a table. Run this on a line below the table.':
    '표 안에서는 이슈 마커를 넣을 수 없습니다. 표 아래 줄에서 실행하세요.',
  'This line already has an issue marker. A line can hold only one.':
    '이 줄에는 이미 이슈 마커가 있습니다. 한 줄에 하나만 둘 수 있습니다.',
  'Front matter of this note could not be read, so it was left unchanged. Fix the YAML and try again: {0}':
    '이 노트의 front matter를 읽을 수 없어 변경하지 않았습니다. YAML을 고친 뒤 다시 시도하세요: {0}',
  'Overwrite {0}?': '{0} 파일을 덮어쓰시겠습니까?',
  'Research automation set up ({0} written, {1} merged, {2} skipped, {3} removed). Researchers: see {4}. Admin setup: {5} (run `git config core.hooksPath {6}`).':
    '연구노트 자동화를 설정했습니다 (생성 {0} · 병합 {1} · 건너뜀 {2} · 정리 {3}). 연구원 안내는 {4}, 관리자 설정은 {5} 문서를 확인하고 `git config core.hooksPath {6}`을 실행하세요.',
  'Remove {0} file(s) left by the previous layout ({1})? Afterwards run `git config core.hooksPath {2}` so the pre-commit hook keeps working.':
    '이전 구조에서 남은 파일 {0}개를 삭제할까요? ({1}) 삭제 후 `git config core.hooksPath {2}`를 실행해야 pre-commit 훅이 계속 동작합니다.',
  'Remove': '삭제',
  'Delete these lines from .gitignore so agent skills can be committed: {0}':
    '에이전트 스킬이 커밋되도록 .gitignore에서 다음 줄을 직접 지우세요: {0}',
  'Exported {0} CSV file(s).': 'CSV 파일 {0}개를 내보냈습니다.',
  'No tables found in this note.': '이 노트에서 표를 찾을 수 없습니다.',
  'Command failed: {0}': '명령 실행 실패: {0}',
  'Yes': '예',
  'Workflow created: {0}': '워크플로가 생성되었습니다: {0}',
  'Unit operation inserted: {0} {1}': '유닛 오퍼레이션이 삽입되었습니다: {0} {1}',
  'Please open a workflow file.': '워크플로 파일을 열어주세요.',
  'Please run this command on a workflow file inside the labnote folder.':
    'labnote 폴더 내의 워크플로 파일에서 실행해주세요.',
  'Missing unit operation info.': '유닛 오퍼레이션 정보가 없습니다.',

  // Workflow README auto-sync (delete pruning)
  'Removed from sample tree: {0}': '샘플 트리에서 제거됨: {0}',

  // Sample view context menu
  'Copy sample ID': '샘플 ID 복사',
  'Copied: {0}': '복사했습니다: {0}',
  'Insert reference': '참조 삽입',
  'Add sample': '샘플 추가',
  'Search samples': '샘플 검색',
  'Select sample type': '샘플 타입 선택',
  'Edit sample': '샘플 편집',
  'Delete sample': '샘플 삭제',
  'Move to Global': '전역으로 이동',
  'Move to Local': '로컬로 이동',
  'Open a note to insert into.': '삽입할 노트를 여세요.',
  'Open a note first to add a local sample.': '로컬 샘플을 추가하려면 먼저 노트를 여세요.',
  'No samples found.': '샘플을 찾을 수 없습니다.',

  // Sample create / autocomplete actions
  'Generate new {0} ID': '새 {0} ID 생성',
  'Automatically generate a new sample ID': '샘플 ID를 자동으로 생성합니다',
  'Enter info': '직접 입력',
  'Manually enter sample ID, alias, and description': '샘플 ID·별칭·설명을 직접 입력합니다',
  'Search catalog': '카탈로그 검색',
  'Search {0} catalog': '{0} 카탈로그 검색',
  'Insert a reference from the product catalog': '제품 카탈로그에서 참조를 삽입합니다',
  'No {0} catalog found. Add resources/labsamples/{0}_*.json.':
    '{0} 카탈로그가 없습니다. resources/labsamples/{0}_*.json 파일을 추가하세요.',

  // Go to definition popup
  'Go to definition': '정의로 이동',
  'Sample definition': '샘플 정의',
  'Type': '타입',
  'ID': 'ID',
  'Alias': '별칭',
  'Description': '설명',
  'Location': '보관 위치',
  'Scope': '범위',
  'File': '파일',
  'Open JSON file': 'JSON 파일 열기',
  'Could not open {0}': '{0}을(를) 열 수 없습니다',
  'No definition found for {0}': '{0}의 정의를 찾을 수 없습니다',
  'Close': '닫기',
  'Enter the {0} sample ID': '{0} 샘플 ID를 입력하세요',
  'e.g. {0}-12345': '예: {0}-12345',
  'Invalid ID. Expected {0}-<number>.': '잘못된 ID입니다. {0}-<숫자> 형식이어야 합니다.',
  'Enter an alias for the new {0} sample (optional)': '새 {0} 샘플의 별칭을 입력하세요 (선택)',
  'e.g. Sample-A': '예: Sample-A',
  'Enter a description (optional)': '설명을 입력하세요 (선택)',
  'e.g. Sample used in experiment 1': '예: 실험 1에서 사용한 샘플',
  'Enter a storage location (optional)': '보관 위치를 입력하세요 (선택)',
  'e.g. Freezer-2 / Box-3 / A1': '예: 냉동고-2 / 박스-3 / A1',
  'Enter a new alias': '새 별칭을 입력하세요',
  'Enter a new description': '새 설명을 입력하세요',
  'Are you sure you want to delete {0}?': '{0}을(를) 삭제하시겠습니까?',
  'Delete': '삭제',
  'OK': '확인',
  'Cancel': '취소',
  'Sample added: {0}': '샘플이 추가되었습니다: {0}',
  'Sample updated: {0}': '샘플이 수정되었습니다: {0}',
  'Sample deleted: {0}': '샘플이 삭제되었습니다: {0}',
  'Sample moved: {0}': '샘플을 이동했습니다: {0}',
  'Sample not found: {0}': '샘플을 찾을 수 없습니다: {0}',
  'Open an experiment note first to move samples.': '샘플을 이동하려면 먼저 실험 노트를 여세요.',
  'Local and Global folders are the same.': '로컬과 전역 폴더가 동일합니다.',
  '{0} already exists in the destination. Overwrite it?':
    '{0}이(가) 대상에 이미 존재합니다. 덮어쓰시겠습니까?',
  'Overwrite': '덮어쓰기',

  // Settings tab
  'User guide': '사용법',
  'New here? Open the quick-start guide. Searching "Labnote" in the command palette lists every command.':
    '처음이라면 퀵스타트 안내서를 여세요. 명령 팔레트에서 "Labnote"로 검색하면 모든 명령이 모입니다.',
  'Sample tracking': '샘플 추적',
  'Autocomplete, highlighting and {Type}.json sync. Reload to apply.':
    '자동완성, 하이라이팅 및 {Type}.json 동기화. 적용하려면 다시 로드하세요.',
  'Custom sample types': '사용자 정의 샘플 타입',
  'Comma-separated types in addition to the built-ins.':
    '기본 제공 타입 외에 추가할 타입을 쉼표로 구분해 입력합니다.',
  'Global sample folder': '전역 샘플 폴더',
  'Vault-relative folder for vault-global samples.':
    '볼트 전역 샘플을 저장할 볼트 기준 상대 폴더입니다.',
  'Auto-sync unit operation TOC': '유닛오퍼레이션 TOC 자동 정렬',
  "Reorder a workflow note's Related Unit Operations list to match heading order after edits, and tidy the --- separators immediately when a block is moved.":
    '편집 후 워크플로 노트의 Related Unit Operations 목록을 헤딩 순서에 맞게 정렬하고, 블록을 옮기면 `---` 구분선도 즉시 정리합니다.',
  'Auto-update last updated date': '마지막 갱신일 자동 기록',
  "Set a lab note's last_updated_date to today (once a day) when you edit it, change its status or discussion flag, or the AI edits it. Editing a workflow note also updates its experiment README. Changes pulled from git are ignored.":
    '연구노트를 편집하거나 상태·논의 표시를 바꾸거나 AI가 고치면 last_updated_date를 오늘 날짜로 바꿉니다(하루 한 번). 워크플로 노트를 고치면 실험 README도 함께 바뀝니다. git으로 받아온 변경은 반영하지 않습니다.',
  'AI provider': 'AI 프로바이더',
  'Provider': '프로바이더',
  'Disabled': '비활성화됨',
  'Endpoint': '엔드포인트',
  'Ollama endpoint': 'Ollama 엔드포인트',
  'OpenAI endpoint': 'OpenAI 엔드포인트',
  'Model': '모델',
  'API key': 'API 키',
  'Only sent to OpenAI-compatible providers, never to Ollama.':
    'OpenAI 호환 프로바이더에만 전송되며, Ollama에는 전송되지 않습니다.',
  'Enable MCP server': 'MCP 서버 활성화',
  'Desktop only. Exposes tools to external MCP clients.':
    '데스크톱 전용. 외부 MCP 클라이언트에 도구를 노출합니다.',
  'MCP token': 'MCP 토큰',
  'Copy the bearer token for external MCP clients (server must be running).':
    '외부 MCP 클라이언트용 베어러 토큰을 복사합니다 (서버가 실행 중이어야 합니다).',
  'Copy token': '토큰 복사',
  'Start the MCP server first.': 'MCP 서버를 먼저 시작하세요.',
  'MCP token copied to clipboard.': 'MCP 토큰을 클립보드에 복사했습니다.',

  // AI commands
  'Configure an AI provider in settings first.': '먼저 설정에서 AI 프로바이더를 구성하세요.',
  'Contacting {0}…': '{0}에 연결 중…',
  'AI request failed: {0}': 'AI 요청 실패: {0}',
  'Open a note first.': '먼저 노트를 여세요.',
  'Open a markdown note first.': '먼저 마크다운 노트를 여세요.',
  'Nothing to summarize.': '요약할 내용이 없습니다.',
  'Nothing to extract.': '추출할 내용이 없습니다.',
  'Created {0} sample(s).': '샘플 {0}개를 생성했습니다.',

  // MCP server
  'MCP server is desktop-only.': 'MCP 서버는 데스크톱 전용입니다.',
  'MCP server started on 127.0.0.1:{0}': 'MCP 서버가 127.0.0.1:{0}에서 시작되었습니다',
  'MCP server port {0} is already in use.': 'MCP 서버 포트 {0}이(가) 이미 사용 중입니다.',
  'MCP server error: {0}': 'MCP 서버 오류: {0}',
  'Allow MCP tool "{0}" to modify the vault?': 'MCP 도구 "{0}"가 볼트를 수정하도록 허용할까요?',
  'Target: {0}': '대상: {0}',
  'Allow': '허용',
};

export default obsidianKo;
