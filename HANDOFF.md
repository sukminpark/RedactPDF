# 가림PDF 인수인계

## 2026-09-10 현재 기준 — 공개본 버전 25

이 절이 아래 문서의 이전 Sites 배포 보류·버전 22·커밋 e2b740f 관련 상태를 대체한다. 과거 조사 기록과 AI세특 정적 통합 설명은 보존하되, 다음 작업은 반드시 이 절의 배포 상태를 기준으로 시작한다.

### 현재 공개 상태

- 공개 주소: https://garim-pdf.papermbl.chatgpt.site
- 최신 Sites 공개 배포: **버전 25**, 2026-09-10 완료
- Sites 소스 main과 현재 로컬 HEAD: d027967c29017bf303bd5b97604d06b56cf99689 (Enlarge favicon and app bar branding)
- 직전 기능·브랜딩 커밋: f39c1c8f593c183c74aa3c0dbf819570890e770f (Improve review workflow and favicon branding)
- 이번 세션은 Sites 원격 origin에만 푸시했다. 별도 github 원격은 이 세션에 동기화하지 않았으므로, GitHub 반영이 필요하면 먼저 원격 브랜치와 차이를 확인한다.

### 최근 반영 내용

- 왼쪽 페이지 썸네일에서 해당 페이지의 검토 완료 상태를 직접 토글할 수 있다. 썸네일 본문은 페이지 이동만 하며, 우측 하단 검토 상자·상단 검토 수와 같은 reviewed 상태를 공유한다.
- 삭제 후보가 하나 이상 선택되면, 미검토 페이지가 있어도 저장 버튼을 사용할 수 있다. 저장 시 미검토 쪽이 남아 있으면 “검토하지 않은 페이지가 있습니다” 확인창을 띄우고, “검토 없이 저장”은 검토 상태를 변경하지 않은 채 내보낸다.
- 가림PDF 아이콘은 진한 녹색 원형 배지 안의 흰 문서·가림선으로 통일했다. SVG, ICO, 16/32/48px PNG, 180px 터치 아이콘, 1024px 마스터를 같은 비율로 갱신했고, 앱바 표시도 36px에서 40px로 키웠다.

### 검증 및 다음 작업 시 주의

- 위 아이콘 변경 뒤 npm run build가 통과했다. 직전 기능 변경에서는 Vitest 49개 통과·2개 생략을 확인했다.
- 현재 작업 트리는 배포 후 깨끗한 상태여야 한다. 시작 시 먼저 git status --short를 확인하고, 사용자가 만든 변경은 보존한다.
- 공개 Sites를 다시 갱신할 때는 소스 변경 → 테스트·빌드 → 커밋 → Sites 원격 origin 푸시 → 배포 버전 저장 순서를 지킨다. 공개 반영 전에는 사용자에게 새 저장 버전을 공개할지 다시 확인한다.
- 이 프로젝트는 사용자의 원본 PDF·결과물·개인정보를 Git, Sites 배포물, 외부 로그에 절대 포함하지 않는다. sample/, tmp/는 Git 제외 경로다.

## 2026-09-09 현재 상태 — AI세특 직접 정적 통합

이 절은 아래의 과거 탐지 보정 기록보다 최신 상태다. 가림PDF의 AI세특 통합은 완료되어 `https://aisetuk.com/redact-pdf/`에서 원본 앱과 같은 런타임을 직접 제공한다. Vue 앱 셸 또는 iframe은 이 경로를 감싸지 않는다.

### 사용자에게 보이는 현재 결과

