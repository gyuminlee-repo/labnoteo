# help/ — 도움말 사이트와 기능 영상

Labnote Assistant 도움말 사이트(GitHub Pages)와 그 영상을 만드는 대본입니다.
플러그인 빌드(`main.js`)·테스트·릴리스에는 들어가지 않습니다.

```
help/
├── site/                      GitHub Pages로 배포되는 정적 사이트 (pages.yml이 이 폴더만 올림)
│   ├── index.html             한국어 페이지
│   ├── en/index.html          영어 페이지
│   ├── assets/                style.css, app.js
│   └── media/
│       ├── ko/<id>.mp4|.vtt|.jpg   영상, 자막(접근성용), 포스터
│       ├── en/<id>.mp4|.vtt|.jpg
│       ├── screens/<name>.png      GitHub 쪽 흐름 화면 사진
│       └── manifest.json           영상별 녹화 버전·길이 (녹화기가 갱신)
├── demos/<id>.yaml            영상 대본 (한 파일 = 한 영상, 한/영 자막을 함께 적음)
└── seeds/
    ├── <seed>.yaml            시드(영상의 시작 상태) 만드는 순서
    └── {ko,en}/*.md           (선택) 대본의 fs.write `from:`으로 넣는 긴 노트 본문. 지금 시드는 본문을 yaml에 직접 적음
```

## 영상 녹화

영상은 testpilotO(`sblabkribb/testpilot`)가 Obsidian을 CDP로 조작해 녹화합니다.
testpilotO의 `config/local.json`에 이 폴더(`labnoteo.helpDir`)와 `ffmpegExe`를 적어 둡니다.
녹화하는 동안에는 Obsidian을 앞에 두고 PC를 쓰지 않습니다.

testpilotO 폴더에서:

```bash
npm run demo -- --check                     # 대본·시드 검사 (Obsidian 없이)
npm run demo -- --install                   # 이 체크아웃의 manifest.json 버전 릴리스를 데모 볼트에 설치
npm run demo -- --seeds                     # 시드 만들기 (버전·언어별로 저장해 두고 재사용)
npm run demo -- create-workflow             # 영상 하나 다시 녹화 (한/영 둘 다)
npm run demo -- create-workflow --lang en   # 한 언어만
npm run demo -- --all                       # 전부
```

녹화가 성공하면 `site/media/<lang>/`에 복사되고 `site/media/manifest.json`이 갱신됩니다.
`--no-publish`를 붙이면 testpilotO `artifacts/demos/`에만 남깁니다(시험 녹화용).

## 갱신 규칙

- 기능이나 UI 문구가 바뀌면 해당 `demos/<id>.yaml`을 고치고 그 영상을 다시 녹화합니다.
- `site/media/manifest.json`의 `version`으로 오래된 영상을 찾습니다.
- `site/index.html`과 `site/en/index.html`은 짝으로 고칩니다. 문구는 한국어 기준입니다.
- 명령 이름은 [`src/l10n.ko.ts`](../src/l10n.ko.ts)의 실제 문자열을 씁니다. 한국어 페이지는 팔레트 명령을
  처음 소개할 때 화면과 같게 `한글 (English)`로, 우클릭 메뉴·창 라벨은 한글만 적습니다.
- 세부 규칙은 사이트에 옮겨 적지 않고 [QUICKSTART](../automation/templates/QUICKSTART.md)·README 절로 링크합니다.
