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
  'Sync workflow checklist with folder': '폴더와 워크플로 체크리스트 맞추기',
  'Insert workflow': '워크플로 삽입',
  'Insert unit operation': '유닛 오퍼레이션 삽입',
  'Update catalogs': '카탈로그 업데이트',
  'Update': '업데이트',
  'Update the catalogs in {0} to this plugin version? Fields edited in this vault are kept.':
    '{0}의 카탈로그를 이 플러그인 버전에 맞게 업데이트할까요? 이 보관함에서 고친 값은 그대로 둡니다.',
  '+ Add {0}': '+ 추가: {0}',
  '{0}: name "{1}" → "{2}"': '{0}: 이름 "{1}" → "{2}"',
  '{0}: new {1}': '{0}: {1} 갱신',
  '{0}: {1} kept (edited in this vault)': '{0}: {1} 그대로 둠(이 보관함에서 고친 값)',
  'name': '이름',
  'description': '설명',
  'category': '분류',
  'equipment': '장비',
  'software': '소프트웨어',
  'The catalogs are up to date.': '카탈로그가 이미 최신입니다.',
  'The catalogs are up to date. {0} field(s) edited in this vault were kept.':
    '카탈로그가 이미 최신입니다. 이 보관함에서 고친 값 {0}개는 그대로 두었습니다.',
  'Updated the catalogs: {0} added, {1} changed. Commit the changed files in {2}.':
    '카탈로그를 업데이트했습니다: {0}개 추가, {1}개 갱신. {2}의 바뀐 파일을 커밋하세요.',
  '{0} could not be read as a catalog, so it was left as it is. Fix its JSON and run "{1}" again.':
    '{0}을(를) 카탈로그로 읽을 수 없어 그대로 두었습니다. JSON을 고친 뒤 "{1}"을(를) 다시 실행하세요.',
  'Catalog update available: {0} new, {1} changed. Run "{2}" from the command palette.':
    '카탈로그에 새 항목 {0}개, 바뀐 항목 {1}개가 있습니다. 명령 팔레트에서 "{2}"을(를) 실행하세요.',
  'Insert date': '날짜 삽입',
  'Insert date and time': '날짜 및 시간 삽입',
  'End_date {0} is earlier than Start_date {1}.': 'End_date({0})가 Start_date({1})보다 이릅니다.',
  'Pick date and time': '날짜 및 시간 선택',
  'Export tables to CSV': '표를 CSV로 내보내기',
  'Open workflow view': '워크플로 뷰 열기',
  'Open sample view': '샘플 뷰 열기',
  'Open sample definition': '샘플 정의 열기 (편집·이동·삭제)',
  'Insert sample list of this experiment': '이 실험의 시료 목록 삽입',
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
  'The assistant gave no answer. What you asked may be outside the tools it can use.':
    '어시스턴트가 답을 주지 않았습니다. 요청한 일이 쓸 수 있는 도구 밖일 수 있습니다.',
  'The assistant gave no answer.': '어시스턴트가 답을 주지 않았습니다.',
  'The model gave no answer (it only thought). Try again or choose another model.':
    '모델이 답을 주지 않았습니다(생각만 하고 끝남). 다시 시도하거나 다른 모델을 고르세요.',
  'The model gave no answer. Try again or choose another model.':
    '모델이 답을 주지 않았습니다. 다시 시도하거나 다른 모델을 고르세요.',
  'The AI used no tools; nothing in the vault changed.': 'AI가 도구를 쓰지 않았습니다. 보관함은 바뀌지 않았습니다.',
  'AI tool calls: {0}.': 'AI 도구 호출: {0}.',
  '{0} change(s) made': '변경 {0}건',
  '{0} lookup(s)': '조회 {0}건',
  '{0} denied by you': '거절 {0}건',
  '{0} failed': '실패 {0}건',
  'Nothing in the vault changed.': '보관함은 바뀌지 않았습니다.',
  'AI answer': 'AI 답변',
  'Insert into note': '노트에 넣기',
  'Copy': '복사',
  'Copied to clipboard.': '클립보드에 복사했습니다.',
  'Could not copy: {0}': '복사하지 못했습니다: {0}',
  'That note is no longer open. Copy the answer instead.':
    '그 노트가 더 이상 열려 있지 않습니다. 답변을 복사해서 쓰세요.',
  'Inserted the summary into {0}.': '요약을 {0}에 넣었습니다.',
  'AI summary ({0}, {1})': 'AI 요약 ({0}, {1})',
  'Inserted the Method draft into {0}.': 'Method 초안을 {0}에 넣었습니다.',

  // View titles / ribbon
  'Workflows': '워크플로',
  'Samples': '샘플',

  // User guide / view hints
  'Created the user guide: {0}': '사용법 문서를 만들었습니다: {0}',
  'Updated {0} automation file(s) to this plugin version: {1}':
    '자동화 파일 {0}개를 이 플러그인 버전에 맞게 갱신했습니다: {1}',
  'These automation files changed after they were installed, or cannot be checked against an earlier version, so they were left as they are: {0}. Run "Setup research automation" to get the new version.':
    "다음 자동화 파일은 설치 후 내용이 바뀌었거나 이전 버전 기록으로 확인할 수 없어 그대로 두었습니다: {0}. 새 버전을 받으려면 '연구노트 자동화 설정'을 실행하세요.",
  'These automation files are not in the vault: {0}. Run "Setup research automation" to install them if you need them.':
    "다음 자동화 파일이 보관함에 없습니다: {0}. 필요하면 '연구노트 자동화 설정'으로 설치하세요.",
  'Click an experiment to open its README, or right-click it to change its status or toggle its discussion flag. Right-click a catalog item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.':
    '실험을 클릭하면 README가 열리고, 우클릭하면 상태를 바꾸거나 논의 표시를 전환합니다. 카탈로그 항목을 우클릭해 워크플로를 만들거나 유닛 오퍼레이션을 넣습니다. 실험이 없다면 먼저 "{0}"을(를) 실행하세요.',
  'Experiments': '실험',
  'Flagged for discussion': '논의 표시됨',
  '(not an allowed status)': '(허용되지 않는 상태)',
  'Validation fails on this status. Allowed statuses: {0}':
    '이 상태는 검증에서 실패합니다. 허용되는 상태: {0}',
  'Status': '상태',
  'Workflows done': '완료한 워크플로',
  'Last updated': '마지막 수정',
  'Project': '과제',
  '(no project)': '(과제 없음)',
  'Search experiments': '실험 검색',
  'Group experiments by': '실험 묶는 기준',
  'By status': '상태별',
  'By project': '과제별',
  'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.':
    '노트에서 @dna처럼 입력하거나 우클릭 → "{0}"(으)로 샘플을 등록합니다.',

  // Pickers / prompts
  'New experiment': '새 실험',
  'Experiment title': '실험 제목',
  'Title is required.': '제목을 입력해야 합니다.',
  'The title has no characters usable in a folder name. Add letters or numbers.':
    '제목에 폴더 이름으로 쓸 수 있는 글자가 없습니다. 글자나 숫자를 넣어 주세요.',
  'Select workflow': '워크플로 선택',
  'Search workflows': '워크플로 검색',
  'Search unit operations': '유닛 오퍼레이션 검색',
  'Open a lab note first.': '먼저 랩노트 파일을 여세요.',
  'Select a status': '상태를 선택하세요',
  'The current status "{0}" is not an allowed value. Select a status':
    '현재 값 "{0}"은(는) 허용 목록에 없습니다. 상태를 선택하세요',
  'current': '현재',
  'Workflow name': '워크플로 이름',
  'Enter a name for this workflow': '이 워크플로의 상세 별칭을 입력하세요',
  'Unit operation alias': '유닛 오퍼레이션 별칭',
  '{0}/{1} characters in the folder name. Anything longer is cut from the folder name only; the experiment title keeps it all.':
    '폴더 이름 기준 {0}/{1}자. 넘는 부분은 폴더 이름에서만 잘리고, 실험 제목에는 전체가 남습니다.',
  '{0}/{1} characters in the file name. Anything longer is cut from the file name only; the workflow title and checklist keep it all.':
    '파일 이름 기준 {0}/{1}자. 넘는 부분은 파일 이름에서만 잘리고, 워크플로 제목과 체크리스트에는 전체가 남습니다.',
  "This workflow's name is long, so the alias won't fit in the file name. The title and checklist still keep it.":
    '이 워크플로는 이름이 길어 별칭이 파일 이름에 들어가지 않습니다. 제목과 체크리스트에는 남습니다.',
  '{0} characters · no limit (not used in a file name)': '{0}자 · 글자 수 제한 없음 (파일 이름에 쓰이지 않음)',
  'A workflow is a note for one design, build, test or learn stage of the experiment. The alias tells uses of the same workflow apart and also goes into the file name and the README checklist. You can leave it empty.':
    '워크플로는 실험을 이루는 설계·구축·시험·학습 단계 가운데 하나를 기록하는 노트입니다. 별칭은 같은 워크플로를 여러 번 쓸 때 서로 구분하는 이름으로, 파일 이름과 README 체크리스트에 함께 쓰입니다. 비워 두어도 됩니다.',
  'A unit operation is a single task within a workflow (one step using a piece of equipment or software). The alias tells repeats of the same task apart by run or condition and appears in its heading and the table of contents. You can leave it empty.':
    '유닛 오퍼레이션은 워크플로 안에서 수행하는 개별 작업(장비나 소프트웨어를 쓰는 한 단계)입니다. 별칭은 같은 작업을 여러 번 할 때 회차나 조건을 구분하는 이름으로, 제목 줄과 목차에 쓰입니다. 비워 두어도 됩니다.',
  'Equipment': '장비',
  'Software': '소프트웨어',
  'Run or condition of this step (optional)': '이 공정의 회차·조건 별칭(선택)',

  // Notices / results
  'Experiment created: {0}': '실험이 생성되었습니다: {0}',
  'Workflow numbering is already sequential.': '워크플로 번호가 이미 순서대로입니다.',
  'Renumber {0} workflow file(s) in {1}?': '{1}의 워크플로 파일 {0}개의 번호를 다시 매길까요?',
  'Renumbered {0} workflow file(s).': '워크플로 파일 {0}개의 번호를 다시 매겼습니다.',
  'Renumber {0} workflow file(s) in {1} and add {2} file(s) missing from the README checklist?':
    '{1}의 워크플로 파일 {0}개의 번호를 다시 매기고, README 체크리스트에 없는 {2}개를 등록할까요?',
  'Add {0} workflow file(s) missing from the README checklist of {1}?':
    '{1}의 README 체크리스트에 없는 워크플로 파일 {0}개를 등록할까요?',
  'Added {0} workflow file(s) to the README checklist.':
    'README 체크리스트에 워크플로 파일 {0}개를 등록했습니다.',
  'This experiment has no README.labnote.md.': '이 실험에는 README.labnote.md가 없습니다.',
  'README.labnote.md has no "Related Workflows" section.':
    'README.labnote.md에 "Related Workflows" 절이 없습니다.',
  'These checklist entries do not point to a workflow file in this folder. Remove them from the checklist?':
    '아래 체크리스트 항목은 이 폴더의 워크플로 파일을 가리키지 않습니다. 체크리스트에서 지울까요?',
  'Remove from checklist': '체크리스트에서 지우기',
  'file not found': '파일 없음',
  'in another folder': '다른 폴더',
  'No changes made.': '바꾼 것이 없습니다.',
  'The workflow checklist already matches the folder.': '워크플로 체크리스트가 이미 폴더와 일치합니다.',
  'Workflow checklist updated: {0} added, {1} removed.':
    '워크플로 체크리스트를 고쳤습니다: {0}개 추가, {1}개 제거.',
  '"{0}" is no longer a workflow note: its name must end in .labnote.md, so the README checklist stopped following it. Rename it to "{1}"?':
    '"{0}"은(는) 이름이 .labnote.md로 끝나지 않아 워크플로 노트에서 빠졌고, README 체크리스트도 더 이상 따라가지 않습니다. "{1}"(으)로 이름을 고칠까요?',
  '"{0}" is no longer a workflow note: its name must start with ###_ and end in .labnote.md, so the README checklist stopped following it.':
    '"{0}"은(는) 이름이 ###_로 시작하고 .labnote.md로 끝나야 워크플로 노트로 인식됩니다. README 체크리스트가 더 이상 따라가지 않습니다.',
  'Fix name': '이름 고치기',
  '"{0}" looks like a copy of a workflow note, but its name does not end in .labnote.md, so it is not a workflow note yet. Rename it to "{1}" and add it to the README checklist?':
    '"{0}"은(는) 워크플로 노트의 복사본으로 보이지만 이름이 .labnote.md로 끝나지 않아 아직 워크플로 노트가 아닙니다. "{1}"(으)로 이름을 바꾸고 README 체크리스트에 등록할까요?',
  'Rename and add': '이름 바꾸고 등록',
  '"{0}" is not a workflow note until its name starts with ###_ and ends in .labnote.md. Once it does, run "{1}" to add it to the README checklist.':
    '"{0}"은(는) 이름이 ###_로 시작하고 .labnote.md로 끝나야 워크플로 노트가 됩니다. 이름을 고친 뒤 "{1}"을(를) 실행하면 README 체크리스트에 등록됩니다.',
  'Add "{0}" to the README checklist?': '"{0}"을(를) README 체크리스트에 등록할까요?',
  'Add to checklist': '체크리스트에 등록',
  'Added "{0}" to the README checklist.': '"{0}"을(를) README 체크리스트에 등록했습니다.',
  "Reset the dates of the copy {0}: created today, with the end date and the unit operations' Start_date/End_date emptied.":
    '복사본 {0}의 날짜를 초기화했습니다: 생성일은 오늘로, 종료일과 유닛 오퍼레이션의 Start_date/End_date는 비웠습니다.',
  'Workflow notes moved into {0} are not in its README checklist yet. Run "{1}" to add them.':
    '{0}(으)로 옮겨 온 워크플로 노트가 README 체크리스트에 없습니다. "{1}"을(를) 실행해 등록하세요.',
  'Experiment status changed ({0}): {1} → {2}': '실험 상태가 변경되었습니다({0}): {1} → {2}',
  '(none)': '(없음)',
  'To undo, run "{0}" again and pick {1}.': '되돌리려면 "{0}"을(를) 다시 실행해 {1}을(를) 고르세요.',
  'To undo, right-click this experiment in the workflow view again and pick {0}.':
    '되돌리려면 워크플로 뷰에서 이 실험을 다시 우클릭해 {0}을(를) 고르세요.',
  '{0} workflow(s) in the checklist are not checked and {1} workflow note(s) have no end_date. Mark the experiment completed anyway?':
    '체크리스트에서 체크하지 않은 워크플로가 {0}개, 종료일(end_date)이 빈 워크플로 노트가 {1}개 있습니다. 그래도 completed로 바꿀까요?',
  'Mark completed': 'completed로 바꾸기',
  'This vault is not a git repository yet, so no review issue will open. Finish the repository setup in {0} first.':
    '이 보관함은 아직 git 저장소가 아니라 검토 이슈가 생성되지 않습니다. 먼저 {0}의 저장소 연결을 마치세요.',
  'To open a review issue, run "Setup research automation" first.':
    "검토 이슈를 열려면 먼저 '연구노트 자동화 설정'을 실행하세요.",
  'Flagged for discussion. An issue opens on the next push.':
    '논의 표시를 설정했습니다. 다음 push 때 이슈가 생성됩니다.',
  'Discussion flag cleared. Any issue already opened stays open.':
    '논의 표시를 해제했습니다. 이미 생성된 이슈는 닫히지 않습니다.',
  'Flagged for discussion. To open it as an issue, run "Setup research automation" first.':
    "논의 표시를 설정했습니다. 이슈로 올리려면 먼저 '연구노트 자동화 설정'을 실행하세요.",
  'Discussion flag cleared.': '논의 표시를 해제했습니다.',
  "Changed {0}'s README, not this note.": '이 노트가 아니라 {0}의 README를 바꿨습니다.',
  'Issue marker inserted. To open it as an issue, run "Setup research automation" first.':
    "이슈 마커를 넣었습니다. 이슈로 올리려면 먼저 '연구노트 자동화 설정'을 실행하세요.",
  'Issue topic sentence': '이슈 주제 문장',
  'This sentence becomes the issue title. Keep the sentence from this line or type another.':
    '이 문장이 이슈 제목이 됩니다. 이 줄의 문장을 그대로 두거나 다른 문장을 입력하세요.',
  'Enter the topic sentence of the issue.': '이슈의 주제 문장을 입력하세요.',
  'Flagged for discussion. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.':
    '논의 표시를 설정했습니다. 이 보관함은 아직 git 저장소가 아니라 이슈가 생성되지 않습니다. 먼저 {0}의 저장소 연결을 마치세요.',
  'Issue marker inserted. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.':
    '이슈 마커를 넣었습니다. 이 보관함은 아직 git 저장소가 아니라 이슈가 생성되지 않습니다. 먼저 {0}의 저장소 연결을 마치세요.',
  'This vault is not a git repository yet, so issues and checks will not run. Finish the repository setup in {0}.':
    '이 보관함은 아직 git 저장소가 아니라 이슈 생성·검사가 동작하지 않습니다. {0}의 저장소 연결을 마치세요.',
  'Issue markers cannot go inside a table. Run this on a line below the table.':
    '표 안에서는 이슈 마커를 넣을 수 없습니다. 표 아래 줄에서 실행하세요.',
  'Issue markers cannot go in the front matter. Run this in the note body.':
    '머리말(front matter)에는 이슈 마커를 넣을 수 없습니다. 본문에서 실행하세요.',
  'Issue markers inside a code block open no issue. Run this on a line outside the code block.':
    '코드 블록 안의 이슈 마커는 이슈를 열지 않습니다. 코드 블록 밖의 줄에서 실행하세요.',
  'This marker ID appears more than once in this note.': '이 마커 ID는 이 노트에 두 번 이상 있습니다.',
  'This marker ID is already used in {0}.': '이 마커 ID는 이미 {0}에서 쓰고 있습니다.',
  'Marker ID {0} appears twice in this note, so the two questions merge into one issue. Delete one of these markers and insert it again with "Insert issue marker".':
    '마커 ID {0}이(가) 이 노트에 두 번 있어 두 질문이 한 이슈로 합쳐집니다. 그중 하나를 지우고 "논의 이슈 마커 삽입"으로 다시 넣으세요.',
  'Marker ID {0} is also used in {1}, so the two questions merge into one issue. Delete the marker in this note (underlined) and insert it again with "Insert issue marker".':
    '마커 ID {0}은(는) {1}에서도 쓰고 있어 두 질문이 한 이슈로 합쳐집니다. 이 노트의 그 마커(물결 밑줄)를 지우고 "논의 이슈 마커 삽입"으로 다시 넣으세요.',
  'A date cannot go on a front matter line that has a value. Run this in the body or on an empty value.':
    '머리말(front matter)의 값이 있는 줄에는 날짜를 넣을 수 없습니다. 본문이나 빈 값 칸에서 실행하세요.',
  'This Start_date/End_date already has a value. Use the 📅 picker next to it to change the date.':
    '이 Start_date/End_date에는 이미 값이 있습니다. 날짜를 바꾸려면 옆의 📅 피커를 쓰세요.',
  'This line already has an issue marker. A line can hold only one.':
    '이 줄에는 이미 이슈 마커가 있습니다. 한 줄에 하나만 둘 수 있습니다.',
  'Front matter of this note could not be read, so it was left unchanged. Fix the YAML and try again: {0}':
    '이 노트의 front matter를 읽을 수 없어 변경하지 않았습니다. YAML을 고친 뒤 다시 시도하세요: {0}',
  '{0} differs from the new version. Edits made after it was installed are lost if you replace it. Replace it with the new version?':
    '{0}이(가) 새 버전과 다릅니다. 설치 뒤에 직접 고친 내용이 있다면 바꿀 때 사라집니다. 새 버전으로 바꿀까요?',
  'From then on, updates change only the marked block and keep what you write below it.':
    '이번에 바꾸면 다음부터는 업데이트가 표시된 블록만 바꾸고, 그 아래 적은 내용은 그대로 둡니다.',
  'Pasted images are saved at the top of the vault. Save them in an images folder next to the note instead (for a lab note, the experiment\'s images folder)? This changes Settings → Files and links → Default location for new attachments to "./images".':
    '붙여넣은 이미지가 보관함 맨 위에 저장되고 있습니다. 노트 옆 images 폴더(랩노트라면 실험의 images 폴더)에 저장할까요? 설정 → 파일 및 링크 → 새 첨부 파일의 기본 위치를 "./images"로 바꿉니다.',
  'Use ./images': './images 쓰기',
  'New attachments now go to the images folder next to each note.':
    '이제 새 첨부 파일은 각 노트 옆 images 폴더에 저장됩니다.',
  'The marked block of {0} was edited after it was installed. Replace the block with the new version? Text outside the block is kept.':
    '{0}의 표시된 블록이 설치 후 고쳐졌습니다. 블록을 새 버전으로 바꿀까요? 블록 밖의 내용은 그대로 둡니다.',
  'Research automation set up ({0} written, {1} merged, {2} skipped, {3} removed). Researchers: see {4}. Admin setup: {5} (run `git config core.hooksPath {6}`).':
    '연구노트 자동화를 설정했습니다 (생성 {0} · 병합 {1} · 건너뜀 {2} · 정리 {3}). 연구원 안내는 {4}, 관리자 설정은 {5} 문서를 확인하고 `git config core.hooksPath {6}`을 실행하세요.',
  'Remove {0} file(s) left by the previous layout ({1})? Afterwards run `git config core.hooksPath {2}` so the pre-commit hook keeps working.':
    '이전 구조에서 남은 파일 {0}개를 삭제할까요? ({1}) 삭제 후 `git config core.hooksPath {2}`를 실행해야 pre-commit 훅이 계속 동작합니다.',
  'Remove': '삭제',
  'Delete these lines from .gitignore so agent skills can be committed: {0}':
    '에이전트 스킬이 커밋되도록 .gitignore에서 다음 줄을 직접 지우세요: {0}',
  'Exported {0} CSV file(s).': 'CSV 파일 {0}개를 내보냈습니다.',
  'Renamed {0} CSV file(s) so their numbers sort in table order: {1}. Update these paths in any analysis script.':
    '이름순으로 표 순서대로 놓이도록 번호 자릿수를 맞춰 CSV {0}개의 이름을 바꿨습니다: {1}. 분석 스크립트에서 이 파일 경로를 쓰고 있다면 고쳐 주세요.',
  'Could not rename {0} old CSV file(s); they keep their old names.':
    '옛 CSV {0}개는 이름을 바꾸지 못해 옛 이름 그대로 남았습니다.',
  'Exported {0} CSV file(s) ({1} unchanged file(s) left as they were).':
    'CSV 파일 {0}개를 내보냈습니다(내용이 같은 {1}개는 그대로 둠).',
  'The CSV files are already up to date ({0}).': 'CSV 파일이 이미 최신입니다({0}개).',
  'Saved in {0}: {1}.': '저장 위치 {0}: {1}.',
  'The file explorer shows CSV files only when Settings → Files and links → Show all file types is on.':
    '파일 탐색기에는 설정 → 파일 및 링크 → 모든 파일 확장명 인식이 켜져 있을 때만 CSV 파일이 보입니다.',
  'No tables found in this note.': '이 노트에서 표를 찾을 수 없습니다.',
  'These table CSV files no longer match a table in the note. Move them to the trash?\n\n{0}':
    '다음 표 CSV 파일은 이 노트에 더 이상 해당하는 표가 없습니다. 휴지통으로 옮길까요?\n\n{0}',
  'The table CSV files of the deleted note(s) are still in the folder. Move them to the trash?\n\n{0}':
    '삭제한 노트의 표 CSV 파일이 폴더에 남아 있습니다. 휴지통으로 옮길까요?\n\n{0}',
  'Move to trash': '휴지통으로 옮기기',
  '{0} CSV file(s) moved to the trash.': 'CSV 파일 {0}개를 휴지통으로 옮겼습니다.',
  '{0} old CSV file(s) kept.': '이전 CSV 파일 {0}개는 남겨 두었습니다.',
  '{0} CSV file(s) could not be moved to the trash.': 'CSV 파일 {0}개를 휴지통으로 옮기지 못했습니다.',
  'These CSV files would now hold a different table (a table was added, removed or moved). Overwrite them?\n\n{0}':
    '다음 CSV 파일에 다른 표가 들어가게 됩니다(표가 추가·삭제되었거나 순서가 바뀌었습니다). 덮어쓸까요?\n\n{0}',
  'The header of these CSV files changed. Overwrite them?\n\n{0}':
    '다음 CSV 파일의 머리글이 바뀌었습니다. 덮어쓸까요?\n\n{0}',
  '{0} rows → {1} rows': '{0}행 → {1}행',
  'row {0}: {1} → {2}': '{0}번째 행: {1} → {2}',
  'Command failed: {0}': '명령 실행 실패: {0}',
  'Command failed: the path is too long for the file system (Windows allows {0} characters including the vault folder). Move the vault to a shorter folder path, or shorten the title or alias.':
    '명령 실행 실패: 경로가 너무 길어 파일을 만들 수 없습니다(Windows는 보관함 폴더를 포함해 {0}자까지 허용). 보관함을 더 짧은 경로의 폴더로 옮기거나 제목·별칭을 줄이세요.',
  '"{0}" is {1} characters long including the vault folder, past the {2} Windows allows. Opening it on Windows (including git clones) may fail; move the vault to a shorter folder path or shorten the name.':
    '"{0}"은(는) 보관함 폴더를 포함한 경로가 {1}자로, Windows가 허용하는 {2}자를 넘습니다. Windows에서 열거나 git으로 받을 때 실패할 수 있으니 보관함을 더 짧은 경로의 폴더로 옮기거나 이름을 줄이세요.',
  'Yes': '예',
  'Workflow created: {0}': '워크플로가 생성되었습니다: {0}',
  'This experiment has no README.labnote.md, so the workflow was not added to a checklist.':
    '이 실험에는 README.labnote.md가 없어 워크플로를 체크리스트에 등록하지 못했습니다.',
  'Unit operation inserted: {0} {1}': '유닛 오퍼레이션이 삽입되었습니다: {0} {1}',
  '(after {0})': '({0} 다음)',
  '(before the first unit operation)': '(첫 유닛 오퍼레이션 앞)',
  '(after the last unit operation)': '(마지막 유닛 오퍼레이션 다음)',
  'Please open a workflow file.': '워크플로 파일을 열어주세요.',
  'Please run this command on a workflow file inside the labnote folder.':
    'labnote 폴더 내의 워크플로 파일에서 실행해주세요.',
  'README.labnote.md is the experiment overview and holds no unit operations. Open one of its workflow notes (###_….labnote.md), or make one with "{0}".':
    'README.labnote.md는 실험 개요 노트라 유닛 오퍼레이션을 넣지 않습니다. 이 실험의 워크플로 노트(###_….labnote.md)를 열거나 "{0}"으로 새로 만드세요.',
  '"{0}" is not a workflow note: unit operations go into a ###_….labnote.md note directly in the experiment folder. Open one, or make one with "{1}".':
    '"{0}"은(는) 워크플로 노트가 아닙니다. 유닛 오퍼레이션은 실험 폴더 바로 아래의 ###_….labnote.md 노트에 넣습니다. 그런 노트를 열거나 "{1}"으로 새로 만드세요.',
  'Missing unit operation info.': '유닛 오퍼레이션 정보가 없습니다.',

  // Sample view context menu
  'Copy sample ID': '샘플 ID 복사',
  'Copied: {0}': '복사했습니다: {0}',
  'Insert reference': '참조 삽입',
  'View usages': '사용처 보기',
  '{0} is not used in any note.': '{0}을(를) 쓰는 노트가 없습니다.',
  'Notes using {0} ({1})': '{0}을(를) 쓰는 노트({1}개)',
  'Add sample': '샘플 추가',
  'Search samples': '샘플 검색',
  'Select sample type': '샘플 타입 선택',
  'Edit sample': '샘플 편집',
  'Delete sample': '샘플 삭제',
  'Mark as discarded': '폐기로 표시',
  'Unmark discarded': '폐기 표시 해제',
  'Marked {0} as discarded.': '{0}을(를) 폐기로 표시했습니다.',
  '{0} is no longer marked discarded.': '{0}의 폐기 표시를 해제했습니다.',
  '(discarded)': '(폐기)',
  'Discarded': '폐기',
  'Move to Global': '전역으로 이동',
  'Move to Local': '로컬로 이동',
  'Change type': '타입 변경',
  'Change the type of {0}': '{0}의 타입 변경',
  'Pick the new type': '새 타입 선택',
  'Change {0} to {1}? Its record moves from {2}.json to {3}.json.':
    '{0}을(를) {1}(으)로 바꿀까요? 기록이 {2}.json에서 {3}.json으로 옮겨집니다.',
  'The notes that use it change too ({0}):': '이 샘플을 쓰는 노트도 함께 바뀝니다({0}):',
  'Changed {0} to {1}.': '{0}을(를) {1}(으)로 바꿨습니다.',
  'Ctrl+Z only reverts the note, not the sample record. To undo, change the type again.':
    'Ctrl+Z로는 노트만 되돌아가고 샘플 기록은 그대로입니다. 되돌리려면 타입 변경을 다시 하세요.',
  'Sample tracking is off for this note.': '이 노트는 샘플 추적이 꺼져 있습니다.',
  'No samples are registered yet.': '아직 등록된 샘플이 없습니다.',
  'Search by ID or alias': 'ID나 별칭으로 검색',
  'Open a note to insert into.': '삽입할 노트를 여세요.',
  'This note was in reading view, so it was switched to editing view to make the change.':
    '읽기 화면이던 노트를 편집 화면으로 바꿔서 고쳤습니다.',
  'The note changed while switching to editing view. Run the command again.':
    '편집 화면으로 바꾸는 사이에 노트 내용이 달라졌습니다. 명령을 다시 실행해 주세요.',
  'Open a note of an experiment to list its samples.': '시료 목록을 넣으려면 실험 안의 노트를 여세요.',
  'This experiment has no samples yet.': '이 실험에는 아직 시료가 없습니다.',
  'Inserted {0} sample(s).': '시료 {0}개를 표로 넣었습니다.',
  'Local': '로컬',
  'Global': '전역',
  'Open a note first to add a local sample.': '로컬 샘플을 추가하려면 먼저 노트를 여세요.',
  'Notes outside an experiment use the Global samples below. Open an experiment note to see its samples.':
    '실험 밖 노트는 아래 Global 샘플을 씁니다. 실험 노트를 열면 그 실험의 시료가 보입니다.',
  'No samples found.': '샘플을 찾을 수 없습니다.',

  // Sample create / autocomplete actions
  'Generate new {0} ID': '새 {0} ID 생성',
  'Automatically generate a new sample ID': '샘플 ID를 자동으로 생성합니다',
  'Enter info': '직접 입력',
  'Manually enter sample ID, alias, and description': '샘플 ID·별칭·설명을 직접 입력합니다',
  'Search catalog': '카탈로그 검색',
  'Search {0} catalog': '{0} 카탈로그 검색',
  'Insert a reference from the product catalog': '제품 카탈로그에서 참조를 삽입합니다',
  'No {0} catalog entries found (resources/labsamples/{0}_*.json). Create a new {0} sample instead?':
    '{0} 카탈로그에 항목이 없습니다(resources/labsamples/{0}_*.json). 대신 새 {0} 샘플을 만들까요?',
  'Create sample': '샘플 만들기',

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
  'No definition found for {0}. It is not in the sample registry: it may have been deleted or moved to another experiment, or the Global sample folder setting changed.':
    '{0}의 정의를 찾을 수 없습니다. 시료 대장에 없는 시료입니다. 대장에서 지웠거나 다른 실험으로 옮겼거나, 전역 샘플 폴더 설정을 바꿨을 수 있습니다.',
  'Not in the sample registry': '시료 대장에 없는 시료',
  'Close': '닫기',
  'Enter the {0} sample ID': '{0} 샘플 ID를 입력하세요',
  'e.g. {0}-12345': '예: {0}-12345',
  'Invalid ID. Expected {0}-<number>.': '잘못된 ID입니다. {0}-<숫자> 형식이어야 합니다.',
  '{0} already exists. Its current values are filled in, and a new description is added before the earlier ones.':
    '{0}은(는) 이미 있습니다. 지금 값이 채워져 있고, 새 설명은 기존 설명 앞에 더해집니다.',
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
  'Local {0} sample': '로컬 {0} 샘플',
  'Global {0} sample': '전역 {0} 샘플',
  'Global samples already have the alias {0} ({1}). Autocomplete will show both, marked Local and Global.':
    '전역 샘플에 같은 별칭 {0}({1})이 이미 있습니다. 자동완성에는 로컬과 전역으로 구분되어 둘 다 보입니다.',
  'This experiment already has the alias {0} ({1}). Autocomplete cannot tell the two apart, so picking the existing sample is usually better.':
    '이 실험에 같은 별칭 {0}({1})이 이미 있습니다. 자동완성에서 둘을 구분할 수 없으니 있는 샘플을 고르는 편이 좋습니다.',
  'Global samples already have the alias {0} ({1}). Autocomplete cannot tell the two apart, so picking the existing sample is usually better.':
    '전역 샘플에 같은 별칭 {0}({1})이 이미 있습니다. 자동완성에서 둘을 구분할 수 없으니 있는 샘플을 고르는 편이 좋습니다.',
  '{0} was added to Global samples because this note is outside an experiment folder.':
    '이 노트는 실험 폴더 밖에 있어 {0}을(를) 전역 샘플에 추가했습니다.',
  'Sample updated: {0}': '샘플이 수정되었습니다: {0}',
  '{0} is also registered in other experiments ({1}); only this one changed.':
    '{0}은(는) 다른 실험의 대장에도 있습니다({1}). 이번 편집은 이 실험의 기록만 바꿨습니다.',
  'Sample deleted: {0}': '샘플이 삭제되었습니다: {0}',
  "Replace the old alias '{1}' with '{2}' in {0} note(s)?\n\n{3}":
    "노트 {0}개에 남은 옛 별칭 '{1}'을(를) '{2}'(으)로 바꿀까요?\n\n{3}",
  "Remove the old alias '{1}' from {0} note(s)?\n\n{2}":
    "노트 {0}개에 남은 옛 별칭 '{1}'을(를) 지울까요?\n\n{2}",
  "Add the alias '{1}' to the references that show only the ID {2} in {0} note(s)?\n\n{3}":
    "노트 {0}개에서 ID {2}만 적힌 참조에 별칭 '{1}'을(를) 붙일까요?\n\n{3}",
  '{0} definition(s), {1} reference(s)': '정의 {0}개, 참조 {1}개',
  '{0} note(s) still show the old alias.': '노트 {0}개에 옛 별칭이 남아 있습니다.',
  'Saving a note that defines it may bring the old alias back.':
    '옛 별칭으로 정의한 노트를 저장하면 별칭이 되돌아갈 수 있습니다.',
  '{0} is still used in notes ({1}). Remove it from the note(s) first, then delete.':
    '{0}은(는) 본문에서 사용 중이라 삭제할 수 없습니다 ({1}). 본문에서 먼저 지운 뒤 다시 삭제하세요.',
  'To keep it for those notes but show it as used up, mark it discarded instead.':
    '그 노트를 위해 기록은 남기고 다 쓴 시료로 보이게 하려면 대신 폐기로 표시하세요.',
  '{0} (+{1} more)': '{0} 외 {1}개',
  '{0} is used in notes outside this experiment ({1}). Those notes will no longer find it after the move. Move anyway?':
    '{0}은(는) 이 실험 밖의 노트에서 쓰이고 있습니다({1}). 옮기면 그 노트에서는 이 시료를 찾지 못합니다. 그래도 옮길까요?',
  'Move anyway': '그래도 옮기기',
  'Sample moved: {0}': '샘플을 이동했습니다: {0}',
  'An alias cannot contain ";" or ":", which separate the ID, alias and description in a note. Use "-" or "/" instead (e.g. 1-10).':
    '별칭에는 ";"나 ":"를 쓸 수 없습니다. 노트에서 ID·별칭·설명을 가르는 글자입니다. 대신 "-"나 "/"를 쓰세요(예: 1-10).',
  'An alias cannot contain #, [[, ]], * or `, which Markdown reads as a tag, link, emphasis or code. Use "-" or "/" instead.':
    '별칭에는 #, [[, ]], *, `를 쓸 수 없습니다. 마크다운이 태그·링크·강조·코드로 읽는 글자입니다. 대신 "-"나 "/"를 쓰세요.',
  'A description cannot contain ";", which ends the description in a note. Use "," instead.':
    '설명에는 ";"를 쓸 수 없습니다. 노트에서 설명을 끝내는 글자입니다. 대신 ","를 쓰세요.',
  "Notes in {0} use {1} local sample(s) that are still in another experiment's registry, so the notes cannot find them. Bring them into {0}?":
    '{0}의 노트가 쓰는 로컬 시료 {1}개가 다른 실험의 대장에 남아 있어 노트에서 찾을 수 없습니다. {0}(으)로 가져올까요?',
  'move from {0}': '{0}에서 옮김',
  'copy from {0} (still used there)': '{0}에서 복사(그 실험의 다른 노트도 씀)',
  'Bring samples': '시료 가져오기',
  'Bring samples (copies are edited separately from now on)': '시료 가져오기(복사한 시료는 앞으로 따로 고쳐집니다)',
  'Move samples the other experiment still uses to Global, bring the rest':
    '원래 실험에서도 쓰는 시료는 전역으로 옮기고 나머지는 가져오기',
  'Moved to Global: {0}': '전역으로 옮겼습니다: {0}',
  'Global already has {0}, so it was copied instead.': '전역에 {0}이(가) 이미 있어 대신 복사했습니다.',
  'Brought {0} local sample(s) into {1}.': '로컬 시료 {0}개를 {1}(으)로 가져왔습니다.',
  'The local samples stay in {0}. To bring them later, run "{1}" from a note in {2}.':
    '로컬 시료는 {0}에 그대로 두었습니다. 나중에 가져오려면 {2}의 노트에서 "{1}"을(를) 실행하세요.',
  'These samples are registered in more than one other experiment, so they were not brought in: {0}':
    '다음 시료는 다른 실험 여러 곳의 대장에 있어 어느 쪽을 가져올지 정할 수 없으므로 가져오지 않았습니다: {0}',
  'Sample not found: {0}': '샘플을 찾을 수 없습니다: {0}',
  'Open an experiment note first to move samples.': '샘플을 이동하려면 먼저 실험 노트를 여세요.',
  'The open note is outside an experiment. Open a note of the experiment to move it to, then try again.':
    '지금 열린 노트가 실험 밖에 있습니다. 옮길 실험의 노트를 연 뒤 다시 실행하세요.',
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
  'Comma-separated types in addition to the built-ins. Use letters, digits and _ only (no spaces or -), e.g. CellLine, 배지.':
    '기본 제공 타입 외에 추가할 타입을 쉼표로 구분해 입력합니다. 글자·숫자·_만 쓰세요(공백·- 불가). 예: CellLine, 배지',
  '{0}: a space or - keeps a type from autocompleting, so it was not saved. Use {1} instead.':
    '{0}: 공백이나 -가 들어간 타입은 자동완성되지 않아 저장하지 않았습니다. 대신 {1}처럼 쓰세요.',
  '{0} cannot be autocompleted in notes (a space or -). Rename it, e.g. {1}, if you have no samples of it yet.':
    '{0}은(는) 공백이나 -가 있어 노트에서 자동완성되지 않습니다. 아직 그 타입의 샘플이 없다면 {1}처럼 이름을 바꾸세요.',
  '{0}: {1} sample(s)': '{0}: 샘플 {1}개',
  'Samples of the removed sample type(s) will no longer show:\n\n{0}\n\nPut the type(s) back in the list?':
    '빠진 타입의 샘플이 더 이상 보이지 않게 됩니다:\n\n{0}\n\n그 타입을 목록에 다시 넣을까요?',
  'Put back': '다시 넣기',
  'Put back: {0}': '다시 넣었습니다: {0}',
  'Global sample folder': '전역 샘플 폴더',
  'Vault-relative folder for vault-global samples.':
    '볼트 전역 샘플을 저장할 볼트 기준 상대 폴더입니다.',
  'The old Global sample folder {0} still has {1} sample(s). Move them to the new folder {2}?':
    '옛 전역 샘플 폴더 {0}에 시료 {1}건이 남아 있습니다. 새 폴더 {2}(으)로 옮길까요?',
  'Product catalog files move too: {0}': '제품 카탈로그 파일도 함께 옮깁니다: {0}',
  'Move samples': '시료 옮기기',
  'Samples in the old folder are not shown. Set the folder back to see them again.':
    '옛 폴더의 시료는 보이지 않습니다. 설정을 되돌리면 다시 보입니다.',
  'Moved {0} sample(s) to {1}.': '시료 {0}건을 {1}(으)로 옮겼습니다.',
  '{0} catalog file(s) moved.': '카탈로그 파일 {0}개를 옮겼습니다.',
  'Not moved, {0} already has the same ID: {1}': '{0}에 같은 ID가 있어 옮기지 않았습니다: {1}',
  'Catalog files not moved, {0} already has them: {1}':
    '{0}에 같은 이름이 있어 옮기지 않은 카탈로그 파일: {1}',
  'Auto-sync unit operation TOC': '유닛오퍼레이션 TOC 자동 정렬',
  "Reorder a workflow note's Related Unit Operations list to match heading order after edits, and tidy the --- separators immediately when a block is moved.":
    '편집 후 워크플로 노트의 Related Unit Operations 목록을 헤딩 순서에 맞게 정렬하고, 블록을 옮기면 `---` 구분선도 즉시 정리합니다.',
  'Auto-update last updated date': '마지막 갱신일 자동 기록',
  "Set a lab note's last_updated_date to today (once a day) when you edit it, change its status or discussion flag, or the AI edits it. Editing a workflow note also updates its experiment README. Changes pulled from git are ignored. A date you type by hand is kept for the rest of that day; turning this off and on resumes it at once.":
    '연구노트를 편집하거나 상태·논의 표시를 바꾸거나 AI가 고치면 last_updated_date를 오늘 날짜로 바꿉니다(하루 한 번). 워크플로 노트를 고치면 실험 README도 함께 바뀝니다. git으로 받아온 변경은 반영하지 않습니다. 날짜를 손으로 고친 노트는 그날 하루 동안 고친 날짜를 그대로 두고, 이 설정을 껐다 켜면 바로 다시 기록합니다.',
  'Kept the last_updated_date you set by hand in {0}. It updates automatically again from tomorrow.':
    '{0}의 last_updated_date는 손으로 고친 값을 그대로 두었습니다. 내일부터 다시 자동으로 기록합니다.',
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
  'Desktop only. Exposes tools to external MCP clients. Tools that change the vault run only after you allow them in Obsidian.':
    '데스크톱 전용. 외부 MCP 클라이언트에 도구를 노출합니다. 볼트를 바꾸는 도구는 Obsidian에서 허용해야 실행됩니다.',
  'MCP token': 'MCP 토큰',
  'Bearer token for external MCP clients. It stays the same when Obsidian or the server restarts; regenerate it if it leaked, then paste the new one into every client.':
    '외부 MCP 클라이언트용 베어러 토큰입니다. Obsidian이나 서버를 다시 시작해도 유지됩니다. 유출됐다면 재발급하고, 새 토큰을 모든 클라이언트에 다시 붙여 넣으세요.',
  'Copy token': '토큰 복사',
  'Regenerate token': '토큰 재발급',
  'Click again to regenerate': '한 번 더 눌러 재발급',
  'New MCP token issued. The old token no longer works.':
    '새 MCP 토큰을 발급했습니다. 옛 토큰은 더 이상 쓸 수 없습니다.',
  'The new token could not be copied. Use "Copy token".':
    '새 토큰을 복사하지 못했습니다. `토큰 복사`를 누르세요.',
  'Current token ends in {0}.': '현재 토큰 끝자리: {0}',
  'MCP token copied to clipboard.': 'MCP 토큰을 클립보드에 복사했습니다.',
  'New MCP token copied to clipboard.': '새 MCP 토큰을 클립보드에 복사했습니다.',

  // AI commands
  'Configure an AI provider in settings first.': '먼저 설정에서 AI 프로바이더를 구성하세요.',
  'Contacting {0}…': '{0}에 연결 중…',
  'AI request failed: {0}': 'AI 요청 실패: {0}',
  'Settings': '설정',
  'Cannot connect to {0} ({1}). Check that it is running and that {2} is right.':
    '{0}에 연결할 수 없습니다({1}). 실행 중인지, {2} 값이 맞는지 확인하세요.',
  '{0} is not an http:// or https:// address. Check {1}: write it like {2}.':
    '{0}은(는) http:// 또는 https:// 주소가 아닙니다. {1} 값을 {2}처럼 적으세요.',
  'Without http:// or https://, http:// is added when connecting.':
    'http:// 또는 https://를 빼고 적으면 접속할 때 http://를 붙입니다.',
  'The API key is missing or wrong. Check {0}.': 'API 키가 없거나 잘못되었습니다. {0} 값을 확인하세요.',
  'Model {0} was not found. Check {1}.': '모델 {0}을(를) 찾을 수 없습니다. {1} 값을 확인하세요.',
  '{0} has no such address (404). Check {1}: enter only the server address, without a path such as /v1 or /api.':
    '{0}에서 요청 주소를 찾을 수 없습니다(404). {1} 값을 확인하세요. /v1이나 /api 같은 경로 없이 서버 주소만 적습니다.',
  "Which unit operation's Method should the draft go in?": '초안을 어느 단위 공정의 Method에 넣을까요?',
  'Has a Method already': 'Method 내용이 이미 있음',
  'This Method section already has content. Replace it with the AI draft?':
    '이 Method 절에는 이미 내용이 있습니다. AI 초안으로 바꿀까요?',
  'Replace': '바꾸기',
  'The unit operation changed while the AI was writing, so the draft was inserted after the cursor line instead.':
    'AI가 쓰는 동안 유닛 오퍼레이션이 바뀌어, 초안을 커서가 있는 줄 다음에 넣었습니다.',
  'Open a note first.': '먼저 노트를 여세요.',
  'Open a markdown note first.': '먼저 마크다운 노트를 여세요.',
  'Nothing to summarize.': '요약할 내용이 없습니다.',
  'Nothing to extract.': '추출할 내용이 없습니다.',
  'Created {0} sample(s).': '샘플 {0}개를 생성했습니다.',
  'Created {0} new sample(s); skipped {1} already registered or in the note.':
    '새로 {0}개를 만들고, 이미 등록됐거나 노트에 있는 {1}개는 건너뛰었습니다.',
  '"{0}" is not an experiment folder: its name must start with ###_ (e.g. 001_Name).':
    '"{0}"은(는) 실험 폴더가 아닙니다. 폴더 이름은 ###_로 시작해야 합니다(예: 001_이름).',
  '"{0}" is not recognized as an experiment: experiment folders must be directly under labnote/. Move it back to labnote/.':
    '"{0}"은(는) 실험으로 인식되지 않습니다. 실험 폴더는 labnote/ 바로 아래에 있어야 합니다. labnote/ 아래로 다시 옮기세요.',
  '"{0}" is no longer recognized as an experiment: experiment folders must be directly under labnote/. Workflow commands, the experiment list and Local samples will not find it.':
    '"{0}"은(는) 더 이상 실험으로 인식되지 않습니다. 실험 폴더는 labnote/ 바로 아래에 있어야 합니다. 워크플로 명령, 실험 목록, 로컬 샘플이 이 폴더를 찾지 못합니다.',
  'Move it back to {0}?': '{0} 아래로 다시 옮길까요?',
  'Move back': '다시 옮기기',
  '"{0}" is no longer an experiment folder: its name must start with ###_ (e.g. 001_Name). Workflow commands and Local samples will not find it.':
    '"{0}"은(는) 더 이상 실험 폴더가 아닙니다. 폴더 이름은 ###_로 시작해야 합니다(예: 001_이름). 워크플로 명령과 로컬 샘플이 이 폴더를 찾지 못합니다.',
  '"{0}" is no longer an experiment folder: its name must start with ###_ (e.g. 001_Name). Workflow commands and Local samples will not find it. Rename it to "{1}"?':
    '"{0}"은(는) 더 이상 실험 폴더가 아닙니다. 폴더 이름은 ###_로 시작해야 합니다(예: 001_이름). 워크플로 명령과 로컬 샘플이 이 폴더를 찾지 못합니다. 이름을 "{1}"(으)로 바꿀까요?',
  'These checklist labels do not match their file names. Update them?':
    '아래 체크리스트 라벨이 파일 이름과 맞지 않습니다. 라벨을 고칠까요?',
  'Update labels': '라벨 고치기',
  '{0} label(s) updated.': '라벨 {0}개를 고쳤습니다.',
  'These workflow files are listed more than once in the checklist. Remove the extra entries?':
    '아래 워크플로 파일이 체크리스트에 두 번 이상 올라 있습니다. 중복 항목을 지울까요?',
  'Remove duplicates': '중복 지우기',
  '{0} duplicate entry(ies) removed.': '중복 항목 {0}개를 지웠습니다.',
  '{0} checklist link(s) fixed.': '체크리스트 링크 {0}개를 고쳤습니다.',
  'These workflow notes are in a subfolder of this experiment. Move them back to the experiment folder?':
    '아래 워크플로 노트는 이 실험의 하위 폴더에 있습니다. 실험 폴더로 다시 옮길까요?',
  'Move to experiment folder': '실험 폴더로 옮기기',
  '{0} was not moved: the experiment folder already has a file with that name.':
    '{0}은(는) 실험 폴더에 같은 이름의 파일이 있어 옮기지 않았습니다.',
  'These workflow notes are in more than one subfolder of this experiment. Move the right one back to the experiment folder yourself: {0}':
    '아래 워크플로 노트가 이 실험의 하위 폴더 여러 곳에 있습니다. 맞는 쪽을 직접 실험 폴더로 옮기세요: {0}',
  '{0} note(s) moved back to the experiment folder.': '노트 {0}개를 실험 폴더로 옮겼습니다.',
  '{0} was moved to {1} and is no longer recognised as a workflow step. If that was a mistake, move it back directly under the experiment folder or run "{2}".':
    '{0}을(를) {1}(으)로 옮겨 실험 단계로 인식되지 않습니다. 실수였다면 실험 폴더 바로 아래로 되돌리거나 "{2}"을(를) 실행하세요.',
  "These notes' title and heading do not match their file names. Update them?":
    '아래 노트의 title과 제목이 파일 이름과 맞지 않습니다. 노트를 고칠까요?',
  'Update notes': '노트 고치기',
  "These notes' experimenter differs from the README author. Update them?":
    '아래 노트의 실험자(experimenter)가 README의 author와 다릅니다. 노트를 고칠까요?',
  '{0} unit operation line(s)': '유닛 오퍼레이션 {0}줄',
  '{0} kept because the unit operation has an End_date': '{0}줄은 End_date가 있는 유닛 오퍼레이션이라 유지',
  '{0} left empty because the unit operation is finished; fill it in yourself':
    '{0}줄은 끝난 유닛 오퍼레이션이라 비어 있는 채로 둠(직접 채우세요)',
  '(empty)': '(비어 있음)',
  '{0} note(s) updated.': '노트 {0}개를 고쳤습니다.',
  'Name this copy of the workflow': '복제한 워크플로의 이름',
  "Gave the {0} issue marker(s) of the copy new IDs, so they do not merge with the original's issues.":
    '복제본의 이슈 마커 {0}개에 새 ID를 붙였습니다(원본의 이슈와 섞이지 않게).',
  '{0} table CSV file(s) kept their old name: the new name was taken or the rename failed.':
    '표 CSV 파일 {0}개는 옛 이름 그대로 두었습니다. 새 이름의 파일이 이미 있거나 이름 변경에 실패했습니다.',
  'Moved {0} table CSV file(s) to {1} with the note.': '노트와 함께 표 CSV 파일 {0}개를 {1}(으)로 옮겼습니다.',
  '{0} table CSV file(s) stayed in {1}: a file with the same name is already in {2}, or the move failed.':
    '표 CSV 파일 {0}개는 {1}에 남았습니다. {2}에 같은 이름의 파일이 이미 있거나 옮기지 못했습니다.',
  '{0} got a new ID because theirs did not match <Type>-<number>.':
    '{0}개는 ID가 <타입>-<숫자> 형식이 아니어서 새 ID를 만들었습니다.',
  '{0} skipped: unknown sample type.': '{0}개는 알 수 없는 샘플 타입이라 건너뛰었습니다.',
  '{0} have no storage location; add it with Edit sample in the Samples view.':
    "{0}개는 보관 위치가 없습니다. 샘플 뷰에서 '샘플 편집'으로 넣으세요.",
  'This note is outside an experiment folder, so they were added to Global samples.':
    '이 노트는 실험 폴더 밖에 있어 전역 샘플에 추가했습니다.',

  // MCP server
  'MCP server is desktop-only.': 'MCP 서버는 데스크톱 전용입니다.',
  'MCP server started on 127.0.0.1:{0}': 'MCP 서버가 127.0.0.1:{0}에서 시작되었습니다',
  'MCP server port {0} is already in use.': 'MCP 서버 포트 {0}이(가) 이미 사용 중입니다.',
  'MCP server error: {0}': 'MCP 서버 오류: {0}',
  'Allow MCP tool "{0}" to modify the vault?': 'MCP 도구 "{0}"가 볼트를 수정하도록 허용할까요?',
  'Target: {0}': '대상: {0}',
  'This replaces section "{0}", which now has {1} line(s).':
    '절 "{0}"의 내용을 바꿉니다. 지금 {1}줄이 있습니다.',
  'This empties section "{0}", which now has {1} line(s).':
    '절 "{0}"의 내용을 모두 지웁니다. 지금 {1}줄이 있습니다.',
  'Its {0} nested heading(s) are replaced too.': '그 안의 하위 제목 {0}개도 함께 바뀝니다.',
  'Lines removed:': '사라지는 줄:',
  'Lines added:': '새로 들어가는 줄:',
  'No recorded lines are removed.': '지워지는 기록은 없습니다.',
  '(+{0} more line(s))': '(그 밖에 {0}줄)',
  'It is occurrence {0} of {1}, with its heading on line {2}.':
    '같은 절 {1}개 중 {0}번째로, 제목이 {2}번째 줄에 있습니다.',
  'This creates a {0} sample with a new ID.': '{0} 샘플을 새 ID로 만듭니다.',
  'This creates {0} sample {1}.': '{0} 샘플 {1}을(를) 만듭니다.',
  'This creates catalog workflow {0} {1}. File: {2}. It is also added to the checklist in {3}.':
    '카탈로그 워크플로 {0} {1}을(를) 새로 만듭니다. 파일: {2}. {3}의 체크리스트에도 등록합니다.',
  'This adds to {0} sample {1}.': '이미 있는 {0} 샘플 {1}에 더합니다.',
  'Alias: {0}': '별칭: {0}',
  'Storage location: {0}': '보관 위치: {0}',
  'Saved in the global samples folder {0}.': '전역 샘플 폴더 {0}에 저장합니다.',
  'Saved in the local samples folder {0}.': '로컬 샘플 폴더 {0}에 저장합니다.',
  'MCP tool "{0}" was not run: no answer in time.':
    'MCP 도구 "{0}"을(를) 실행하지 않았습니다: 시간 안에 응답이 없었습니다.',
  'MCP tool "{0}" was not run: the client disconnected.':
    'MCP 도구 "{0}"을(를) 실행하지 않았습니다: 클라이언트 연결이 끊겼습니다.',
  'Allow': '허용',
};

export default obsidianKo;