- `https://aisetuk.com/redact-pdf`는 Firebase Hosting의 정적 디렉터리 규칙으로 한 번만 `https://aisetuk.com/redact-pdf/`로 301 이동하고, 후자는 200으로 원본 가림PDF를 제공한다. 두 주소 사이의 리디렉션 루프는 해소됐다.
- 원본 가림PDF의 상단 앱바가 표시되고, PDF.js·OCR·MuPDF 워커와 정적 자산은 모두 `/redact-pdf/` 하위 경로에서 로드된다.
- AI세특 푸터의 도구 표기는 **`PDF 개인정보 삭제`**이며, 모든 정적 페이지와 Vue 앱 푸터가 `/redact-pdf/`를 직접 가리킨다.
- 실제 배포 후 `https://aisetuk.com/`의 푸터 문구, `https://aisetuk.com/redact-pdf/`의 앱바와 canonical을 HTTP 응답으로 확인했다.

### 원인과 해결의 핵심

- 이전 포함본은 별도 복사본이었고 `body > main > header { display: none !important; }`를 주입해 원본 앱바를 숨겼다. 또한 워커·자산 경로가 독립 사이트의 루트 기준이라 하위 경로에서 런타임 차이가 났다.
- 이 주입 CSS와 예전 `public/redact-pdf-runtime/` 복사본은 제거했다. AI세특에는 원본 프로젝트의 정적 릴리스만 동기화한다. `public/redact-pdf/` 파일을 AI세특에서 직접 수정하지 말 것.
- Firebase에서 물리적 `redact-pdf/` 디렉터리는 slash 없는 주소를 slash 있는 주소로 보정한다. `/redact-pdf/`를 다시 `/redact-pdf`로 보내던 수동 redirect가 두 주소의 301 루프 원인이었다. 그 redirect를 삭제했고, 대표 URL·canonical·Open Graph·sitemap을 모두 trailing slash 형식으로 통일했다.

### 원본 프로젝트 — `D:\AI_club\RedactPDF`

- 현재 코드 커밋: `e2b740f97531a0baf361a9a7b51e584717317985` (`Support subpath static releases`). GitHub `main`에는 푸시됐다.
- 핵심 구현:
  - `vite.config.ts`: `REDACT_PDF_BASE_PATH`와 `REDACT_PDF_CANONICAL_URL`로 Vite base, runtime 상수, 메타데이터를 설정한다.
  - `lib/deployment-path.ts`: 동일 origin의 base path 자산 URL을 조합한다.
  - `app/layout.tsx`: favicon, canonical, Open Graph URL을 배포 base/canonical에 맞춘다.
  - `lib/pdf-processing.ts`: PDF.js worker와 Tesseract worker/core 경로를 `deploymentAssetPath()`로 만든다.
  - `scripts/export-static.mjs`: 원본 앱을 빌드·로컬 렌더 후 앱바가 보이는지 확인하고 정적 산출물과 `release.json`을 만든다. `release.json`은 source commit, builtAt, basePath, canonicalUrl, 전체 파일 SHA-256을 담는다.
- 원본 검증: `npm run lint`, `npx tsc --noEmit`, `npm test -- --run` (49 passed, 2 skipped), production build를 통과했다.
- 알려진 로컬 주의: `export-static.mjs`가 띄운 Wrangler 프로세스가 비정상 종료 시 `dist/client`를 잠글 수 있다. `RedactPDF` 경로를 명시한 Wrangler child process만 종료한 뒤 다시 빌드한다. 다른 Node/Firebase 프로세스는 종료하지 않는다.

### AI세특 프로젝트 — `D:\st2`

- 현재 커밋: `f6d17091c5631004095fba3294bca3c29254bd75` (`Rename PDF privacy tool footer link`). GitHub `https://github.com/sukminpark/st2.git`의 `main`에 푸시됐고 Firebase Hosting `studentremark-helper`에도 배포됐다.
- 통합 커밋 흐름:
  - `72bf899` — 원본 가림PDF를 `/redact-pdf/` 직접 정적 런타임으로 포함.
  - `a716273` — Firebase redirect loop를 제거하고 trailing-slash canonical으로 정규화.
  - `75115bd` — 푸터 링크가 `/redact-pdf/`를 직접 가리키도록 수정.
  - `f6d1709` — 푸터 표시 문구를 `PDF 개인정보 삭제`로 변경.
