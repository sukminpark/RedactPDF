# 가림PDF

학교생활기록부와 대입전형자료의 개인정보를 브라우저 안에서 찾아 원본 PDF 콘텐츠에서 영구 삭제하는 웹 앱입니다.

- PDF.js로 원본을 미리 봅니다.
- MuPDF.js Worker가 네이티브 글자별 Quad를 추출하고 실제 PDF redaction을 적용합니다.
- 네이티브 텍스트가 부족한 페이지만 로컬 Tesseract OCR을 사용합니다.
- 파일과 탐지 결과는 서버나 브라우저 저장소에 보관하지 않습니다.
- 결과는 회색 가림막이 아니라 선택한 글자가 빠진 빈자리입니다.

## 개발

```bash
npm install
npm test
npx tsc --noEmit
npm run lint
npm run build
```

## 라이선스와 소스

이 저장소 전체는 [AGPL-3.0-or-later](./LICENSE)로 공개됩니다. MuPDF.js를 포함한 외부 구성 요소는 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)를 참고하세요.

공개 서비스: https://garim-pdf.papermbl.chatgpt.site