- `scripts/sync-redact-pdf-runtime.mjs`만 원본 export script를 실행해 `public/redact-pdf/`를 만든다. base는 `/redact-pdf/`, canonical은 `https://aisetuk.com/redact-pdf/`다.
- `scripts/verify-redact-pdf-runtime.mjs`는 release metadata, 앱바 존재/숨김 CSS 부재, canonical, scoped asset URL, worker 참조·파일 존재, 전체 SHA-256을 확인한다. 루트 `npm run build`의 `prebuild`에서 항상 실행된다.
- `firebase.json`에는 `/redact-pdf` → `/redact-pdf/index.html` rewrite가 있다. `/redact-pdf/` → `/redact-pdf` redirect를 다시 추가하면 안 된다. `vue.config.js`의 dev rewrite도 직접 정적 index를 가리킨다.
- 최신 릴리스 metadata는 원본 커밋 `e2b740f97531` 기반, canonical `https://aisetuk.com/redact-pdf/`, runtime SHA-256 `7f7efce555300c20d47ced323af8ddb35ac066acb85c9c1e626a1b78a8b65286`이다.

### 배포 상태와 다음 세션의 남은 일

- AI세특 Firebase Hosting 배포는 완료됐다. 다음 변경 전 기본 검증은 `npm run build`, `node scripts/verify-redact-pdf-runtime.mjs`, 배포 후 두 URL의 HTTP status/Location 확인이다.
- 원본 가림PDF GitHub에는 `e2b740f`가 반영됐지만 Sites 원격 배포는 아직 보류다. 사용자는 일반적인 Sites 원격 푸시를 승인했으나 보안 실행기가 **정확한 외부 URL과 소스 전송 승인**을 다시 요구해 차단했다.
- Sites 배포를 재개하려면 사용자가 아래 문구를 정확히 승인해야 한다. 승인 전 우회·재시도하지 말 것.

```text
RedactPDF main의 소스 코드를 https://git.chatgpt-team.site/7e162a63-42f6-44e1-bb50-c7a48d0c7792/appgprj_6a97b4a1ce6c8191ab62cbbdffdb162a.git 에 푸시하여 Sites 배포하는 것을 승인합니다.
```

- 승인 후 `D:\AI_club\RedactPDF`에서 `git -c safe.directory=D:/AI_club/RedactPDF push origin main`을 실행하고, Sites의 자동 배포 결과를 확인한다. 이 원격에는 사용자 PDF·샘플·로그를 절대 포함하지 않는다.

### 다음 세션 시작 순서

1. 이 문서와 `D:\st2\docs\REDACT_PDF_HANDOFF.md`를 읽고 두 작업 트리의 `git status --short`를 먼저 확인한다.
2. 가림PDF 기능 변경이면 원본 저장소에서 수정·테스트·커밋하고, AI세특에서는 `npm run sync:redact-pdf`로만 포함본을 새로 만든다.
3. `D:\st2`에서 `npm run build`가 통과하고 release hash가 일치한 뒤에만 Firebase Hosting을 배포한다.
4. 독립 Sites 공개본도 갱신해야 하면 위의 정확한 원격 승인 여부를 확인한 후에만 push한다.
5. 아래에 남은 정부24 후보 범위 문제를 계속 조사할 때는 개인정보 원본을 Git·배포·외부 로그에 넣지 않는다.

## 서비스와 개인정보 원칙

가림PDF는 학교생활기록부·대입전형자료의 개인정보를 브라우저 안에서 탐지하고 원본 PDF 구조를 유지한 채 영구 삭제하는 Vinext/React/TypeScript 앱이다. 사용자 PDF, 비밀번호, 생성 결과는 서버·브라우저 저장소·Git·외부 OCR 서비스에 보내거나 남기지 않는다.

- 공개 서비스: https://garim-pdf.papermbl.chatgpt.site
- 로컬 저장소: `D:\AI_club\RedactPDF`
- 개인정보가 없는 단일 루트 커밋으로 공개 이력을 초기화한 뒤, 이후 수정 커밋만 추가했다. GitHub `main`에는 최신 인수인계 전용 커밋이 하나 더 있을 수 있으며, 공개 앱 코드의 Sites 소스 `main`은 버전 22 배포 커밋(`72c3abd`)이다.
- GitHub와 Sites의 공개 참조는 `main` 하나만 남겼다.
- Sites 공개 배포는 버전 22까지 완료됐다: `https://garim-pdf.papermbl.chatgpt.site`

## 이번 작업에서 구현한 내용

### 최근 탐지 보정

- 하단 `/<두 글자>` 보조 규칙에서 `교양` 등 교과군을 출력자 이름으로 해석하지 않도록 제한했다. 명시적인 `출력자` 라벨 탐지는 유지한다.
- `정정대장` 표는 성명·다음 항목 머리글의 글리프 경계로 성명 셀을 정하고, 같은 행의 `n반`·번호 셀을 탐지한다. 일반 활동표의 반·번호 규칙은 넓히지 않는다.
- 정부24 PDF처럼 논리 줄에 여러 표 행이 합쳐진 경우, 주소 후보는 같은 시각적 행의 텍스트만 묶는다. 다음 행의 학적사항·학교명은 주소 마스킹에 포함하지 않는다.
- 좌표 fixture로 교과군 오탐 방지, 정정대장의 반·번호·성명, 정부24 주소 행 경계를 고정했다. 전체 검증은 49개 통과·1개 로컬 샘플 생략이다.

### 정부24 학교명 과대 범위 - 로컬 수정 완료, 배포 대기 (2026-09-08)

- 사용자가 개인정보가 많은 전체 1쪽 대신 제공한 2~3쪽 발췌본의 첫 페이지에서 문제를 재현했다. 파일과 모든 결과·렌더·진단 로그는 Git 제외 `sample/`·`tmp/`에만 보관했다.
- 개인정보 없는 진단 결과, 과대 후보는 주소·성명·수동 영역이 아니라 `학교명 또는 출신학교명` 사유의 `school-name` exact 후보 3개였다. 각 후보는 8글자/8 glyph로 정확히 선택됐지만 한 글리프의 canonical Quad만 다른 행으로 튀었다.
- `pushWordSliceCandidate()`의 fallback이나 반복 텍스트 출현 순서가 아니라 `canonicalGlyphQuad()`의 비직교 축 투영이 원인이었다. MuPDF 높이 축의 작은 기울기를 직교축처럼 재구성하면서 절대 페이지 좌표가 오차를 증폭했다.
- 진행 방향에 직교하고 원래 높이 방향의 부호를 유지하는 법선으로 투영 축을 정규화했다. 주소·이름·수동 후보 규칙은 변경하지 않았다.
- 제공본 재검증에서 학교명 review rect 높이는 150.636/151.345/74.999px에서 모두 42.389px로, canonical Quad 경계 높이는 48.469/48.724/21.240pt에서 모두 9.5pt로 정상화됐다.
- 원본·결과 첫 페이지 200dpi 픽셀 비교에서 변경 픽셀 6,907개가 모두 후보 검토 사각형 안에 있었고 바깥 변경은 0개였다. 결과는 3쪽/A4/회전 0/무암호를 유지했다.
- `npm test -- --run` 49개 통과·2개 로컬 샘플 생략, `npx tsc --noEmit`, `npm run lint`, `npm run build` 통과. 공개 Sites 배포는 사용자 승인 전까지 보류한다.

### 정부24 마스킹 과대 범위 - 분석 전 상태 (2026-09-08)

- 제공된 정부24 비식별화 결과와 화면 캡처에서 표의 개인정보 후보가 여전히 과도하게 넓게 잡힌다는 사용자 피드백을 받았다. `72c3abd`의 주소 행 제한은 효과가 없었으며, 공개본 버전 22에도 같은 문제가 남는다. 해결됐다고 간주하지 않는다.
- 제공 파일은 이미 비식별화된 결과라 원래의 텍스트·글리프·자동 후보를 재구성할 수 없었다. 결과 첫 페이지의 재분석에서는 photo 추정 후보만 남아, 과대 사각형의 생성 규칙을 확정할 수 없었다.
- 다음 작업은 반드시 원본 정부24 학교생활기록부로 재현한다. 원본은 Git 제외 `sample/government24-original.pdf`에만 복사하고, 결과·렌더 PNG·디버그 로그도 Git과 외부 서비스에 올리지 않는다.
- 원본 1쪽의 분석 직후 후보별 `kind`, `reason`, review rect, target glyph 수, canonical Quad 경계만 로컬에서 기록한다. 원문·성명·주소는 로그에 출력하지 않는다. 후보 사각형을 렌더 이미지와 겹쳐 어느 규칙(주소, 학교명, 성명, 수동 영역)에서 넓어지는지 먼저 확정한다.
- 특히 `alignNativeLayout()`의 반복 텍스트 일대일 매칭, `pushWordSliceCandidate()`의 glyph-slice 실패 fallback, 주소 이어진 줄 규칙을 원본 좌표로 검증한다. 추측성 범용 규칙을 더 추가하지 말고, 문제가 확인된 한 경로만 고친다.
- 수정 후에는 원본·결과 1쪽을 렌더 비교해 각 마스킹 영역이 선택 문자열의 글리프 경계 안에 있는지, 표 선과 인접 학적사항이 보존되는지 확인한다. 기존 49개 테스트, 타입 검사, 린트, 빌드를 모두 다시 통과시킨 뒤에만 배포한다.

### canonical PDF Quad와 좌표 변환

- `lib/pdf-geometry.ts`에 PDF↔캔버스 affine 행렬, 역행렬, Quad 변환·경계·왕복 유틸을 추가했다.
- 글리프는 MuPDF 원본 `sourceQuad`, 화면 표시와 삭제에 공통으로 쓰는 `canonicalQuad`, 캔버스 `bbox`를 분리한다.
- canonical Quad는 MuPDF 글리프의 실제 진행 방향·좌우 경계를 유지하고 PDF.js의 안정적인 표시 높이·기준선을 결합한다.
- 페이지 상태에 `pdfToCanvas`, `canvasToPdf`, 회전, CropBox를 저장한다. 화면용 후보 여백은 삭제 Quad에 합치지 않는다.
- 화면 마킹, MuPDF 삭제, 저장 후 잔존 글리프 검증이 같은 canonical Quad를 사용한다.
- 반복 문구는 페이지의 시각적 줄·출현 순서로 일대일 정렬한다. 선택 문자열의 첫 글자부터 마지막 글자까지 글리프 수와 문자가 맞을 때만 exact 후보를 만든다.

### 삭제와 결과 검증

- 자동 후보는 원본 글리프 ID와 canonical Quad를 보존한다. 사용자가 이동·크기 조정한 후보와 수동 후보만 `region` 방식으로 바뀐다.
- exact 삭제가 실패하면 화면 여백이 아니라 선택된 글리프의 실제 경계만 다시 묶어 구조 보존 redaction을 재시도한다.
- 저장 후 원본 대비 페이지 수·크기와 선택 위치의 예상 문자를 검사한다. 같은 페이지의 잔존 오류는 한 번만 표시하고 다운로드를 중단한다.
- 회전/CropBox, 인접 텍스트, 동일 문구의 다른 출현 위치, 표 선·이미지 보존 테스트를 유지·보강했다.

### 반·번호 오탐 제한

- 같은 행의 하단 `반 / 번호` 필드는 각 라벨 바로 오른쪽 값만 탐지하며 아래쪽 세로 검색을 실행하지 않는다.
- 세로 검색은 `학년·학과·반·번호·담임성명` 중 3개 이상이 같은 표 머리글 행에 있을 때만, 추정 셀 안의 첫 데이터 행으로 제한한다.
- `자율활동·시수·누계시간·활동내용` 주변 숫자는 학급·번호 후보에서 제외한다.
- `숫자+반` 인라인 탐지는 같은 행에 성명·학급·번호·담임성명 등 별도 신원 라벨이 있을 때만 허용한다.

### 암호 PDF

- Worker의 `extract`·`redact` 요청에 선택적 `password`를 추가했다.
- MuPDF는 페이지 수·내용·메타데이터를 읽기 전에 `needsPassword()`와 `authenticatePassword()`로 인증한다. PDF.js에도 같은 비밀번호를 전달한다.
- 오류 코드는 `password-required`, `incorrect-password`, `unsupported-encryption`으로 구분하며 UI는 문자열 분석 없이 코드로 처리한다.
- 비밀번호 대화상자에서 오답이면 입력값만 비우고 재시도한다. 취소·초기화·새 문서·성공 다운로드·화면 종료 시 비밀번호와 보류 파일 참조를 폐기한다.
- 출력은 MuPDF `encrypt=none`으로 저장해 암호를 제거한다. 비밀번호를 로그·오류 문구·저장소에 기록하지 않는다.

### 브라우저 검증 중 발견한 추가 회귀

짧은 디지털 PDF는 네이티브 텍스트가 있어도 기존의 “8단어·30자 미만” 조건 때문에 OCR 전용 페이지로 교체됐다. 이때 주민번호 후보가 OCR 글리프로 생성돼 PDF 텍스트 객체와 연결되지 않았고, 저장 후 안전 검증이 `1쪽에서 삭제 대상 텍스트가 다시 추출됩니다.`로 다운로드를 막았다.

수정 후에는 네이티브 글리프가 있으면 이를 버리지 않는다. 큰 래스터 이미지가 있는 혼합 페이지에서만 OCR도 실행하고, 네이티브 단어와 50% 이상 겹치는 OCR 단어는 제거한 뒤 나머지를 병합한다. 브라우저에서 같은 암호 PDF를 다시 열었을 때 주민번호가 네이티브 신뢰도 100% 후보로 잡혔고 저장 안전 검증과 성공 상태까지 통과했다.

## 자동 검증 결과

2026-09-07 로컬 결과:

- `npm test -- --run`: 3개 파일, 43개 통과, 1개 생략
- `npx tsc --noEmit`: 통과
- `npm run lint`: 통과
- `npm run build`: 통과

주요 자동 회귀:

- affine 왕복, 혼합 폭 글리프의 MuPDF 폭/PDF.js 높이 결합
- 반복 학교명 일대일 정렬과 첫·마지막 글자 포함
- 회전/CropBox 보존과 canonical Quad 삭제
- 하단 `반 3 / 번호 12`, 정상 표 머리글, 활동 시수·누계시간·문장 속 `3반`
- AES-256 합성 PDF의 미입력·오답·정답, 삭제 후 무암호 재열기
- 암호 PDF를 PDF.js 표시 좌표로 정렬한 뒤 주민번호 삭제
- 짧은 디지털 PDF의 네이티브 글리프 유지와 혼합 OCR 중복 제거
- 선택 문자 부재, 인접 문자·동일 문구의 다른 위치 유지, 표 선·이미지 보존
- 로컬 `비식별화 테스트.pdf` 17쪽 회귀: 4쪽 자율활동 시수 `42` 무탐지, 5쪽 `안산강서고등학교` 및 `안산` 잔존 없음
- 로컬 대입전형자료 사진 회귀: 소수점 이미지 경계의 마지막 래스터 행까지 삭제하고, 사진 후보의 위쪽 기준은 원본 이미지 경계에 유지

브라우저 로컬 QA:

- 비밀번호 요구 대화상자 표시
- 오답 후 입력란 비우기와 재시도 안내
- 정답 인증 후 주민번호 자동 탐지
- 페이지 검토 후 저장 안전 검증 통과와 “새 PDF를 저장했습니다” 상태 확인

브라우저 자동화 도구는 앱의 프로그램식 Blob 다운로드를 대상 경로로 회수할 때 `Download was canceled`를 반환했다. 앱 내부 저장·검증은 성공했고, 출력 무암호/선택 텍스트 부재는 동일 Worker 경로의 자동 테스트로 확인했다. 공개본 QA 때 실제 다운로드 파일을 다시 직접 열어 확인해야 한다.

## 실물 샘플 회귀 결과

`D:\Downloads\비식별화 테스트.pdf`를 Git 제외된 `sample/비식별화 테스트.pdf`로 복사해 실행했다. 샘플과 결과는 저장소·배포에 포함하지 않는다.

- 원본·결과 모두 17쪽, A4, 회전 0을 유지했다.
- 결과는 무암호로 열렸다.
- 4쪽 렌더 PNG의 SHA-256이 원본과 결과에서 동일해, 해당 페이지가 픽셀 단위로 보존됐다.
- 4쪽 자율활동 시수 `42`는 학급·번호 후보가 아니었다.
- 5쪽의 선택한 학교명은 결과 텍스트에서 `안산강서고등학교`와 첫 문자열 `안산` 모두 남지 않았다.

이 결과로 샘플 부재 차단은 해소됐다. 최종 소스는 GitHub와 Sites에 동일 SHA로 반영됐고 공개 배포도 완료됐다.

## 사진 하단 잔상 수정

제공된 대입전형자료 원본과 기존 비식별화 결과를 비교했다. MuPDF가 소수점 이미지 하단 경계를 열린 범위로 처리해 마지막 래스터 행이 남았다. 사진 후보에만 아래쪽 2개 렌더 캔버스 픽셀을 실제 삭제 범위와 같은 후보 영역으로 추가했다. 위쪽 좌표는 원본 이미지 경계와 같게 유지해 마스킹 표시가 위로 이동하지 않는다.

Git 제외 `sample/college-photo-regression.pdf` 회귀에서 원본 사진의 마지막 행이 존재하는 것을 확인하고, 보정 결과가 그 행을 완전히 지우는지 자동 검사한다.

## 현재 작업 트리

현재 작업 트리는 깨끗해야 한다. 시작 시 `git status --short`와 `git rev-list --count --all`로 단일 이력 상태를 확인한다.

로컬 브라우저 QA 파일은 `tmp/browser-qa/`에 있으며 Git 제외 대상이다. 사용자 실물 PDF와 결과물을 외부 서비스 또는 저장소에 올리지 않는다.

## 다음 세션 시작 프롬프트

```text
가림PDF 프로젝트(D:\AI_club\RedactPDF)를 이어서 작업해 주세요. 먼저 HANDOFF.md의 2026-09-10 현재 기준 절과 git status --short를 확인하고, 기존 작업 트리와 사용자가 만든 변경을 보존하세요. 현재 공개본은 Sites 버전 25이며, Sites 원격 origin의 기준 커밋은 d027967입니다. 사용자가 요청하는 다음 수정 범위만 구현하고, 원본 PDF·결과물·개인정보를 Git, Sites 배포물, 외부 로그에 절대 포함하지 마세요. 수정 뒤 관련 테스트와 npm run build를 실행하세요. 커밋·푸시·공개 Sites 배포는 사용자가 명시적으로 요청할 때만 진행하며, 공개 배포 전에는 저장된 새 버전을 실제 공개 URL에 반영할지 확인받으세요. 정부24 후보 범위 이슈를 다시 다룰 경우에는 아래 과거 기록의 개인정보 보호·원본 재현 절차를 따르되, 사용자 요청 없이 해당 조사를 시작하지 마세요.
```
